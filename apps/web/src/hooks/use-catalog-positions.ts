"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { catalogElementsUrl } from "../lib/api-client";
import type {
  PlainObserver,
  VisiblePass,
  VisibleTonightResult,
} from "../workers/pass-messages";

/**
 * Fields per object in the worker's position buffer:
 * [x, y, z, vx, vy, vz, ok] — Earth-fixed position in km, velocity in km/s.
 *
 * Duplicated from propagation.worker.ts rather than imported: that module runs
 * `self.addEventListener` at load time, and importing it from the main thread would
 * attach that listener to `window` instead of a worker context. The constant is
 * cheap enough to keep in sync by hand; the alternative is a shared non-worker module
 * for one integer, which is worse.
 */
export const POSITION_FIELDS = 7;

/**
 * Whole-catalog positions, propagated in a Web Worker.
 *
 * The worker fetches the catalog itself (see propagation.worker.ts) and then
 * propagates whenever `time` changes. `time` is a prop rather than an internal clock
 * so the timeline can drive propagation to a past instant (SIMULATION) or let it run
 * forward from now (LIVE) — the worker does not know or care which.
 *
 * TICK CADENCE
 * There is deliberately no timer in here. `time` is the only clock: whoever owns it
 * decides how often the catalog is propagated, and every distinct instant produces
 * exactly one tick. An earlier version ran its own interval alongside the caller's,
 * and the two raced — the interval was re-created on every `time` change, so its next
 * firing was always scheduled just after the change that would clear it. Measured
 * result was 6 propagations in 12 seconds at irregular gaps up to 4 s, which the
 * renderer papered over by dead reckoning until it hit its extrapolation clamp and
 * then snapped. See e2e/tick-cadence.spec.ts, which fails if that returns.
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

/**
 * Result of a "Visible Tonight" search.
 *
 * `no-darkness` is a first-class outcome, not an error: above the polar circles there
 * are weeks with no night, and the UI must say so rather than show an empty list that
 * reads as "nothing is visible".
 */
export type VisibleTonightState =
  | { readonly status: "idle" }
  | { readonly status: "searching" }
  | { readonly status: "no-darkness" }
  | {
      readonly status: "ready";
      readonly darkStart: number;
      readonly darkEnd: number;
      readonly searched: number;
      readonly passes: readonly VisiblePass[];
    };

export interface CatalogWorker {
  readonly catalog: CatalogTickState;
  readonly visibleTonight: VisibleTonightState;
  /**
   * Search the given objects for passes in the next darkness window.
   *
   * The caller chooses the subset, because the worker has no opinion about which
   * objects are worth looking for and the catalog carries no brightness data to form
   * one. In practice this is CelesTrak's `visual` membership.
   */
  readonly requestVisibleTonight: (
    observer: PlainObserver,
    catalogIds: readonly string[],
    from: number,
  ) => void;
}

export function useCatalogPositions(time: number): CatalogWorker {
  const [state, setState] = useState<CatalogTickState>({ status: "loading" });
  const workerRef = useRef<Worker | null>(null);
  const catalogIdsRef = useRef<readonly string[]>([]);
  /** Mirrors `ready` so the stable request callback can read it without a dependency. */
  const readyRef = useRef(false);
  // State, not a ref: becoming ready has to re-run the tick effect below, otherwise
  // nothing propagates until `time` next changes — which in SIMULATION is never.
  const [ready, setReady] = useState(false);
  const [visibleTonight, setVisibleTonight] = useState<VisibleTonightState>({
    status: "idle",
  });

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
        | { type: "error"; message: string }
        | { type: "positions"; buffer: ArrayBuffer; time: number }
        | VisibleTonightResult;

      if (message.type === "catalogIds") {
        catalogIdsRef.current = message.ids;
      } else if (message.type === "ready") {
        readyRef.current = true;
        setReady(true);
        if (message.failed > 0) {
          // Visible in the console rather than swallowed: dropping thousands of
          // objects from the catalog must never be silent.
          console.warn(
            `${message.failed} of ${message.count + message.failed} elements failed to parse`,
          );
        }
      } else if (message.type === "visibleTonight") {
        setVisibleTonight(
          message.status === "no-darkness"
            ? { status: "no-darkness" }
            : {
                status: "ready",
                darkStart: message.darkStart,
                darkEnd: message.darkEnd,
                searched: message.searched,
                passes: message.passes,
              },
        );
      } else if (message.type === "error") {
        setState({ status: "failed", message: message.message });
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

    worker.postMessage({ type: "init", url: catalogElementsUrl() });

    return () => {
      disposed = true;
      worker.terminate();
      workerRef.current = null;
    };
    // Deliberately mount-once: the worker and the fetched catalog outlive time changes.
  }, []);

  // Propagate: one tick per distinct instant, plus one as soon as the worker is ready.
  useEffect(() => {
    if (!ready) return;
    workerRef.current?.postMessage({ type: "tick", time });
  }, [ready, time]);

  const requestVisibleTonight = useCallback<CatalogWorker["requestVisibleTonight"]>(
    (observer, catalogIds, from) => {
      const worker = workerRef.current;
      // Silently ignored before the catalog is parsed: the worker would have no
      // satrecs to search and would answer "nothing tonight", which is a claim.
      if (worker === null || !readyRef.current) return;
      setVisibleTonight({ status: "searching" });
      worker.postMessage({ type: "visibleTonight", observer, catalogIds, from });
    },
    [],
  );

  return { catalog: state, visibleTonight, requestVisibleTonight };
}
