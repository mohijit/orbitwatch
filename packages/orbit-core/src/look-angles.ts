import {
  dopplerFactor,
  ecfToLookAngles,
  eciToEcf,
  geodeticToEcf,
  gstime,
  type SatRec,
} from "satellite.js";

import { propagateAt, type PropagateOptions } from "./propagation.js";
import type { CompassPoint, LookAngles, ObserverLocation } from "./types.js";
import {
  degrees,
  kilometers,
  kilometersPerSecond,
  normalizeDegrees,
  radians,
  toDegrees,
  toRadians,
  type Degrees,
} from "./units.js";

/**
 * Observer-relative geometry.
 *
 * satellite.js provides `ecfToLookAngles`, which we use rather than reimplementing
 * the topocentric transform. What this module adds is the surrounding correctness
 * work: converting the observer's degrees into the radians the library expects,
 * computing range rate (which the library does not provide directly), and turning
 * bearings into something a person can act on.
 */

/** The 16 compass points, in order from north, each spanning 22.5 degrees. */
const COMPASS_POINTS: readonly CompassPoint[] = [
  "N", "NNE", "NE", "ENE",
  "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW",
  "W", "WNW", "NW", "NNW",
];

const DEGREES_PER_COMPASS_POINT = 360 / COMPASS_POINTS.length;

/**
 * Interval used to differentiate range for the range-rate estimate.
 *
 * One second is short enough that the range curve is effectively linear over the
 * interval even for a fast LEO pass, and long enough to stay well clear of
 * floating-point noise in the difference.
 */
const RANGE_RATE_DELTA_SECONDS = 1;

/** Convert an azimuth in degrees into a 16-point compass abbreviation. */
export function azimuthToCompass(azimuth: Degrees): CompassPoint {
  const normalized = normalizeDegrees(azimuth);
  // Adding half a sector before flooring rounds to the NEAREST point rather than
  // always rounding down, so 349 degrees reads as N and not NNW.
  const index =
    Math.floor(normalized / DEGREES_PER_COMPASS_POINT + 0.5) % COMPASS_POINTS.length;
  // The modulo above guarantees the index is in range.
  return COMPASS_POINTS[index] as CompassPoint;
}

/**
 * Compute look angles from an observer to a satellite at a given time.
 *
 * Returns `undefined` when the satellite cannot be propagated (decayed or invalid
 * elements), so callers distinguish "below the horizon" from "no position at all".
 */
export function lookAnglesAt(
  satrec: SatRec,
  observer: ObserverLocation,
  time: Date,
  options: PropagateOptions = {},
): LookAngles | undefined {
  const current = propagateAt(satrec, time, options);
  if (!current.ok) return undefined;

  // satellite.js expects the observer in RADIANS with height in kilometres. Passing
  // degrees here is the single most common error in satellite look-angle code, and
  // produces plausible-looking but wrong azimuths.
  const observerGeodetic = {
    longitude: toRadians(observer.longitude),
    latitude: toRadians(observer.latitude),
    height: observer.altitude,
  };

  const gmst = gstime(time);
  const satelliteEcf = eciToEcf(current.state.positionEci, gmst);
  const angles = ecfToLookAngles(observerGeodetic, satelliteEcf);

  const azimuth = normalizeDegrees(toDegrees(radians(angles.azimuth)));
  const elevation = toDegrees(radians(angles.elevation));

  return {
    azimuth,
    compass: azimuthToCompass(azimuth),
    elevation,
    range: kilometers(angles.rangeSat),
    rangeRate: kilometersPerSecond(
      estimateRangeRate(satrec, observerGeodetic, time, angles.rangeSat, options),
    ),
    // Strictly geometric: the true horizon is raised slightly by refraction and by
    // any local terrain, neither of which we model. Pass prediction applies a
    // configurable minimum elevation on top of this.
    aboveHorizon: elevation > 0,
  };
}

/**
 * Estimate range rate by differentiating range over a short interval.
 *
 * Computed numerically rather than by projecting the velocity vector onto the
 * line of sight, because the observer is on a rotating Earth: the analytic form must
 * account for the observer's own velocity in the inertial frame, and getting that
 * wrong produces an error of a few hundred metres per second — enough to matter for
 * Doppler. Differencing the range handles it implicitly and correctly.
 *
 * Sign convention: positive means the satellite is receding.
 */
function estimateRangeRate(
  satrec: SatRec,
  observerGeodeticRadians: { longitude: number; latitude: number; height: number },
  time: Date,
  currentRange: number,
  options: PropagateOptions,
): number {
  const later = new Date(time.getTime() + RANGE_RATE_DELTA_SECONDS * 1000);
  const next = propagateAt(satrec, later, options);
  if (!next.ok) return 0;

  const laterEcf = eciToEcf(next.state.positionEci, gstime(later));
  const laterAngles = ecfToLookAngles(observerGeodeticRadians, laterEcf);

  return (laterAngles.rangeSat - currentRange) / RANGE_RATE_DELTA_SECONDS;
}

/**
 * Doppler factor for a radio link, using satellite.js.
 *
 * Multiply a transmitted frequency by this to obtain the received frequency. Values
 * above 1 mean the satellite is approaching (signal shifted higher).
 */
export function dopplerFactorAt(
  satrec: SatRec,
  observer: ObserverLocation,
  time: Date,
  options: PropagateOptions = {},
): number | undefined {
  const current = propagateAt(satrec, time, options);
  if (!current.ok) return undefined;

  const gmst = gstime(time);
  const observerEcf = geodeticToEcf({
    longitude: toRadians(observer.longitude),
    latitude: toRadians(observer.latitude),
    height: observer.altitude,
  });

  const positionEcf = eciToEcf(current.state.positionEci, gmst);
  const velocityEcf = eciToEcf(current.state.velocityEci, gmst);

  return dopplerFactor(observerEcf, positionEcf, velocityEcf);
}

/**
 * Build an observer from plain degrees.
 *
 * Altitude defaults to sea level. That is deliberately conservative: an observer's
 * true elevation shifts pass timings by well under a second for typical ground
 * elevations, so guessing is unnecessary, and assuming zero never overstates
 * visibility.
 */
export function observerAt(
  latitude: number,
  longitude: number,
  altitudeKm = 0,
  label?: string,
): ObserverLocation {
  if (latitude < -90 || latitude > 90) {
    throw new RangeError(`Observer latitude must be within [-90, 90], got ${latitude}`);
  }
  if (longitude < -180 || longitude > 180) {
    throw new RangeError(
      `Observer longitude must be within [-180, 180], got ${longitude}`,
    );
  }

  return {
    latitude: degrees(latitude),
    longitude: degrees(longitude),
    altitude: kilometers(altitudeKm),
    ...(label === undefined ? {} : { label }),
  };
}
