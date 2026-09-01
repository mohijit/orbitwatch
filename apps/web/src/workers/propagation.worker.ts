/// <reference lib="webworker" />

import { catalogElementsResponseSchema } from "@orbitwatch/contracts";
import {
  ElementParseError,
  degrees,
  kilometers,
  nextDarkness,
  parseOmm,
  predictPasses,
  propagateManyAt,
  type CatalogId,
  type OMMJsonObject,
  type SatRec,
} from "@orbitwatch/orbit-core";

import type {
  PassEndpoint,
  VisiblePass,
  VisibleTonightRequest,
  VisibleTonightResult,
} from "./pass-messages";

/**
 * Whole-catalog SGP4 propagation, off the main thread.
 *
 * This is the ADR-0002 architecture: the selected satellite propagates at high
 * frequency on the main thread (see `use-selected-position.ts`), and the full catalog
 * propagates here at ~1 Hz. Positions cross back as a transferable `Float32Array`,
 * never as objects — 16,000+ plain JS objects per tick would be a GC pause on every
 * frame; a transferred buffer is a pointer handoff.
 *
 * PROTOCOL
 *   IN  { type: "init", url: string }
 *       The worker fetches, decodes, schema-validates and parses the catalog ITSELF,
 *       rather than being handed elements. At 16,468 objects that response is 10.9 MB,
 *       and decoding it, running the shared Zod schema over it and building satrecs
 *       from it measured ~1.4 s — landing on the main thread exactly while Cesium is
 *       initialising. None of it needs the DOM, and doing it here also avoids
 *       structured-cloning 16,468 objects across the worker boundary.
 *
 *       Validation is NOT skipped by moving it: the same
 *       `catalogElementsResponseSchema` from `@orbitwatch/contracts` runs here, so a
 *       field the server renames still fails at the boundary rather than deep inside
 *       a propagation loop.
 *
 *       A record that fails to parse is dropped (not fatal to the rest), and the
 *       worker reports how many, since a silent drop of thousands of objects should
 *       never be invisible to the caller.
 *   IN  { type: "tick", time: number }
 *       Epoch milliseconds to propagate to. Sent by the main thread's render loop or
 *       by the timeline when scrubbing.
 *   OUT { type: "ready", count, failed }
 *   OUT { type: "error", message }
 *       The catalog could not be fetched, or did not match the shared schema. Fatal
 *       to this worker: there is nothing to propagate.
 *   OUT { type: "positions", buffer, time }
 *       buffer is Float32Array [x, y, z, vx, vy, vz, ok, ...] per object, in the SAME
 *       ORDER as `catalogIds` from the "ready" message — index-aligned, not keyed,
 *       because a lookup per object per tick is exactly the per-frame cost this
 *       design exists to avoid.
 *   OUT { type: "catalogIds", ids: string[] }
 *       Sent once after init. Separate from "ready" so it is not re-serialised on
 *       every tick.
 */

/**
 * Floats per object: Earth-fixed position (km), Earth-fixed velocity (km/s), ok flag.
 *
 * Velocity is carried so the main thread can advance positions between ticks. The whole
 * catalogue cannot be propagated every animation frame, but a satellite's motion over
 * one tick is very nearly a straight line — under 20 m of error across a second for the
 * ISS — so dead reckoning renders smoothly without pretending to be a new propagation.
 */
export const POSITION_FIELDS = 7; // x, y, z, vx, vy, vz, ok
const OK = 1;
const NOT_OK = 0;

interface InitMessage {
  readonly type: "init";
  readonly url: string;
}

interface TickMessage {
  readonly type: "tick";
  readonly time: number;
}

type InboundMessage = InitMessage | TickMessage | VisibleTonightRequest;

let satrecs: SatRec[] = [];
let catalogIds: CatalogId[] = [];
let names: string[] = [];
/** catalogId -> index, so a pass request does not scan the catalog per object. */
let indexById = new Map<string, number>();

