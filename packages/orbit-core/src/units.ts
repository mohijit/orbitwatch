/**
 * Branded unit types.
 *
 * Orbital software fails in characteristic ways: degrees passed where radians were
 * expected, metres where kilometres were expected, seconds where milliseconds were
 * expected. Each of those is a plain `number` to the compiler, so nothing catches it
 * and the result is a satellite drawn in the wrong hemisphere.
 *
 * These brands make such mixups compile errors. A `Degrees` is assignable to `number`
 * (so arithmetic and third-party interop still work), but a raw `number` is NOT
 * assignable to `Degrees` — you must pass through an explicit constructor, which is
 * where the unit assertion becomes visible in the code.
 */

declare const UNIT_BRAND: unique symbol;

type Branded<T extends number, B extends string> = T & { readonly [UNIT_BRAND]: B };

/** Angle in degrees. */
export type Degrees = Branded<number, "Degrees">;
/** Angle in radians. */
export type Radians = Branded<number, "Radians">;
/** Distance in kilometres. */
export type Kilometers = Branded<number, "Kilometers">;
/** Distance in metres. */
export type Meters = Branded<number, "Meters">;
/** Speed in kilometres per second. */
export type KilometersPerSecond = Branded<number, "KilometersPerSecond">;
/** Duration in minutes. */
export type Minutes = Branded<number, "Minutes">;
/** Duration in seconds. */
export type Seconds = Branded<number, "Seconds">;
/** Duration in milliseconds. */
export type Milliseconds = Branded<number, "Milliseconds">;
/** Angular rate in radians per minute (satellite.js mean-motion convention). */
export type RadiansPerMinute = Branded<number, "RadiansPerMinute">;
/** Revolutions per day (the TLE/OMM mean-motion convention). */
export type RevolutionsPerDay = Branded<number, "RevolutionsPerDay">;
/** Distance expressed in Earth radii (satellite.js `alta`/`altp` convention). */
export type EarthRadii = Branded<number, "EarthRadii">;

// --- Constructors -----------------------------------------------------------
// Naming is deliberately blunt: reading `kilometers(x)` at a call site tells you
// what unit the author believed `x` to be in.

export const degrees = (value: number): Degrees => value as Degrees;
export const radians = (value: number): Radians => value as Radians;
export const kilometers = (value: number): Kilometers => value as Kilometers;
export const meters = (value: number): Meters => value as Meters;
export const kilometersPerSecond = (value: number): KilometersPerSecond =>
  value as KilometersPerSecond;
export const minutes = (value: number): Minutes => value as Minutes;
export const seconds = (value: number): Seconds => value as Seconds;
export const milliseconds = (value: number): Milliseconds => value as Milliseconds;
export const radiansPerMinute = (value: number): RadiansPerMinute =>
  value as RadiansPerMinute;
export const revolutionsPerDay = (value: number): RevolutionsPerDay =>
  value as RevolutionsPerDay;
export const earthRadii = (value: number): EarthRadii => value as EarthRadii;

// --- Physical constants -----------------------------------------------------

/**
 * Equatorial Earth radius in km, WGS72 — the value baked into SGP4 itself.
 *
 * We deliberately use the SGP4 constant rather than the WGS84 value (6378.137) when
 * converting SGP4's own outputs (such as `satrec.alta`/`altp`, expressed in Earth
 * radii), so that a round-trip through those fields is self-consistent.
 */
export const EARTH_RADIUS_KM = 6378.135;

/**
 * Length of one sidereal day in minutes (23h 56m 4.0905s).
 *
 * A geosynchronous orbit has a period equal to the sidereal day, NOT the 1440-minute
 * solar day. Using 1440 here is a classic bug that misclassifies GEO satellites.
 */
export const SIDEREAL_DAY_MINUTES = 1436.06818;

/** Minutes in one solar day, for mean-motion conversions. */
export const MINUTES_PER_DAY = 1440;

/** Nominal geostationary altitude above the equator, km. */
export const GEOSTATIONARY_ALTITUDE_KM = 35786;

/** Conventional upper altitude bound of low Earth orbit, km. */
export const LEO_ALTITUDE_CEILING_KM = 2000;

// --- Conversions ------------------------------------------------------------

export const toRadians = (value: Degrees): Radians =>
  ((value * Math.PI) / 180) as Radians;

export const toDegrees = (value: Radians): Degrees =>
  ((value * 180) / Math.PI) as Degrees;

export const kilometersToMeters = (value: Kilometers): Meters =>
  (value * 1000) as Meters;

export const metersToKilometers = (value: Meters): Kilometers =>
  (value / 1000) as Kilometers;

export const earthRadiiToKilometers = (value: EarthRadii): Kilometers =>
  (value * EARTH_RADIUS_KM) as Kilometers;

/**
 * satellite.js stores mean motion in radians/minute (`satrec.no`). TLE and OMM both
 * express it in revolutions/day, so conversions between the two are frequent enough
 * to be worth naming.
 */
export const radiansPerMinuteToRevolutionsPerDay = (
  value: RadiansPerMinute,
): RevolutionsPerDay => ((value * MINUTES_PER_DAY) / (2 * Math.PI)) as RevolutionsPerDay;

export const revolutionsPerDayToRadiansPerMinute = (
  value: RevolutionsPerDay,
): RadiansPerMinute => ((value * 2 * Math.PI) / MINUTES_PER_DAY) as RadiansPerMinute;

/** Orbital period from mean motion. */
export const periodFromMeanMotion = (value: RadiansPerMinute): Minutes =>
  ((2 * Math.PI) / value) as Minutes;

/**
 * Normalise an angle into [0, 360).
 *
 * Azimuths and RAAN values arrive from several sources and can be slightly negative
 * or slightly over 360 after arithmetic; displaying "-0.3°" as a compass bearing is
 * wrong, so normalisation is centralised here.
 */
export const normalizeDegrees = (value: Degrees): Degrees => {
  const wrapped = value % 360;
  return (wrapped < 0 ? wrapped + 360 : wrapped) as Degrees;
};

/**
 * Normalise a longitude into (-180, 180].
 *
 * Ground tracks cross the antimeridian constantly; keeping every longitude in one
 * canonical range is what makes the ±180° split logic in `ground-track.ts` reliable.
 */
export const normalizeLongitude = (value: Degrees): Degrees => {
  let wrapped = ((value + 180) % 360) as number;
  if (wrapped < 0) wrapped += 360;
  const result = wrapped - 180;
  // The modulo maps exactly +180 to -180. The stated range is (-180, 180], and the
  // antimeridian reads more naturally as +180 on a ground track heading east, so
  // snap that single boundary value back.
  return (result === -180 ? 180 : result) as Degrees;
};
