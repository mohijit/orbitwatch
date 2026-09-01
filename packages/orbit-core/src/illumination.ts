import { jday, shadowFraction, sunPos, type SatRec } from "satellite.js";

import { propagateAt, type PropagateOptions } from "./propagation.js";
import type { IlluminationState, ObserverLocation } from "./types.js";
import { toRadians } from "./units.js";

/**
 * Spacecraft illumination and observer lighting.
 *
 * Whether a satellite is sunlit decides whether it can be seen at all: an object in
 * Earth's shadow reflects nothing. Combined with how dark it is at the observer, this
 * is what turns a geometric pass into a visible one.
 *
 * Uses satellite.js `sunPos` and `shadowFraction` rather than a hand-rolled shadow
 * model. `shadowFraction` returns the fraction of the Sun's disc obscured by Earth as
 * seen from the spacecraft: 0 is fully lit, 1 is total umbra, and anything between is
 * penumbra.
 */

/**
 * Fractions below this count as fully sunlit.
 *
 * A tiny non-zero fraction is grazing penumbra and has no practical effect on
 * brightness, so treating it as "sunlit" avoids a distracting flicker between states
 * at the shadow boundary.
 */
const SUNLIT_THRESHOLD = 0.01;

/** At or above this fraction the spacecraft is effectively in full shadow. */
const UMBRA_THRESHOLD = 0.99;

/**
 * Sun altitude below which the observer's sky is dark enough for satellite spotting.
 *
 * -6 degrees is the end of civil twilight. Brighter satellites are findable a little
 * before that, but civil twilight is the conventional, defensible boundary and we
 * would rather understate visibility than promise a sighting that does not happen.
 */
export const CIVIL_TWILIGHT_DEGREES = -6;

/** Sun altitude below which the sky is fully dark (astronomical twilight). */
export const ASTRONOMICAL_TWILIGHT_DEGREES = -18;

/** Determine whether a satellite is sunlit, in penumbra, or in umbra. */
export function illuminationAt(
  satrec: SatRec,
  time: Date,
  options: PropagateOptions = {},
): { state: IlluminationState; shadowFraction: number } | undefined {
  const result = propagateAt(satrec, time, options);
  if (!result.ok) return undefined;

  // sunPos takes a Julian day and returns the Sun's position in AU; shadowFraction
  // expects exactly that, paired with the satellite's ECI position in km.
  const sun = sunPos(jday(time));
  const fraction = shadowFraction(sun.rsun, result.state.positionEci);

  return { state: classifyShadow(fraction), shadowFraction: fraction };
}

export function classifyShadow(fraction: number): IlluminationState {
  if (!Number.isFinite(fraction)) return "SUNLIT";
  if (fraction <= SUNLIT_THRESHOLD) return "SUNLIT";
  if (fraction >= UMBRA_THRESHOLD) return "UMBRA";
  return "PENUMBRA";
}

/**
 * Sun altitude at the observer, in degrees above the horizon.
 *
 * Derived from the Sun's declination and right ascension via the standard
 * altitude formula, using Greenwich sidereal time to obtain the local hour angle.
 */
export function sunAltitudeDegrees(observer: ObserverLocation, time: Date): number {
  const sun = sunPos(jday(time));

  // Greenwich Mean Sidereal Time in radians for this instant.
  const gmst = greenwichMeanSiderealTime(time);

  // Local hour angle = local sidereal time - right ascension.
  const localSiderealTime = gmst + toRadians(observer.longitude);
  const hourAngle = localSiderealTime - sun.rtasc;

  const latitude = toRadians(observer.latitude);
  const declination = sun.decl;

  const sinAltitude =
    Math.sin(latitude) * Math.sin(declination) +
    Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);

  return (Math.asin(clamp(sinAltitude, -1, 1)) * 180) / Math.PI;
}

/** Observer darkness categories used by the visibility classifier. */
export type ObserverLighting = "DAYLIGHT" | "TWILIGHT" | "DARK";