async function handleInit(message: InitMessage): Promise<void> {
  let elements: readonly { readonly catalogId: string; readonly omm: unknown }[];

  try {
    const response = await fetch(message.url, { cache: "no-store" });
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(
        body?.error?.message ?? `Catalog request failed with status ${response.status}`,
      );
    }
    const catalog = catalogElementsResponseSchema.parse(await response.json());
    elements = catalog.elements;
  } catch (error) {
    postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const parsedSatrecs: SatRec[] = [];
  const parsedIds: CatalogId[] = [];
  const parsedNames: string[] = [];
  let failed = 0;

  for (const record of elements) {
    try {
      const { satrec } = parseOmm(record.omm as OMMJsonObject);
      parsedSatrecs.push(satrec);
      parsedIds.push(satrec.satnum as CatalogId);
      // Kept for the pass list, which names objects rather than numbering them. The
      // OMM carries it, so there is no second lookup to make.
      const omm = record.omm as { OBJECT_NAME?: unknown };
      parsedNames.push(
        typeof omm.OBJECT_NAME === "string" ? omm.OBJECT_NAME : String(satrec.satnum),
      );
    } catch (error) {
      failed += 1;
      if (!(error instanceof ElementParseError)) {
        // An ElementParseError is an expected, per-record outcome (bad elements,
        // eccentricity out of range). Anything else is a bug worth surfacing.
        console.error("Unexpected error parsing OMM in propagation worker", error);
      }
    }
  }

  satrecs = parsedSatrecs;
  catalogIds = parsedIds;
  names = parsedNames;
  indexById = new Map(parsedIds.map((catalogId, index) => [catalogId, index]));

  postMessage({ type: "catalogIds", ids: catalogIds });
  postMessage({ type: "ready", count: satrecs.length, failed });
}

function handleTick(message: TickMessage): void {
  const time = new Date(message.time);
  const results = propagateManyAt(satrecs, time);

  const buffer = new Float32Array(results.length * POSITION_FIELDS);
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result === undefined) continue;
    const offset = index * POSITION_FIELDS;
    buffer[offset] = result.x;
    buffer[offset + 1] = result.y;
    buffer[offset + 2] = result.z;
    buffer[offset + 3] = result.vx;
    buffer[offset + 4] = result.vy;
    buffer[offset + 5] = result.vz;
    buffer[offset + 6] = result.ok ? OK : NOT_OK;
  }

  // Transferred, not copied or structured-cloned: ownership of the underlying
  // ArrayBuffer moves to the main thread in O(1), which is what keeps a 16,000-object
  // tick from costing a serialisation pass on top of the propagation itself.
  postMessage({ type: "positions", buffer, time: message.time }, { transfer: [buffer.buffer] });
}

/**
 * Pass search over a curated subset, for "Visible Tonight".
 *
 * Runs here rather than on the main thread because it is seconds of straight-line
 * SGP4, and the globe is animating throughout. It reuses the satrecs already parsed
 * for the globe, so no elements are fetched twice.
 *
 * The subset matters more than the speed. Searching the whole catalog is affordable
 * with a coarse pre-scan, but it produces thousands of "optically favourable" passes
 * a night — every sunlit object above the horizon — because GP elements carry nothing
 * about brightness. The caller passes CelesTrak's `visual` membership instead, which
 * is the only published statement about which objects can actually be seen.
 */
function toEndpoint(point: {
  time: Date;
  azimuth: number;
  compass: string;
  elevation: number;
  range: number;
}): PassEndpoint {
  return {
    time: point.time,
    azimuth: point.azimuth,
    compass: point.compass,
    elevation: point.elevation,
    range: point.range,
  };
}

function handleVisibleTonight(message: VisibleTonightRequest): void {
  const observer = {
    latitude: degrees(message.observer.latitude),
    longitude: degrees(message.observer.longitude),
    altitude: kilometers(message.observer.altitude),
  };

  const darkness = nextDarkness(observer, new Date(message.from));
  if (darkness === undefined) {
    // No darkness in the search horizon. A real answer about the sky, not a failure.
    const result: VisibleTonightResult = { type: "visibleTonight", status: "no-darkness" };
    postMessage(result);
    return;
  }

  const found: VisiblePass[] = [];
  let searched = 0;

  for (const catalogId of message.catalogIds) {
    const index = indexById.get(catalogId);
    // A group member with no element set in this catalog response is skipped rather
    // than faked. `searched` reports how many were genuinely covered.
    if (index === undefined) continue;
    const satrec = satrecs[index];
    if (satrec === undefined) continue;
    searched += 1;

    for (const pass of predictPasses(satrec, observer, darkness.start, darkness.end)) {
      found.push({
        catalogId,
        name: names[index] ?? catalogId,
        aos: toEndpoint(pass.aos),
        maximum: toEndpoint(pass.maximum),
        los: toEndpoint(pass.los),
        durationSeconds: pass.durationSeconds,
        minimumRange: pass.minimumRange,
        visibility: pass.visibility,
        illumination: pass.illumination,
      });
    }
  }

  found.sort((a, b) => a.aos.time.getTime() - b.aos.time.getTime());

  const result: VisibleTonightResult = {
    type: "visibleTonight",
    status: "ok",
    darkStart: darkness.start.getTime(),
    darkEnd: darkness.end.getTime(),
    searched,
    passes: found,
  };
  postMessage(result);
}

self.addEventListener("message", (event: MessageEvent<InboundMessage>) => {
  const message = event.data;
  if (message.type === "init") void handleInit(message);
  else if (message.type === "tick") handleTick(message);
  else if (message.type === "visibleTonight") handleVisibleTonight(message);
});
