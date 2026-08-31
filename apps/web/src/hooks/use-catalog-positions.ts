"use client";

import { useEffect, useRef, useState } from "react";

import { fetchCatalogElements } from "../lib/api-client";

/**
 * Fields per object in the worker's position buffer: [lon, lat, altKm, ok].
 *
 * Duplicated from propagation.worker.ts rather than imported: that module runs
 * `self.addEventListener` at load time, and importing it from the main thread would
 * attach that listener to `window` instead of a worker context. The constant is
 * cheap enough to keep in sync by hand; the alternative is a shared non-worker module
 * for one integer, which is worse.
 */
export const POSITION_FIELDS = 4;

/**
 * Whole-catalog positions, propagated in a Web Worker.
 *
 * Fetches current elements once from the API, hands them to the worker, and then
 * drives a tick loop at `tickHz`. `time` is a prop rather than an internal clock so the
 * timeline can drive propagation to a past instant (SIMULATION) or let it run forward
 * from now (LIVE) — the worker does not know or care which.
 */

export type CatalogTickState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly positions: Float32Array;
      readonly catalogIds: readonly string[];
      readonly count: number;
      readonly failed: number;
      readonly tickTime: number;
    };

const DEFAULT_TICK_HZ = 1;

export function useCatalogPositions(time: number, tickHz = DEFAULT_TICK_HZ): CatalogTickState {
  const [state, setState] = useState<CatalogTickState>({ status: "loading" });
  const workerRef = useRef<Worker | null>(null);
  const catalogIdsRef = useRef<readonly string[]>([]);
  const readyRef = useRef(false);

  // Worker lifecycle: created once, fed the catalog once.
  useEffect(() => {
    let disposed = false;

    const worker = new Worker(new URL("../workers/propagation.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.addEventListener("message", (event: MessageEvent) => {
      if (disposed) return;
      const message = event.data as
        | { type: "catalogIds"; ids: readonly string[] }
        | { type: "ready"; count: number; failed: number }
        | { type: "positions"; buffer: ArrayBuffer; time: number };

      if (message.type === "catalogIds") {
        catalogIdsRef.current = message.ids;
      } else if (message.type === "ready") {
        readyRef.current = true;
        if (message.failed > 0) {
          // Visible in the console rather than swallowed: dropping thousands of
          // objects from the catalog must never be silent.
          console.warn(
            `${message.failed} of ${message.count + message.failed} elements failed to parse`,
          );
        }
      } else if (message.type === "positions") {
        setState({
          status: "ready",
          positions: new Float32Array(message.buffer),
          catalogIds: catalogIdsRef.current,
          count: catalogIdsRef.current.length,
          failed: 0,
          tickTime: message.time,
        });
      }
    });

    void (async () => {
      try {
        const catalog = await fetchCatalogElements();
        if (disposed) return;
        worker.postMessage({
          type: "init",
          elements: catalog.elements.map((element) => ({
            catalogId: element.catalogId,
            omm: element.omm,
          })),
        });
      } catch (error) {
        if (disposed) return;
        setState({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      disposed = true;
      worker.terminate();
      workerRef.current = null;
    };
    // Deliberately mount-once: the worker and the fetched catalog outlive time changes.
  }, []);

  // Tick loop: posts the current `time` to the worker at `tickHz`.
  useEffect(() => {
    const intervalMs = 1000 / tickHz;
    const interval = setInterval(() => {
      if (readyRef.current) workerRef.current?.postMessage({ type: "tick", time });
    }, intervalMs);
    return () => clearInterval(interval);
  }, [time, tickHz]);

  return state;
}

