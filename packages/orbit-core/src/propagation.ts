import {
  eciToEcf,
  eciToGeodetic,
  gstime,
  propagate,
  SatRecError,
  type SatRec,
} from "satellite.js";

import type {
  CatalogId,
  GeodeticPosition,
  PropagationFailure,
  PropagationResult,
  SatelliteState,
  Vector3,
} from "./types.js";
import {
  kilometers,
  kilometersPerSecond,
  normalizeLongitude,
  radians,
  toDegrees,
  type Kilometers,
  type KilometersPerSecond,
} from "./units.js";

/**
 * SGP4/SDP4 propagation.
 *
 * This is the only place in OrbitWatch that calls satellite.js `propagate`. Every
 * position shown anywhere in the product — web, native, worker — originates here, so
 * the reference frames and units are asserted once and correctly.
 *
 * Frames, in the order they are derived:
 *   SGP4 -> TEME (an inertial frame, referred to as ECI throughout satellite.js)
 *   ECI + GMST -> ECF  (Earth-fixed, rotates with the planet)
 *   ECI + GMST -> geodetic latitude/longitude/altitude on the WGS84 ellipsoid
 */

/**
 * How far ahead the ascending/descending test looks.
 *
 * Ten seconds is long enough for the sub-satellite latitude to change measurably
 * even for a slow geosynchronous object, and short enough that the sample stays on
 * the same side of a pole crossing for anything in low Earth orbit.
 */
const ASCENDING_PROBE_SECONDS = 10;

export interface PropagateOptions {
  /**
   * Opt in to the community decay check.
   *
   * Defaults to `true`. SGP4 will happily return a confident-looking position for an
   * object that re-entered years ago; without this check those objects appear on the
   * globe as real satellites. We would rather show "OBJECT DECAYED" than a fiction.
   */
  readonly decayCheck?: boolean;
}

/**
 * Propagate one satellite to one instant.
 *
 * Returns a discriminated result rather than throwing or returning null: propagation
 * failure is an expected outcome for a meaningful fraction of the catalog, and the
 * UI needs to distinguish "decayed" from "bad elements".
 */
export function propagateAt(
  satrec: SatRec,
  time: Date,
  options: PropagateOptions = {},
): PropagationResult {
  const decayCheck = options.decayCheck ?? true;

  const result = propagate(satrec, time, {
    communityDecayCheckEnabled: decayCheck,
  });

  if (result === null) {
    return { ok: false, failure: mapFailure(satrec.error, decayCheck) };
  }

  const gmst = gstime(time);
  const geodeticRadians = eciToGeodetic(result.position, gmst);
  const ecf = eciToEcf(result.position, gmst);

  const geodetic: GeodeticPosition = {
    latitude: toDegrees(radians(geodeticRadians.latitude)),
    // eciToGeodetic can return longitudes outside (-180, 180]; normalise once here
    // so no downstream consumer has to remember to.
    longitude: normalizeLongitude(toDegrees(radians(geodeticRadians.longitude))),
    altitude: kilometers(geodeticRadians.height),
  };

  const velocityEci: Vector3<KilometersPerSecond> = {
    x: kilometersPerSecond(result.velocity.x),
    y: kilometersPerSecond(result.velocity.y),
    z: kilometersPerSecond(result.velocity.z),
  };

  const state: SatelliteState = {
    catalogId: satrec.satnum satisfies CatalogId,
    time,
    geodetic,
    positionEci: {
      x: kilometers(result.position.x),
      y: kilometers(result.position.y),
      z: kilometers(result.position.z),
    },
    positionEcf: {
      x: kilometers(ecf.x),
      y: kilometers(ecf.y),
      z: kilometers(ecf.z),
    },
    velocityEci,
    speed: kilometersPerSecond(
      Math.hypot(result.velocity.x, result.velocity.y, result.velocity.z),
    ),
    ascending: isAscending(satrec, time, geodetic.latitude, decayCheck),
  };

  return { ok: true, state };
}

/**
 * Propagate one satellite across many instants.
 *
 * Used for orbit lines, ground tracks and pass searches. This is the pure-JS path;
 * the WASM `BulkPropagator` is used in the web worker for whole-catalog propagation,
 * where its batching pays off. For a single satellite over a few hundred samples the
 * per-call overhead of crossing into WASM outweighs the gain.
 */
export function propagateSeries(
  satrec: SatRec,
  times: readonly Date[],
  options: PropagateOptions = {},
): readonly PropagationResult[] {
  return times.map((time) => propagateAt(satrec, time, options));
}

/**
 * Generate evenly spaced sample times.
 *
 * Exists so orbit lines, ground tracks and pass searches all step time identically —
 * an off-by-one in sample spacing produces subtly wrong ground tracks that are very
 * hard to spot by eye.
 */
export function sampleTimes(
  start: Date,
  end: Date,
  stepSeconds: number,
): readonly Date[] {
  if (stepSeconds <= 0) {
    throw new RangeError(`stepSeconds must be positive, received ${stepSeconds}`);
  }

  const startMs = start.getTime();
  const endMs = end.getTime();
  if (endMs < startMs) {
    throw new RangeError("end must not precede start");
  }

  const stepMs = stepSeconds * 1000;
  const count = Math.floor((endMs - startMs) / stepMs) + 1;
  const times: Date[] = new Array<Date>(count);
  for (let index = 0; index < count; index += 1) {
    times[index] = new Date(startMs + index * stepMs);
  }
  return times;
}

/**
 * Determine whether the satellite is heading north (ascending) or south.
 *
 * Done by sampling slightly ahead rather than from the velocity vector, because the
 * sign of geodetic latitude rate is what the UI actually reports, and deriving it
 * from ECI velocity requires a frame rotation that adds error near the poles.
 */