export function observerLighting(
  observer: ObserverLocation,
  time: Date,
): ObserverLighting {
  const altitude = sunAltitudeDegrees(observer, time);
  if (altitude > CIVIL_TWILIGHT_DEGREES) return "DAYLIGHT";
  if (altitude > ASTRONOMICAL_TWILIGHT_DEGREES) return "TWILIGHT";
  return "DARK";
}

/**
 * The next stretch of darkness at an observer's location.
 *
 * "Tonight" is not twenty-four hours, and pretending otherwise makes every pass search
 * roughly twice the work it needs to be while offering people passes in broad daylight.
 * This finds the next window in which the sun is below `sunBelowDegrees` — civil
 * twilight by default, which is when the brighter satellites start to show.
 *
 * POLAR DAY IS A REAL ANSWER
 * Above the Arctic and Antarctic circles there are weeks with no darkness at all, and
 * at high-but-not-polar latitudes there are summer nights that never get past civil
 * twilight. Returning `undefined` says so. Returning a fabricated window, or silently
 * falling back to a fixed twelve hours, would produce a "Visible Tonight" list for a
 * sky that never gets dark.
 *
 * The boundaries are found by coarse sampling and then bisected to the minute. The
 * coarse step must stay well inside the shortest plausible night; ten minutes is safe
 * everywhere the answer is not simply "no darkness".
 */
export interface DarknessWindow {
  readonly start: Date;
  readonly end: Date;
}

export function nextDarkness(
  observer: ObserverLocation,
  from: Date,
  options: {
    readonly sunBelowDegrees?: number;
    readonly searchHours?: number;
    readonly coarseStepMinutes?: number;
  } = {},
): DarknessWindow | undefined {
  const {
    sunBelowDegrees = CIVIL_TWILIGHT_DEGREES,
    searchHours = 36,
    coarseStepMinutes = 10,
  } = options;

  const isDark = (at: Date): boolean =>
    sunAltitudeDegrees(observer, at) < sunBelowDegrees;

  const stepMs = coarseStepMinutes * 60_000;
  const deadline = from.getTime() + searchHours * 3_600_000;

  /** Bisect a bracket known to straddle a transition, down to one minute. */
  const refine = (before: number, after: number): Date => {
    let low = before;
    let high = after;
    const darkAtLow = isDark(new Date(low));
    while (high - low > 60_000) {
      const middle = low + (high - low) / 2;
      if (isDark(new Date(middle)) === darkAtLow) low = middle;
      else high = middle;
    }
    return new Date(high);
  };

  let previous = from.getTime();
  let previousDark = isDark(from);
  let start: Date | undefined = previousDark ? from : undefined;

  for (let at = previous + stepMs; at <= deadline; at += stepMs) {
    const dark = isDark(new Date(at));

    if (dark && !previousDark) {
      start = refine(previous, at);
    } else if (!dark && previousDark && start !== undefined) {
      return { start, end: refine(previous, at) };
    }

    previous = at;
    previousDark = dark;
  }

  // Darkness began but never ended inside the search horizon — polar night. Report the
  // horizon as the end rather than claiming knowledge beyond where we looked.
  if (start !== undefined) return { start, end: new Date(deadline) };

  // The sun never went below the threshold: polar day, or a high-latitude summer.
  return undefined;
}

/**
 * Greenwich Mean Sidereal Time in radians.
 *
 * Implemented here rather than reusing satellite.js `gstime` because that function
 * is typed around propagation dates; this is the same standard IAU polynomial, kept
 * local so the Sun calculations are self-contained and unit-tested independently.
 */
function greenwichMeanSiderealTime(time: Date): number {
  const julianDate = jday(time);
  // Julian centuries since J2000.0.
  const centuries = (julianDate - 2451545.0) / 36525.0;

  let gmstSeconds =
    67310.54841 +
    (876600.0 * 3600.0 + 8640184.812866) * centuries +
    0.093104 * centuries * centuries -
    6.2e-6 * centuries * centuries * centuries;

  // Reduce to [0, 86400) seconds of sidereal time, then to radians.
  gmstSeconds = gmstSeconds % 86400.0;
  if (gmstSeconds < 0) gmstSeconds += 86400.0;

  return (gmstSeconds / 240.0) * (Math.PI / 180.0);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
