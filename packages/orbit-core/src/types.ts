import type {
  Degrees,
  Kilometers,
  KilometersPerSecond,
  Minutes,
  RevolutionsPerDay,
} from "./units.js";

/**
 * Core domain types.
 *
 * Everything downstream — web, native, worker, API — speaks these types. They are
 * deliberately free of any provider's naming conventions: CelesTrak's `OBJECT_NAME`
 * and SatNOGS's `name` both normalise to `name` here.
 */

/**
 * NORAD catalog identifier.
 *
 * Modelled as a STRING, not a number. The catalog has outgrown the five-digit field
 * of the legacy TLE format, and the successor "Alpha-5" encoding uses a leading
 * letter (e.g. `A0001` = 100001). Storing these as numbers loses that encoding and
 * silently corrupts identifiers above 99999. satellite.js likewise types
 * `SatRec.satnum` as a string.
 */
export type CatalogId = string;

/** How an object is classified in the catalog. */
export type ObjectType = "PAYLOAD" | "ROCKET BODY" | "DEBRIS" | "UNKNOWN";

/** Broad orbit regime. See `orbit-class.ts` for how this is derived. */
export type OrbitClass = "LEO" | "MEO" | "GEO" | "GSO" | "HEO" | "HIGH" | "UNKNOWN";

/** Illumination state of a spacecraft relative to Earth's shadow. */
export type IlluminationState = "SUNLIT" | "PENUMBRA" | "UMBRA";

/** Which source a piece of data came from, for provenance display. */
export type DataProvider =
  | "celestrak"
  | "satnogs"
  | "launch-library"
  | "noaa-swpc"
  | "nasa"
  | "wheretheiss"
  | "user-import";

/** The wire format the elements originally arrived in. */
export type ElementFormat = "OMM_JSON" | "TLE";

/**
 * A normalized set of orbital elements plus the provenance needed to be honest about
 * them in the UI.
 *
 * `epoch` and `retrievedAt` are distinct and BOTH matter: `epoch` is when the
 * elements describe the orbit, `retrievedAt` is when we obtained them. A satellite
 * can have elements retrieved two minutes ago whose epoch is eighteen hours old.
 */
export interface OrbitalElements {
  readonly catalogId: CatalogId;
  readonly name: string;
  /** International designator, e.g. "1998-067A". */
  readonly internationalDesignator: string | undefined;
  /** When these elements describe the orbit. */
  readonly epoch: Date;
  /** When OrbitWatch obtained them from the provider. */
  readonly retrievedAt: Date;
  readonly provider: DataProvider;
  readonly format: ElementFormat;

  readonly meanMotion: RevolutionsPerDay;
  readonly eccentricity: number;
  readonly inclination: Degrees;
  readonly raan: Degrees;
  readonly argumentOfPerigee: Degrees;
  readonly meanAnomaly: Degrees;
  /** Ballistic drag coefficient, inverse Earth radii. */
  readonly bstar: number;
  readonly elementSetNumber: number | undefined;
  readonly revolutionAtEpoch: number | undefined;
  readonly classification: string | undefined;

  /** Original OMM payload, retained verbatim for the DATA tab and debugging. */
  readonly rawOmm: Readonly<Record<string, unknown>> | undefined;
  /** Original TLE lines when the source was a TLE. */
  readonly rawTle: readonly [string, string] | undefined;
}

/** Derived orbit geometry that does not depend on propagation time. */
export interface OrbitGeometry {
  readonly period: Minutes;
  readonly apogeeAltitude: Kilometers;
  readonly perigeeAltitude: Kilometers;
  readonly semiMajorAxis: Kilometers;
  readonly orbitClass: OrbitClass;
}

/** A 3-vector in a named reference frame. */
export interface Vector3<T extends number> {
  readonly x: T;
  readonly y: T;
  readonly z: T;
}

/** Geodetic position on/above the WGS84 ellipsoid. */
export interface GeodeticPosition {
  readonly latitude: Degrees;
  readonly longitude: Degrees;
  readonly altitude: Kilometers;
}

/**
 * A fully propagated satellite state at one instant.
 *
 * `time` is the instant this state describes. It is NOT necessarily "now" — the same
 * type is produced when scrubbing the timeline to next Tuesday, which is exactly why
 * the UI must never label a state "LIVE" based on the state alone.
 */
export interface SatelliteState {
  readonly catalogId: CatalogId;
  readonly time: Date;
  readonly geodetic: GeodeticPosition;
  /** Earth-Centered Inertial position (TEME frame), km. */
  readonly positionEci: Vector3<Kilometers>;
  /** Earth-Centered Earth-Fixed position, km. */
  readonly positionEcf: Vector3<Kilometers>;
  /** ECI velocity, km/s. */
  readonly velocityEci: Vector3<KilometersPerSecond>;
  /** Scalar speed, km/s. */
  readonly speed: KilometersPerSecond;
  /** True when the sub-satellite latitude is increasing. */
  readonly ascending: boolean;
}

/** An observer on the Earth's surface. */
export interface ObserverLocation {
  readonly latitude: Degrees;
  readonly longitude: Degrees;
  /** Height above the ellipsoid. Defaults conservatively to 0 when unknown. */
  readonly altitude: Kilometers;
  /** Optional human-readable label, e.g. "Sydney, Australia". */
  readonly label?: string;
}

/** Satellite position as seen from an observer. */
export interface LookAngles {
  readonly azimuth: Degrees;
  /** 16-point compass abbreviation derived from azimuth, e.g. "SW". */
  readonly compass: CompassPoint;
  readonly elevation: Degrees;
  readonly range: Kilometers;
  /** Positive = receding, negative = approaching. */
  readonly rangeRate: KilometersPerSecond;
  readonly aboveHorizon: boolean;
}

export type CompassPoint =
  | "N" | "NNE" | "NE" | "ENE"
  | "E" | "ESE" | "SE" | "SSE"
  | "S" | "SSW" | "SW" | "WSW"
  | "W" | "WNW" | "NW" | "NNW";

/**
 * Why a propagation attempt produced no state.
 *
 * SGP4 genuinely fails for some catalog objects — decayed debris especially — and
 * the UI needs to say which failure occurred rather than showing an empty panel.
 */
export type PropagationFailure =
  | "DECAYED"
  | "MEAN_ECCENTRICITY_OUT_OF_RANGE"
  | "MEAN_MOTION_BELOW_ZERO"
  | "PERTURBED_ECCENTRICITY_OUT_OF_RANGE"
  | "SEMI_LATUS_RECTUM_BELOW_ZERO"
  | "UNKNOWN";

export type PropagationResult =
  | { readonly ok: true; readonly state: SatelliteState }
  | { readonly ok: false; readonly failure: PropagationFailure };
