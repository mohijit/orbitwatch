"use client";

import { describeVisibility, type SatellitePass, type VisibilityClassification } from "@orbitwatch/orbit-core";

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
 */

export interface PassListProps {
  readonly passes: readonly SatellitePass[];
  readonly hasObserver: boolean;
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

export function PassList({ passes, hasObserver }: PassListProps) {
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
      {passes.map((pass) => (
        <li className="pass-list__item" key={pass.aos.time.toISOString()} data-testid="pass-list-item">
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
        </li>
      ))}
    </ol>
  );
}
