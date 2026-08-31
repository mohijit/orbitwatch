import { z } from "zod";

/**
 * Typed message protocol between native React Native UI and the Cesium globe running
 * inside a WebView.
 *
 * WHY A WEBVIEW AT ALL
 * See docs/adr/0003-mobile-renderer.md. In short: CesiumJS is a browser library with
 * no native React Native binding, and the native map libraries render a flat surface
 * with no way to place an object 400 km above it without flattening its altitude —
 * which the product explicitly forbids.
 *
 * WHY A STRICT PROTOCOL
 * A WebView bridge is a string channel between two independently-deployed programs.
 * Without a schema, a rename on either side fails silently at runtime on a user's
 * phone, where it is close to undebuggable. Every message is therefore validated on
 * receipt, and unknown messages are reported rather than ignored.
 *
 * BRIDGE COST IS THE BINDING CONSTRAINT
 * Messages cross as serialised JSON strings. Sending 20,000 positions as objects is
 * several megabytes per update and will not sustain a smooth frame rate. Positions
 * are therefore sent as a base64-encoded Float32Array in a SINGLE message
 * (`satellite-positions`), not as one message per satellite.
 */

// --- Native -> WebView ------------------------------------------------------

/**
 * Bulk satellite positions.
 *
 * `positions` is a base64-encoded Float32Array laid out as repeating
 * [longitude, latitude, altitudeKm] triples, aligned index-for-index with
 * `catalogIds`. Float32 is deliberate: it gives ~7 significant digits, which is about
 * a centimetre of longitude — far below any rendering or orbital-accuracy threshold,
 * and half the bridge payload of Float64.
 */
export const satellitePositionsMessageSchema = z.object({
  type: z.literal("satellite-positions"),
  /** Position time, epoch milliseconds UTC. Not necessarily "now". */
  timeMs: z.number(),
  catalogIds: z.array(z.string()),
  positions: z.string(),
  /** Objects whose propagation failed this tick, so the globe can grey them out. */
  failedCatalogIds: z.array(z.string()).optional(),
});

export const selectSatelliteMessageSchema = z.object({
  type: z.literal("select-satellite"),
  catalogId: z.string().nullable(),
  /** Whether to fly the camera. Ignored when the user has reduced motion enabled. */
  flyTo: z.boolean().default(false),
});

export const setLayersMessageSchema = z.object({
  type: z.literal("set-layers"),
  orbit: z.boolean().optional(),
  groundTrack: z.boolean().optional(),
  footprint: z.boolean().optional(),
  labels: z.boolean().optional(),
  terminator: z.boolean().optional(),
});

export const setQualityMessageSchema = z.object({
  type: z.literal("set-quality"),
  /** Mirrors the app-wide quality modes; the scene reduces effects accordingly. */
  mode: z.enum(["auto", "high", "balanced", "battery-saver"]),
});

export const setCameraMessageSchema = z.object({
  type: z.literal("set-camera"),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Camera height above the ellipsoid, metres. */
  heightMeters: z.number().positive(),
  flyDurationSeconds: z.number().min(0).default(0),
});

/** Sent when the app backgrounds, so the scene stops consuming battery. */
export const setRenderingMessageSchema = z.object({
  type: z.literal("set-rendering"),
  enabled: z.boolean(),
});

export const nativeToGlobeMessageSchema = z.discriminatedUnion("type", [
  satellitePositionsMessageSchema,
  selectSatelliteMessageSchema,
  setLayersMessageSchema,
  setQualityMessageSchema,
  setCameraMessageSchema,
  setRenderingMessageSchema,
]);

export type NativeToGlobeMessage = z.infer<typeof nativeToGlobeMessageSchema>;

// --- WebView -> Native ------------------------------------------------------

export const globeReadyMessageSchema = z.object({
  type: z.literal("globe-ready"),
  cesiumVersion: z.string(),
  /** False when the device could not provide a WebGL context. */
  webglAvailable: z.boolean(),
});

export const satelliteTappedMessageSchema = z.object({
  type: z.literal("satellite-tapped"),
  catalogId: z.string(),
});

export const cameraChangedMessageSchema = z.object({
  type: z.literal("camera-changed"),
  latitude: z.number(),
  longitude: z.number(),
  heightMeters: z.number(),
});

