"use client";

import {
  describeVisibility,
  passSkyTrack,
  type ObserverLocation,
  type SatRec,
  type SatellitePass,
  type VisibilityClassification,
} from "@orbitwatch/orbit-core";
import { useMemo, useState } from "react";

import { SkyChart } from "./sky-chart";

/**
 * Upcoming passes over the observer.
 *
 * Every row states its own visibility and why. The classification is categorical
 * rather than a predicted magnitude, because a magnitude needs a per-object brightness
 * model — size, shape, attitude, albedo — that the public catalogs do not publish.
 * Quoting "+2.1 mag" from elements alone would be inventing precision, so the UI says
 * what it can actually defend: the spacecraft is lit or it is not, your sky is dark or
 * it is not, and the pass gets high enough to be worth looking for or it does not.
 *
 * AOS and LOS are given as clock times in the viewer's own zone, because that is what
 * someone standing outside needs, with the maximum elevation and its bearing alongside
 * — a pass peaking at 12° in the north is a very different proposition from one
 * passing overhead.
 *
 * EXPANDING A ROW DRAWS THE PASS
 * A row tells you where to point; the sky chart tells you what the pass looks like.
 * The arc is sampled on demand for the one expanded pass rather than for every row,
 * because sixty propagations and sixty shadow computations per pass, across a day of
 * passes, is a hundredfold more work than the prediction itself — to draw something
 * that is only ever looked at one pass at a time.
 */

export interface PassListProps {
  readonly passes: readonly SatellitePass[];
  readonly hasObserver: boolean;
  /**
   * Needed to plot a pass, not to list one.
   *
   * The list arrives already computed; the sky chart has to re-derive the arc, which
   * needs the same element set and location the prediction used. Passing them rather
   * than recomputing the passes here keeps one source of pass truth.
   */
  readonly satrec: SatRec | undefined;
  readonly observer: ObserverLocation | undefined;
}

/** Passes are identified by AOS, which is unique per satellite per pass. */
function passKey(pass: SatellitePass): string {
  return pass.aos.time.toISOString();
}

const VISIBILITY_LABEL: Record<VisibilityClassification, string> = {
  LIKELY_VISIBLE: "Likely visible",
  POSSIBLY_VISIBLE: "Possibly visible",
  NOT_OPTICALLY_FAVOURABLE: "Not favourable",
  DAYLIGHT: "Daylight",
  SATELLITE_IN_SHADOW: "In shadow",
};

/** Local wall-clock time. Deliberately the viewer's zone, not UTC. */
const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });

function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  return minutes === 0 ? `${whole}s` : `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
}

export function PassList({ passes, hasObserver, satrec, observer }: PassListProps) {
  const [expandedKey, setExpandedKey] = useState<string | undefined>(undefined);

  // Declared before the early returns below: hooks must run unconditionally, and the
  // list has three states that return early.
  const expanded = passes.find((pass) => passKey(pass) === expandedKey);
  const track = useMemo(() => {
    if (expanded === undefined || satrec === undefined || observer === undefined) return [];
    return passSkyTrack(satrec, observer, expanded);
  }, [expanded, satrec, observer]);

  if (!hasObserver) {
    return (
      <p className="pass-list__empty" data-testid="pass-list-no-observer">
        Set an observing location to see passes.
      </p>
    );
  }

  if (passes.length === 0) {
    return (
      <p className="pass-list__empty" data-testid="pass-list-empty">
        No passes above 10° in the next 24 hours.
      </p>
    );
  }

  return (
    <ol className="pass-list" data-testid="pass-list">
      {passes.map((pass) => {
        const key = passKey(pass);
        const isExpanded = key === expandedKey;
        return (
        <li className="pass-list__item" key={key} data-testid="pass-list-item">
          <button
            type="button"
            className="pass-list__row"
            aria-expanded={isExpanded}
            onClick={() => {
              setExpandedKey(isExpanded ? undefined : key);
            }}
            data-testid="pass-list-toggle"
          >
          <div className="pass-list__when">
            <span className="pass-list__day">{dayFormat.format(pass.aos.time)}</span>
            <span className="pass-list__times">
              {timeFormat.format(pass.aos.time)} → {timeFormat.format(pass.los.time)}
            </span>
            <span className="pass-list__duration">{formatDuration(pass.durationSeconds)}</span>
          </div>

          <div className="pass-list__geometry">
            <span data-testid="pass-max-elevation">
              max {pass.maximum.elevation.toFixed(0)}° {pass.maximum.compass}
            </span>
            <span className="pass-list__range">
              {Math.round(pass.minimumRange).toLocaleString()} km
            </span>
          </div>

          <span
            className={`pass-list__visibility pass-list__visibility--${pass.visibility
              .toLowerCase()
              .replace(/_/g, "-")}`}
            title={describeVisibility(pass.visibility)}
            data-testid="pass-visibility"
          >
            {VISIBILITY_LABEL[pass.visibility]}
          </span>
          </button>

          {isExpanded ? <SkyChart pass={pass} track={track} /> : null}
        </li>
        );
      })}
    </ol>
  );
}
