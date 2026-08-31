import type { SatRec } from "satellite.js";

import { propagateAt, sampleTimes, type PropagateOptions } from "./propagation.js";
import type { GeodeticPosition } from "./types.js";
import {
  EARTH_RADIUS_KM,
  degrees,
  kilometers,
  normalizeLongitude,
  toDegrees,
  toRadians,
  type Degrees,
  type Kilometers,
} from "./units.js";

/**
 * Ground tracks and horizon footprints.
 *
 * THE ANTIMERIDIAN PROBLEM
 * ------------------------
 * A ground track is a sequence of sub-satellite points. When the satellite crosses
 * 180 degrees longitude, consecutive points jump from about +179 to about -179. Drawn
 * naively, the renderer connects them with a line straight back across the entire
 * map — the single most recognisable bug in satellite tracking software.
 *
 * The fix is to detect the discontinuity and split the track into segments. We detect
 * it by longitude DELTA rather than by proximity to 180, because the latter also
 * triggers for a satellite legitimately flying near the antimeridian without crossing
 * it, and misses nothing that the delta test catches.
 */

/**
 * Longitude change between consecutive samples that indicates a wrap rather than
 * real motion.
 *
 * No Earth-orbiting satellite covers 180 degrees of longitude between samples at any
 * sane sampling rate, so a jump larger than this can only be the coordinate wrap.
 * Even a geostationary satellite moves under 0.25 degrees per minute.
 */
const ANTIMERIDIAN_JUMP_THRESHOLD = 180;

export interface GroundTrackPoint {
  readonly time: Date;
  readonly latitude: Degrees;
  readonly longitude: Degrees;
  readonly altitude: Kilometers;
}

/**
 * A ground track split into continuous segments.
 *
 * Renderers should draw each segment as its own polyline. A single-segment track
 * means the satellite never crossed the antimeridian over the sampled interval.
 */
export interface GroundTrack {
  readonly segments: readonly (readonly GroundTrackPoint[])[];
  readonly pointCount: number;
}

export interface GroundTrackOptions extends PropagateOptions {
  /** Seconds between samples. Smaller values give a smoother line at higher cost. */
  readonly stepSeconds?: number;
}

/**
 * Compute a ground track between two times.
 *
 * Default step is 30 seconds: for a LEO satellite that is roughly 2 degrees of arc
 * per sample, which draws smoothly without generating tens of thousands of points.
 */
export function groundTrack(
  satrec: SatRec,
  start: Date,
  end: Date,
  options: GroundTrackOptions = {},
): GroundTrack {
  const { stepSeconds = 30, ...propagateOptions } = options;

  const points: GroundTrackPoint[] = [];
  for (const time of sampleTimes(start, end, stepSeconds)) {
    const result = propagateAt(satrec, time, propagateOptions);
    // A gap (a decayed or unpropagatable interval) also breaks continuity, and is
    // handled by the segmentation below because the points simply are not there.
    if (!result.ok) continue;

    points.push({
      time,
      latitude: result.state.geodetic.latitude,
      longitude: result.state.geodetic.longitude,
      altitude: result.state.geodetic.altitude,
    });
  }

  return { segments: splitAtAntimeridian(points), pointCount: points.length };
}

/**
 * Split a point sequence wherever it crosses the antimeridian.
 *
 * Exported separately so it can be tested directly and reused by any consumer that
 * already has points — the mobile renderer, for instance, receives points over the
 * bridge and re-segments them rather than re-propagating.
 */