/**
 * Frame statistics, used by the automatic quality mode.
 *
 * Reported by the scene rather than measured natively, because only the scene knows
 * its own frame timing. Sent at most once a second to keep bridge traffic negligible.
 */
export const globeStatsMessageSchema = z.object({
  type: z.literal("globe-stats"),
  fps: z.number(),
  renderedObjectCount: z.number().int().nonnegative(),
  /** Main-thread milliseconds spent applying the last position batch. */
  lastUpdateMs: z.number(),
});

/**
 * Renderer failure.
 *
 * A WebGL context can be lost when the OS reclaims GPU memory, which is common on
 * mobile. Native must be told so it can show a recoverable error and offer a reload
 * rather than leaving the user on a frozen globe.
 */
export const globeErrorMessageSchema = z.object({
  type: z.literal("globe-error"),
  code: z.enum(["webgl-unavailable", "context-lost", "scene-error", "bad-message"]),
  message: z.string(),
});

export const globeToNativeMessageSchema = z.discriminatedUnion("type", [
  globeReadyMessageSchema,
  satelliteTappedMessageSchema,
  cameraChangedMessageSchema,
  globeStatsMessageSchema,
  globeErrorMessageSchema,
]);

export type GlobeToNativeMessage = z.infer<typeof globeToNativeMessageSchema>;

// --- Encoding helpers -------------------------------------------------------

/** Values per satellite in the packed position buffer: lon, lat, altitude km. */
export const POSITION_STRIDE = 3;

/**
 * Pack positions into a base64 Float32Array for the bridge.
 *
 * Exported and tested because a mismatch between packing and unpacking would show up
 * as satellites scattered at meaningless coordinates — a failure that is obvious on
 * screen but very hard to trace back to an encoding bug.
 */
export function packPositions(
  positions: readonly { longitude: number; latitude: number; altitudeKm: number }[],
): string {
  const buffer = new Float32Array(positions.length * POSITION_STRIDE);
  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index];
    if (position === undefined) continue;
    const offset = index * POSITION_STRIDE;
    buffer[offset] = position.longitude;
    buffer[offset + 1] = position.latitude;
    buffer[offset + 2] = position.altitudeKm;
  }
  return encodeBase64(new Uint8Array(buffer.buffer));
}

export function unpackPositions(
  encoded: string,
): { longitude: number; latitude: number; altitudeKm: number }[] {
  const bytes = decodeBase64(encoded);
  // A Float32Array view requires 4-byte alignment; copying guarantees it regardless
  // of how the base64 decoder allocated the underlying buffer.
  const aligned = new Uint8Array(bytes.byteLength);
  aligned.set(bytes);
  const floats = new Float32Array(aligned.buffer);

  const count = Math.floor(floats.length / POSITION_STRIDE);
  const positions: { longitude: number; latitude: number; altitudeKm: number }[] =
    new Array(count);

  for (let index = 0; index < count; index += 1) {
    const offset = index * POSITION_STRIDE;
    positions[index] = {
      longitude: floats[offset] as number,
      latitude: floats[offset + 1] as number,
      altitudeKm: floats[offset + 2] as number,
    };
  }
  return positions;
}

/** Bytes on the bridge for a position batch of `count` satellites, before base64. */
export function positionPayloadBytes(count: number): number {
  return count * POSITION_STRIDE * Float32Array.BYTES_PER_ELEMENT;
}

/**
 * Parse an inbound message, returning a typed result rather than throwing.
 *
 * Both sides of a WebView bridge must tolerate garbage: an old app build can talk to
 * a new scene, and vice versa. Throwing inside a message handler on the WebView side
 * tears down the scene.
 */
export function parseNativeToGlobe(
  raw: unknown,
): { ok: true; message: NativeToGlobeMessage } | { ok: false; error: string } {
  const parsed = nativeToGlobeMessageSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, message: parsed.data }
    : { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
}

export function parseGlobeToNative(
  raw: unknown,
): { ok: true; message: GlobeToNativeMessage } | { ok: false; error: string } {
  const parsed = globeToNativeMessageSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, message: parsed.data }
    : { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
}

// Base64 helpers that work in Node, browsers and React Native without a polyfill.
// `Buffer` exists in Node and RN but not the browser; `btoa`/`atob` the reverse.
function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(encoded: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(encoded, "base64"));
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
