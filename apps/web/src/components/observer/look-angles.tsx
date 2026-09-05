"use client";

import { spokenBearing, spokenElevation, spokenRangeRate } from "../../lib/spoken";

import type { LookAngles } from "@orbitwatch/orbit-core";

/**
 * Where to point, right now.
 *
 * These are the numbers someone actually aims an antenna or a telescope with, so they
 * update on every clock tick rather than being cached with the pass list. Azimuth is
 * given numerically AND as a compass point: the number is what a rotator takes, the
 * compass point is what a person standing outside can use.
 *
 * Range rate is signed and labelled, not dressed up as a Doppler shift in kHz. Turning
 * it into a frequency offset needs a transmit frequency, which the catalog does not
 * carry — that arrives with the SatNOGS transmitter data in M7.
 */

export interface LookAnglesInstrumentProps {
  readonly lookAngles: LookAngles | undefined;
  /** False when there is no observer at all, which reads differently from "below the horizon". */
  readonly hasObserver: boolean;
}

export function LookAnglesInstrument({ lookAngles, hasObserver }: LookAnglesInstrumentProps) {
  if (!hasObserver) {
    return (
      <p className="look-angles__empty" data-testid="look-angles-no-observer">
        Set an observing location to see where to point.
      </p>
    );
  }

  if (lookAngles === undefined) {
    return (
      <p className="look-angles__empty" data-testid="look-angles-unavailable">
        No position available for this object at this time.
      </p>
    );
  }

  return (
    <section className="look-angles" data-testid="look-angles" aria-labelledby="look-angles-heading">
      <h3 id="look-angles-heading" className="telemetry-panel__section-heading">
        Look angles
      </h3>
      <div
        className={`look-angles__horizon look-angles__horizon--${
          lookAngles.aboveHorizon ? "up" : "down"
        }`}
        data-testid="look-angles-horizon"
      >
        {lookAngles.aboveHorizon ? "Above the horizon" : "Below the horizon"}
      </div>

      <dl className="look-angles__facts">
        <dt>Azimuth</dt>
        <dd
          data-testid="look-angles-azimuth"
          aria-label={spokenBearing(lookAngles.azimuth, lookAngles.compass)}
        >
          {lookAngles.azimuth.toFixed(1)}° {lookAngles.compass}
        </dd>

        <dt>Elevation</dt>
        <dd
          data-testid="look-angles-elevation"
          aria-label={spokenElevation(lookAngles.elevation)}
        >
          {lookAngles.elevation.toFixed(1)}°
        </dd>

        <dt>Range</dt>
        <dd
          data-testid="look-angles-range"
          aria-label={`${Math.round(lookAngles.range).toLocaleString()} kilometres`}
        >
          {Math.round(lookAngles.range).toLocaleString()} km
        </dd>

        <dt>Range rate</dt>
        <dd
          data-testid="look-angles-range-rate"
          aria-label={spokenRangeRate(lookAngles.rangeRate)}
        >
          {lookAngles.rangeRate >= 0 ? "+" : "−"}
          {Math.abs(lookAngles.rangeRate).toFixed(2)} km/s{" "}
          <span className="look-angles__hint">
            {lookAngles.rangeRate >= 0 ? "receding" : "approaching"}
          </span>
        </dd>
      </dl>

      {lookAngles.aboveHorizon ? null : (
        <p className="look-angles__hint">
          Azimuth and elevation are still computed below the horizon — the geometry is
          real, the line of sight is through the Earth.
        </p>
      )}
    </section>
  );
}
