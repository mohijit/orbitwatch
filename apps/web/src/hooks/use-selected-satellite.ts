"use client";

import {
  assessAccuracy,
  footprintRing,
  groundTrack,
  parseOmm,
  type AccuracyAssessment,
  type OMMJsonObject,
  type OrbitClass,
  type SatRec,
} from "@orbitwatch/orbit-core";
import { useEffect, useState } from "react";

import { fetchElements } from "../lib/api-client";
import type { TimelineMode } from "../components/timeline/timeline";

/**
 * Full telemetry for the selected satellite, propagated on the MAIN thread.
 *
 * This is the ADR-0002 split: exactly one object needs high-frequency, full-fidelity
 * propagation (position, ground track, footprint) at any moment, so it does not
 * justify a worker round trip. Everything else — the other 16,000+ objects — goes
 * through `useCatalogPositions` instead.
 *
 * FETCH vs RECOMPUTE
 * The element set is fetched from the API only when the selection changes or when
 * SIMULATION scrubs to a new instant — historical replay needs the set that was
 * current THEN, which only the server can resolve. In LIVE mode the clock advances
 * every second, but CelesTrak republishes roughly every two hours: refetching on every
 * tick would hit the API once a second for no new information. Ground track, footprint
 * and the accuracy assessment are recomputed locally from the already-fetched satrec
 * instead, which is cheap main-thread propagation, not a network round trip.
 */

export interface SelectedTelemetry {
  readonly catalogId: string;
  readonly satrec: SatRec;
  readonly accuracy: AccuracyAssessment;
  readonly groundTrackSegments: readonly (readonly { latitude: number; longitude: number }[])[];
  readonly footprint: readonly { latitude: number; longitude: number }[];
}

export type SelectedTelemetryState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | ({ readonly status: "ready" } & SelectedTelemetry);

const GROUND_TRACK_WINDOW_MINUTES = 100; // roughly one LEO orbit either side of `time`

function derive(
  catalogId: string,
  satrec: SatRec,
  epoch: Date,
  time: number,
  orbitClass: OrbitClass | undefined,
): SelectedTelemetry {
  const targetTime = new Date(time);
  const accuracy = assessAccuracy(epoch, targetTime, orbitClass);

  const windowMs = GROUND_TRACK_WINDOW_MINUTES * 60_000;
  const track = groundTrack(
    satrec,
    new Date(targetTime.getTime() - windowMs),
    new Date(targetTime.getTime() + windowMs),
  );

  // The footprint is drawn at the CURRENT position, so an unrenderable position (see
  // accuracy.renderable) must not draw a footprint that looks authoritative.
  let footprint: readonly { latitude: number; longitude: number }[] = [];
  if (accuracy.renderable) {
    const nowPoint = track.segments.flat().at(-1);
    if (nowPoint !== undefined) {
      footprint = footprintRing(
        { latitude: nowPoint.latitude, longitude: nowPoint.longitude, altitude: nowPoint.altitude },
        64,
      );
    }
  }

  return { catalogId, satrec, accuracy, groundTrackSegments: track.segments, footprint };
}

export function useSelectedSatellite(
  catalogId: string | undefined,
  time: number,
  mode: TimelineMode,
  orbitClass: OrbitClass | undefined,
): SelectedTelemetryState {
  const [fetched, setFetched] = useState<{ satrec: SatRec; epoch: Date } | undefined>(undefined);
  const [state, setState] = useState<SelectedTelemetryState>({ status: "idle" });

  // Fetch: on selection change, and on every SIMULATION instant (historical replay
  // needs the server to resolve which element set was current then).
  useEffect(() => {
    if (catalogId === undefined) {
      setFetched(undefined);
      setState({ status: "idle" });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });

    void (async () => {
      try {
        const response = await fetchElements(catalogId, mode === "simulation" ? new Date(time) : undefined);
        if (cancelled) return;
        const { satrec } = parseOmm(response.elements.omm as OMMJsonObject);
        setFetched({ satrec, epoch: new Date(response.elements.epoch) });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [catalogId, mode === "simulation" ? time : undefined]);

  // Recompute: every tick, from whatever was last fetched. No network.
  useEffect(() => {
    if (catalogId === undefined || fetched === undefined) return;
    setState({ status: "ready", ...derive(catalogId, fetched.satrec, fetched.epoch, time, orbitClass) });
  }, [catalogId, fetched, time, orbitClass]);

  return state;
}
