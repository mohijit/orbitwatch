import { describe, expect, it } from "vitest";

import {
  POSITION_STRIDE,
  packPositions,
  parseGlobeToNative,
  parseNativeToGlobe,
  positionPayloadBytes,
  unpackPositions,
} from "./globe-bridge.js";

describe("position packing", () => {
  const sample = [
    { longitude: 151.2093, latitude: -33.8688, altitudeKm: 408.21 },
    { longitude: -74.006, latitude: 40.7128, altitudeKm: 420.5 },
    { longitude: 0, latitude: 0, altitudeKm: 35786 },
    { longitude: 180, latitude: -90, altitudeKm: 0 },
  ];

  it("round-trips positions within Float32 precision", () => {
    const unpacked = unpackPositions(packPositions(sample));
    expect(unpacked).toHaveLength(sample.length);

    for (const [index, original] of sample.entries()) {
      const result = unpacked[index];
      expect(result).toBeDefined();
      // Float32 gives ~7 significant digits: about a centimetre of longitude, and
      // well under a metre of altitude at geostationary distance.
      expect(result?.longitude).toBeCloseTo(original.longitude, 3);
      expect(result?.latitude).toBeCloseTo(original.latitude, 3);
      expect(result?.altitudeKm).toBeCloseTo(original.altitudeKm, 1);
    }
  });

  it("handles an empty batch", () => {
    expect(unpackPositions(packPositions([]))).toHaveLength(0);
  });

  it("keeps the bridge payload small enough to sustain updates", () => {
    // The number that decides whether a WebView bridge is viable at all. At 12 bytes
    // per satellite, a full 20k catalog is ~240 KB raw and ~320 KB base64 — sendable
    // at ~1 Hz. Sending objects instead would be several megabytes.
    expect(positionPayloadBytes(1)).toBe(POSITION_STRIDE * 4);
    expect(positionPayloadBytes(20_000)).toBe(240_000);

    const large = Array.from({ length: 20_000 }, (_, i) => ({
      longitude: (i % 360) - 180,
      latitude: (i % 180) - 90,
      altitudeKm: 400 + (i % 500),
    }));
    const encoded = packPositions(large);
    // base64 inflates by 4/3.
    expect(encoded.length).toBeLessThan(340_000);

    // For comparison, the naive JSON-of-objects encoding.
    const naiveBytes = JSON.stringify(large).length;
    expect(naiveBytes).toBeGreaterThan(encoded.length * 3);
  });

  it("preserves index alignment with catalog ids", () => {
    // Positions are matched to ids by index, so a stride error would silently put
    // every satellite at its neighbour's position.
    const unpacked = unpackPositions(packPositions(sample));
    expect(unpacked[2]?.altitudeKm).toBeCloseTo(35786, 0);
    expect(unpacked[3]?.latitude).toBeCloseTo(-90, 3);
  });
});

describe("native -> globe messages", () => {
  it("accepts a valid position batch", () => {
    const result = parseNativeToGlobe({
      type: "satellite-positions",
      timeMs: Date.now(),
      catalogIds: ["25544", "20580"],
      positions: packPositions([
        { longitude: 1, latitude: 2, altitudeKm: 400 },
        { longitude: 3, latitude: 4, altitudeKm: 500 },
      ]),
    });
    expect(result.ok).toBe(true);
  });

  it("applies documented defaults", () => {
    const result = parseNativeToGlobe({ type: "select-satellite", catalogId: "25544" });
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "select-satellite") {
      expect(result.message.flyTo).toBe(false);
    }
  });

  it("accepts a null selection to clear", () => {
    const result = parseNativeToGlobe({ type: "select-satellite", catalogId: null });
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown message type rather than ignoring it", () => {
    // Silent ignores are how bridges rot: a renamed message keeps "working" until
    // someone notices a feature stopped doing anything.
    const result = parseNativeToGlobe({ type: "definitely-not-a-message" });
    expect(result.ok).toBe(false);
  });

  it("rejects out-of-range camera coordinates", () => {
    expect(
      parseNativeToGlobe({
        type: "set-camera",
        latitude: 120,
        longitude: 0,
        heightMeters: 1000,
      }).ok,
    ).toBe(false);
  });

  it("rejects a non-positive camera height", () => {
    expect(
      parseNativeToGlobe({
        type: "set-camera",
        latitude: 0,
        longitude: 0,
        heightMeters: 0,
      }).ok,
    ).toBe(false);
  });

  it("rejects a malformed payload without throwing", () => {
    expect(parseNativeToGlobe(null).ok).toBe(false);
    expect(parseNativeToGlobe("garbage").ok).toBe(false);
    expect(parseNativeToGlobe(undefined).ok).toBe(false);
  });
});

describe("globe -> native messages", () => {
  it("accepts the ready handshake", () => {
    const result = parseGlobeToNative({
      type: "globe-ready",
      cesiumVersion: "1.144.0",
      webglAvailable: true,
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a context-lost error", () => {
    // Mobile GPUs reclaim contexts under memory pressure; native must be able to
    // recover rather than leaving the user on a frozen globe.
    const result = parseGlobeToNative({
      type: "globe-error",
      code: "context-lost",
      message: "WebGL context lost",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown error code", () => {
    expect(
      parseGlobeToNative({ type: "globe-error", code: "made-up", message: "x" }).ok,
    ).toBe(false);
  });

  it("accepts frame statistics for the auto quality mode", () => {
    const result = parseGlobeToNative({
      type: "globe-stats",
      fps: 58.3,
      renderedObjectCount: 12_400,
      lastUpdateMs: 4.2,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a negative rendered object count", () => {
    expect(
      parseGlobeToNative({
        type: "globe-stats",
        fps: 60,
        renderedObjectCount: -1,
        lastUpdateMs: 1,
      }).ok,
    ).toBe(false);
  });
});