function isAscending(
  satrec: SatRec,
  time: Date,
  currentLatitude: number,
  decayCheck: boolean,
): boolean {
  const later = new Date(time.getTime() + ASCENDING_PROBE_SECONDS * 1000);
  const ahead = propagate(satrec, later, { communityDecayCheckEnabled: decayCheck });
  if (ahead === null) return false;

  const aheadGeodetic = eciToGeodetic(ahead.position, gstime(later));
  const aheadLatitude = (aheadGeodetic.latitude * 180) / Math.PI;
  return aheadLatitude > currentLatitude;
}

/** Translate a satellite.js error code into our domain failure type. */
function mapFailure(error: SatRecError, decayCheck: boolean): PropagationFailure {
  switch (error) {
    case SatRecError.Decayed:
      return "DECAYED";
    case SatRecError.MeanEccentricityOutOfRange:
      return "MEAN_ECCENTRICITY_OUT_OF_RANGE";
    case SatRecError.MeanMotionBelowZero:
      return "MEAN_MOTION_BELOW_ZERO";
    case SatRecError.PerturbedEccentricityOutOfRange:
      return "PERTURBED_ECCENTRICITY_OUT_OF_RANGE";
    case SatRecError.SemiLatusRectumBelowZero:
      return "SEMI_LATUS_RECTUM_BELOW_ZERO";
    case SatRecError.None:
      // propagate() returned null with no SGP4 error set. With the community decay
      // check enabled that is precisely how a long-decayed object presents itself.
      return decayCheck ? "DECAYED" : "UNKNOWN";
    default:
      return "UNKNOWN";
  }
}

/** Convenience: latitude/longitude only, for ground tracks. */
export function subSatellitePoint(
  satrec: SatRec,
  time: Date,
  options: PropagateOptions = {},
): { latitude: number; longitude: number } | undefined {
  const result = propagateAt(satrec, time, options);
  if (!result.ok) return undefined;
  return {
    latitude: result.state.geodetic.latitude,
    longitude: result.state.geodetic.longitude,
  };
}

/** Altitude helper used by the footprint calculation. */
export function altitudeAt(
  satrec: SatRec,
  time: Date,
  options: PropagateOptions = {},
): Kilometers | undefined {
  const result = propagateAt(satrec, time, options);
  return result.ok ? result.state.geodetic.altitude : undefined;
}


/** One catalog object's outcome from a bulk propagation pass. */
/**
 * One satellite's position and velocity in the Earth-fixed frame, for bulk rendering.
 *
 * ECEF rather than geodetic because that is what a renderer actually consumes: Cesium
 * takes a Cartesian3 in the fixed frame, so emitting latitude/longitude here would mean
 * converting to geodetic and immediately back again, 16,000 times per tick.
 *
 * Velocity is included so the caller can interpolate between propagation ticks.
 * Propagating the whole catalogue every animation frame is not affordable, but SGP4
 * computes velocity anyway, so carrying it costs nothing and lets a consumer advance
 * positions smoothly at display rate between ticks.
 */
export interface BulkPositionResult {
  readonly catalogId: CatalogId;
  readonly ok: boolean;
  /** Earth-fixed position, kilometres. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Earth-fixed velocity, km/s: the true time derivative of the position above. */
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
}

/**
 * Earth's rotation rate, radians per second (IERS).
 *
 * Needed to turn an inertial velocity into an Earth-fixed one. See below.
 */
const EARTH_ROTATION_RAD_PER_S = 7.2921159e-5;

/**
 * Propagate many satellites to one instant, position and velocity only.
 *
 * This is the whole-catalog path: the globe needs 10,000+ points at low frequency, and
 * the full `SatelliteState` (geodetic, speed, ascending flag) that `propagateAt`
 * computes is wasted work when only a point is going to be drawn. `propagateAt` remains
 * the single-satellite path, used for the selected object's telemetry panel where the
 * extra fields are actually read.
 *
 * A failed satellite is included with `ok: false` and zeroed vectors rather than
 * omitted, so the caller's output stays index-aligned with its input — dropping entries
 * would require every consumer to re-derive which catalog id a given output slot belongs
 * to.
 */
export function propagateManyAt(
  satrecs: readonly SatRec[],
  time: Date,
): readonly BulkPositionResult[] {
  const gmst = gstime(time);
  const results: BulkPositionResult[] = new Array(satrecs.length);

  for (let index = 0; index < satrecs.length; index += 1) {
    const satrec = satrecs[index] as SatRec;
    const propagated = propagate(satrec, time, { communityDecayCheckEnabled: true });

    if (propagated === null) {
      results[index] = {
        catalogId: satrec.satnum satisfies CatalogId,
        ok: false,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
      };
      continue;
    }

    const position = eciToEcf(propagated.position, gmst);
    const rotated = eciToEcf(propagated.velocity, gmst);

    // Rotating the inertial velocity into Earth-fixed axes is NOT the Earth-fixed
    // velocity: it still describes motion relative to an inertial observer. The
    // derivative of the Earth-fixed position also carries the frame's own rotation,
    // so subtract omega x r, with omega = (0, 0, w):
    //
    //     omega x r = (-w * r.y, w * r.x, 0)
    //
    // Omitting this looks harmless and is not — it leaves roughly 0.5 km/s of error at
    // LEO altitude, which shows up as every satellite steadily sliding in longitude.
    results[index] = {
      catalogId: satrec.satnum satisfies CatalogId,
      ok: true,
      x: position.x,
      y: position.y,
      z: position.z,
      vx: rotated.x + EARTH_ROTATION_RAD_PER_S * position.y,
      vy: rotated.y - EARTH_ROTATION_RAD_PER_S * position.x,
      vz: rotated.z,
    };
  }

  return results;
}
