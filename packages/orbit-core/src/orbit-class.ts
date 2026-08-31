import type { SatRec } from "satellite.js";

import type { OrbitClass, OrbitGeometry } from "./types.js";
import {
  EARTH_RADIUS_KM,
  GEOSTATIONARY_ALTITUDE_KM,
  LEO_ALTITUDE_CEILING_KM,
  SIDEREAL_DAY_MINUTES,
  earthRadii,
  earthRadiiToKilometers,
  kilometers,
  minutes,
  periodFromMeanMotion,
  radiansPerMinute,
  type Kilometers,
  type Minutes,
} from "./units.js";

/**
 * Orbit regime classification.
 *
 * A single altitude test is not sufficient. A Molniya satellite has a perigee near
 * 500 km (LEO-like) and an apogee near 40,000 km (beyond GEO); classifying it by
 * either number alone is wrong, and classifying it by mean altitude is misleading.
 * The regime is therefore decided from period, eccentricity, perigee AND apogee
 * together, with eccentricity checked first because a highly elliptical orbit is
 * defined by its shape rather than its height.
 */

/**
 * Eccentricity above which an orbit is treated as highly elliptical.
 *
 * 0.25 sits comfortably above the near-circular operational orbits (Starlink and
 * GPS are both below 0.02) and comfortably below Molniya (~0.74), so it separates
 * the two populations without straddling either.
 */
const HIGH_ECCENTRICITY_THRESHOLD = 0.25;

/**
 * Fractional tolerance on the sidereal day when testing for geosynchronicity.
 *
 * ±2% of 1436 minutes is roughly ±29 minutes. Station-kept geostationary satellites
 * sit far inside this; drifting or retired ones near the geo belt still register as
 * geosynchronous, which is the useful answer for a tracking product.
 */
const GEOSYNCHRONOUS_PERIOD_TOLERANCE = 0.02;

/**
 * Maximum inclination for "GEO" as opposed to the broader "GSO".
 *
 * A true geostationary satellite is equatorial and appears fixed in the sky. Objects
 * with the same period but meaningful inclination trace a figure-eight and are
 * geosynchronous but NOT geostationary — a distinction that matters to anyone
 * pointing an antenna.
 */
const GEOSTATIONARY_MAX_INCLINATION_DEG = 25;

/** Maximum eccentricity for "GEO"; above this the object is not station-kept. */
const GEOSTATIONARY_MAX_ECCENTRICITY = 0.01;

/**
 * Derive time-independent orbit geometry from a satellite.js record.
 *
 * `satrec.alta` and `satrec.altp` are apogee and perigee altitudes expressed in
 * Earth radii above the surface, computed by SGP4 during initialisation. Using them
 * keeps our geometry consistent with the propagator rather than recomputing from
 * mean elements with a possibly different Earth radius.
 */
export function deriveOrbitGeometry(satrec: SatRec): OrbitGeometry {
  const period = periodFromMeanMotion(radiansPerMinute(satrec.no));

  const apogeeAltitude = earthRadiiToKilometers(earthRadii(satrec.alta));
  const perigeeAltitude = earthRadiiToKilometers(earthRadii(satrec.altp));

  // `satrec.a` is the semi-major axis in Earth radii, measured from Earth's centre.
  const semiMajorAxis = kilometers(satrec.a * EARTH_RADIUS_KM);

  const orbitClass = classifyOrbit({
    period,
    eccentricity: satrec.ecco,
    inclinationDegrees: (satrec.inclo * 180) / Math.PI,
    apogeeAltitude,
    perigeeAltitude,
  });

  return { period, apogeeAltitude, perigeeAltitude, semiMajorAxis, orbitClass };
}

export interface ClassifyOrbitInput {
  readonly period: Minutes;
  readonly eccentricity: number;
  readonly inclinationDegrees: number;
  readonly apogeeAltitude: Kilometers;
  readonly perigeeAltitude: Kilometers;
}

/**
 * Classify an orbit into a broad regime.
 *
 * Order matters. Eccentricity is tested before any altitude band because an
 * eccentric orbit spans several bands and belongs to none of them.
 */
export function classifyOrbit(input: ClassifyOrbitInput): OrbitClass {
  const { period, eccentricity, inclinationDegrees, apogeeAltitude, perigeeAltitude } =
    input;

  // Reject physically impossible inputs rather than silently mislabelling them.
  if (
    !Number.isFinite(period) ||
    period <= 0 ||
    !Number.isFinite(eccentricity) ||
    eccentricity < 0 ||
    eccentricity >= 1 ||
    !Number.isFinite(apogeeAltitude) ||
    !Number.isFinite(perigeeAltitude)
  ) {
    return "UNKNOWN";
  }

  // A perigee below the surface means the elements are stale or the object has
  // decayed; there is no meaningful regime to report.
  if (perigeeAltitude < 0) return "UNKNOWN";

  const isGeosynchronousPeriod =
    Math.abs(period - SIDEREAL_DAY_MINUTES) / SIDEREAL_DAY_MINUTES <=
    GEOSYNCHRONOUS_PERIOD_TOLERANCE;

  // Geosynchronous is checked before the eccentricity test: a Tundra orbit is both
  // geosynchronous and highly elliptical, and the synchronous period is the more
  // informative fact for a tracking UI.
  if (isGeosynchronousPeriod) {
    const isGeostationary =
      eccentricity <= GEOSTATIONARY_MAX_ECCENTRICITY &&
      Math.abs(inclinationDegrees) <= GEOSTATIONARY_MAX_INCLINATION_DEG;
    return isGeostationary ? "GEO" : "GSO";
  }

  // Highly elliptical: shape dominates. Molniya and most transfer orbits land here.
  if (eccentricity >= HIGH_ECCENTRICITY_THRESHOLD) return "HEO";

  // Near-circular from here on, so apogee and perigee are close together and
  // altitude bands become meaningful.
  if (apogeeAltitude < LEO_ALTITUDE_CEILING_KM) return "LEO";

  if (perigeeAltitude >= LEO_ALTITUDE_CEILING_KM && apogeeAltitude < GEOSTATIONARY_ALTITUDE_KM) {
    return "MEO";
  }

  // Beyond the geostationary belt but not synchronous — graveyard orbits, some
  // science missions, and objects on their way elsewhere.
  if (perigeeAltitude >= GEOSTATIONARY_ALTITUDE_KM) return "HIGH";

  // Straddles a boundary without being eccentric enough to call HEO. Most commonly
  // an orbit whose perigee is just under 2000 km with a much higher apogee.
  return "HEO";
}

/** Human-readable description, used in tooltips and the DATA tab. */
export function describeOrbitClass(orbitClass: OrbitClass): string {
  switch (orbitClass) {
    case "LEO":
      return "Low Earth orbit — below 2,000 km, orbital period under about 2 hours.";
    case "MEO":
      return "Medium Earth orbit — between 2,000 km and the geostationary belt.";
    case "GEO":
      return "Geostationary — equatorial and near-circular, appears fixed in the sky.";
    case "GSO":
      return "Geosynchronous — matches Earth's rotation but inclined or eccentric, so it traces a figure-eight.";
    case "HEO":
      return "Highly elliptical — a low perigee and a much higher apogee.";
    case "HIGH":
      return "High orbit — entirely beyond the geostationary belt.";
    case "UNKNOWN":
      return "Orbit regime could not be determined from the available elements.";
  }
}

/** Period of the object expressed in whole minutes, for compact display. */
export function periodMinutes(satrec: SatRec): Minutes {
  return minutes(periodFromMeanMotion(radiansPerMinute(satrec.no)));
}
