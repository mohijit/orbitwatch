/// <reference lib="webworker" />

import { catalogElementsResponseSchema } from "@orbitwatch/contracts";
import {
  ElementParseError,
  parseOmm,
  propagateManyAt,
  type CatalogId,
  type OMMJsonObject,
  type SatRec,
} from "@orbitwatch/orbit-core";

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

type InboundMessage = InitMessage | TickMessage;

let satrecs: SatRec[] = [];
let catalogIds: CatalogId[] = [];

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
  let failed = 0;

  for (const record of elements) {
    try {
      const { satrec } = parseOmm(record.omm as OMMJsonObject);
      parsedSatrecs.push(satrec);
      parsedIds.push(satrec.satnum as CatalogId);
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

self.addEventListener("message", (event: MessageEvent<InboundMessage>) => {
  const message = event.data;
  if (message.type === "init") void handleInit(message);
  else if (message.type === "tick") handleTick(message);
});
