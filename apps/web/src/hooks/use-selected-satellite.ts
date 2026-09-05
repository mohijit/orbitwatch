"use client";

import {
  assessAccuracy,
  deriveOrbitGeometry,
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
  /**
   * The object's name, and its international designator.
   *
   * Both are read from the OMM that produced the position, not from a separate
   * metadata request. That costs nothing — the record is already in hand — and it
   * keeps the name provenance-consistent with the elements shown beside it: what the
   * panel displays is what the provider published in THIS element set, not a name
   * fetched at a different time from a different endpoint that could disagree.
   *
   * `name` falls back to the catalog id, because a TLE-format set carries no
   * OBJECT_NAME. Showing the number is honest in that case; inventing a name is not.
   */
  readonly name: string;
  readonly internationalDesignator: string | undefined;
  readonly satrec: SatRec;
  readonly accuracy: AccuracyAssessment;
  readonly orbitClass: OrbitClass;
  readonly groundTrackSegments: readonly (readonly { latitude: number; longitude: number }[])[];
  readonly footprint: readonly { latitude: number; longitude: number }[];
}

export type SelectedTelemetryState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | ({ readonly status: "ready" } & SelectedTelemetry);

const GROUND_TRACK_WINDOW_MINUTES = 100; // roughly one LEO orbit either side of `time`

interface SatelliteIdentity {
  readonly name: string;
  readonly internationalDesignator: string | undefined;
}

/**
 * Reads the object's published identity out of the raw OMM.
 *
 * Typed as `unknown` and checked, rather than cast: `omm` is `Record<string, unknown>`
 * in the contract on purpose, since it is the provider's record verbatim rather than a
 * shape we control. A provider that stops sending OBJECT_NAME should degrade to the
 * catalog number, not render `undefined` into the header.
 */
function identityOf(omm: Record<string, unknown>, catalogId: string): SatelliteIdentity {
  const name = omm["OBJECT_NAME"];
  const designator = omm["OBJECT_ID"];
  return {
    name: typeof name === "string" && name.trim() !== "" ? name.trim() : catalogId,
    internationalDesignator:
      typeof designator === "string" && designator.trim() !== "" ? designator.trim() : undefined,
  };
}

function derive(
  catalogId: string,
  identity: SatelliteIdentity,
  satrec: SatRec,
  epoch: Date,
  time: number,
): SelectedTelemetry {
  const targetTime = new Date(time);

  // Derived from the satrec rather than taken as an argument. It used to be a
  // parameter, and the only caller passed `undefined` — which silently fell back to
  // the UNKNOWN accuracy bands. Those are byte-identical to LEO, so every GEO object
  // was judged against LEO tolerances and reported as aging roughly ten times too
  // early. Nothing outside this module knows the orbit class before the elements are
  // fetched, so nothing outside this module should be asked for it.
  const { orbitClass } = deriveOrbitGeometry(satrec);
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

  return {
    catalogId,
    name: identity.name,
    internationalDesignator: identity.internationalDesignator,
    satrec,
    accuracy,
    orbitClass,
    groundTrackSegments: track.segments,
    footprint,
  };
}

export function useSelectedSatellite(
  catalogId: string | undefined,
  time: number,
  mode: TimelineMode,
): SelectedTelemetryState {
  const [fetched, setFetched] = useState<
    { satrec: SatRec; epoch: Date; identity: SatelliteIdentity } | undefined
  >(undefined);
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
        setFetched({
          satrec,
          epoch: new Date(response.elements.epoch),
          identity: identityOf(response.elements.omm, catalogId),
        });
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
    setState({
      status: "ready",
      ...derive(catalogId, fetched.identity, fetched.satrec, fetched.epoch, time),
    });
  }, [catalogId, fetched, time]);

  return state;
}
