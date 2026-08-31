/// <reference lib="webworker" />

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
 *   IN  { type: "init", elements: [{ catalogId, omm }] }
 *       Parses every OMM once. A record that fails to parse is dropped (not fatal to
 *       the rest), and the worker reports how many, since a silent drop of thousands
 *       of objects should never be invisible to the caller.
 *   IN  { type: "tick", time: number }
 *       Epoch milliseconds to propagate to. Sent by the main thread's render loop or
 *       by the timeline when scrubbing.
 *   OUT { type: "ready", count, failed }
 *   OUT { type: "positions", buffer, time }
 *       buffer is Float32Array [lon, lat, altKm, ok, ...] per object, in the SAME
 *       ORDER as `catalogIds` from the "ready" message — index-aligned, not keyed,
 *       because a lookup per object per tick is exactly the per-frame cost this
 *       design exists to avoid.
 *   OUT { type: "catalogIds", ids: string[] }
 *       Sent once after init. Separate from "ready" so it is not re-serialised on
 *       every tick.
 */

export const POSITION_FIELDS = 4; // lon, lat, altKm, ok
const OK = 1;
const NOT_OK = 0;

interface InitMessage {
  readonly type: "init";
  readonly elements: readonly { readonly catalogId: string; readonly omm: unknown }[];
}

interface TickMessage {
  readonly type: "tick";
  readonly time: number;
}

type InboundMessage = InitMessage | TickMessage;

let satrecs: SatRec[] = [];
let catalogIds: CatalogId[] = [];

function handleInit(message: InitMessage): void {
  const parsedSatrecs: SatRec[] = [];
  const parsedIds: CatalogId[] = [];
  let failed = 0;

  for (const record of message.elements) {
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
    buffer[offset] = result.longitude;
    buffer[offset + 1] = result.latitude;
    buffer[offset + 2] = result.altitude;
    buffer[offset + 3] = result.ok ? OK : NOT_OK;
  }

  // Transferred, not copied or structured-cloned: ownership of the underlying
  // ArrayBuffer moves to the main thread in O(1), which is what keeps a 16,000-object
  // tick from costing a serialisation pass on top of the propagation itself.
  postMessage({ type: "positions", buffer, time: message.time }, { transfer: [buffer.buffer] });
}

self.addEventListener("message", (event: MessageEvent<InboundMessage>) => {
  const message = event.data;
  if (message.type === "init") handleInit(message);
  else if (message.type === "tick") handleTick(message);
});
