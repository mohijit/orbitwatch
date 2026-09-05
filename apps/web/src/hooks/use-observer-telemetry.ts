"use client";

import {
  lookAnglesAt,
  observerLighting,
  predictPasses,
  sunAltitudeDegrees,
  type LookAngles,
  type ObserverLocation,
  type ObserverLighting,
  type SatellitePass,
  type SatRec,
} from "@orbitwatch/orbit-core";
import { useMemo } from "react";

/**
 * What the selected satellite is doing relative to the observer.
 *
 * Two quantities with very different costs, so they are memoised separately:
 *
 *   LOOK ANGLES are one propagation. They are recomputed on every clock tick, because
 *   azimuth, elevation and range are the numbers someone points an antenna or a
 *   telescope with, and a stale one is useless.
 *
 *   PASSES are a search over a whole day — with the default 30 s coarse step, a few
 *   thousand propagations plus a bisection refinement per crossing. They depend on
 *   the elements and the observer, NOT on the current instant, so recomputing them
 *   every second would burn that work to produce an identical answer. The search
 *   window is anchored to a coarsened clock so it advances without thrashing.
 */

/** Pass predictions look this far ahead. A day covers every LEO repeat cycle. */
const PASS_WINDOW_HOURS = 24;

/**
 * Granularity of the instant the pass search is anchored to.
 *
 * Passes are recomputed when this changes, so it trades staleness against work: at
 * five minutes, a pass list is at most five minutes out of date at its leading edge,
 * and the search runs twelve times an hour rather than 3,600.
 */
const PASS_ANCHOR_MS = 5 * 60_000;

export interface ObserverTelemetry {
  /** Undefined when there is no observer, or the satellite cannot be propagated. */
  readonly lookAngles: LookAngles | undefined;
  readonly passes: readonly SatellitePass[];
  /** Sun altitude at the observer right now, in degrees. Negative is below the horizon. */
  readonly sunAltitude: number | undefined;
  readonly lighting: ObserverLighting | undefined;
}

export function useObserverTelemetry(
  satrec: SatRec | undefined,
  observer: ObserverLocation | undefined,
  time: number,
): ObserverTelemetry {
  const lookAngles = useMemo(() => {
    if (satrec === undefined || observer === undefined) return undefined;
    return lookAnglesAt(satrec, observer, new Date(time));
  }, [satrec, observer, time]);

  const sky = useMemo(() => {
    if (observer === undefined) return undefined;
    const at = new Date(time);
    return {
      sunAltitude: sunAltitudeDegrees(observer, at),
      lighting: observerLighting(observer, at),
    };
  }, [observer, time]);

  // Coarsened deliberately: see PASS_ANCHOR_MS.
  const passAnchor = Math.floor(time / PASS_ANCHOR_MS) * PASS_ANCHOR_MS;

  const passes = useMemo(() => {
    if (satrec === undefined || observer === undefined) return [];
    const start = new Date(passAnchor);
    const end = new Date(passAnchor + PASS_WINDOW_HOURS * 3_600_000);
    return predictPasses(satrec, observer, start, end);
  }, [satrec, observer, passAnchor]);

  return {
    lookAngles,
    passes,
    sunAltitude: sky?.sunAltitude,
    lighting: sky?.lighting,
  };
}