export function splitAtAntimeridian(
  points: readonly GroundTrackPoint[],
): readonly (readonly GroundTrackPoint[])[] {
  if (points.length === 0) return [];

  const segments: GroundTrackPoint[][] = [];
  let current: GroundTrackPoint[] = [];

  for (const [index, point] of points.entries()) {
    if (index === 0) {
      current.push(point);
      continue;
    }

    // `index > 0` guarantees a previous element exists.
    const previous = points[index - 1] as GroundTrackPoint;
    const delta = Math.abs(point.longitude - previous.longitude);

    if (delta > ANTIMERIDIAN_JUMP_THRESHOLD) {
      // Close the current segment and start a new one. We deliberately do NOT
      // interpolate a point exactly on the antimeridian: the two segments end and
      // begin within one sample step of the boundary, which is visually seamless,
      // and inserting a synthetic point would put a fabricated coordinate into data
      // that is otherwise entirely propagated.
      segments.push(current);
      current = [point];
      continue;
    }

    current.push(point);
  }

  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * Angular radius of the region of Earth visible from a given altitude.
 *
 * Geometry: for a satellite at radius r = Re + h, the horizon is where the line of
 * sight is tangent to the sphere, giving a central angle of arccos(Re / r). This is
 * the ideal geometric horizon and ignores refraction and terrain.
 */
export function footprintAngularRadius(altitude: Kilometers): number {
  const orbitRadius = EARTH_RADIUS_KM + altitude;
  if (orbitRadius <= EARTH_RADIUS_KM) return 0;
  return Math.acos(EARTH_RADIUS_KM / orbitRadius);
}

/** Radius of the visible ground circle, measured along Earth's surface. */
export function footprintRadiusKm(altitude: Kilometers): Kilometers {
  return kilometers(footprintAngularRadius(altitude) * EARTH_RADIUS_KM);
}

/**
 * Compute the footprint circle as a closed ring of geodetic points.
 *
 * Uses the standard destination-point formula on a sphere, walking a full circle of
 * bearings around the sub-satellite point. Longitudes are normalised, so a footprint
 * spanning the antimeridian must be segmented with {@link splitAtAntimeridian} before
 * being drawn on a flat map. On a 3D globe no segmentation is needed.
 */
export function footprintRing(
  centre: GeodeticPosition,
  pointCount = 128,
): readonly { latitude: Degrees; longitude: Degrees }[] {
  if (pointCount < 3) {
    throw new RangeError(`A footprint ring needs at least 3 points, got ${pointCount}`);
  }

  const angularRadius = footprintAngularRadius(centre.altitude);
  if (angularRadius <= 0) return [];

  const centreLatitude = toRadians(centre.latitude);
  const centreLongitude = toRadians(centre.longitude);

  const sinLat = Math.sin(centreLatitude);
  const cosLat = Math.cos(centreLatitude);
  const sinRadius = Math.sin(angularRadius);
  const cosRadius = Math.cos(angularRadius);

  const ring: { latitude: Degrees; longitude: Degrees }[] = [];
  for (let index = 0; index < pointCount; index += 1) {
    const bearing = (2 * Math.PI * index) / pointCount;

    const latitude = Math.asin(sinLat * cosRadius + cosLat * sinRadius * Math.cos(bearing));
    const longitude =
      centreLongitude +
      Math.atan2(
        Math.sin(bearing) * sinRadius * cosLat,
        cosRadius - sinLat * Math.sin(latitude),
      );

    ring.push({
      latitude: toDegrees(latitude as never),
      longitude: normalizeLongitude(toDegrees(longitude as never)),
    });
  }

  // Close the ring so consumers can draw it without special-casing the last edge.
  const first = ring[0];
  if (first !== undefined) ring.push(first);

  return ring;
}

/** Convenience: the footprint of a satellite at a given time. */
export function footprintAt(
  satrec: SatRec,
  time: Date,
  options: PropagateOptions & { pointCount?: number } = {},
): {
  readonly centre: GeodeticPosition;
  readonly radiusKm: Kilometers;
  readonly ring: readonly { latitude: Degrees; longitude: Degrees }[];
} | undefined {
  const { pointCount = 128, ...propagateOptions } = options;
  const result = propagateAt(satrec, time, propagateOptions);
  if (!result.ok) return undefined;

  const centre = result.state.geodetic;
  return {
    centre,
    radiusKm: footprintRadiusKm(centre.altitude),
    ring: footprintRing(centre, pointCount),
  };
}

/** Build a geodetic position from plain degrees, for footprint helpers. */
export function geodetic(
  latitude: number,
  longitude: number,
  altitudeKm: number,
): GeodeticPosition {
  return {
    latitude: degrees(latitude),
    longitude: degrees(longitude),
    altitude: kilometers(altitudeKm),
  };
}
