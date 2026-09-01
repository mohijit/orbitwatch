/**
 * @orbitwatch/orbit-core
 *
 * The shared orbital-mechanics engine. This package is deliberately free of React,
 * DOM, Cesium and React Native dependencies so that web, native, web workers, the
 * API server and the test suite all run the exact same code. That is what makes the
 * cross-platform agreement tests meaningful: if web and iOS disagree about where a
 * satellite is, the bug is in the caller, not in two divergent implementations.
 */

export * from "./units.js";
export * from "./types.js";

export {
  ElementParseError,
  normalizeCatalogId,
  parseOmm,
  parseTle,
  parseUtcTimestamp,
  type ParsedElements,
  type ParseOmmOptions,
  type ParseTleOptions,
} from "./elements.js";

export {
  classifyOrbit,
  deriveOrbitGeometry,
  describeOrbitClass,
  periodMinutes,
  type ClassifyOrbitInput,
} from "./orbit-class.js";

export {
  altitudeAt,
  propagateAt,
  propagateManyAt,
  propagateSeries,
  sampleTimes,
  subSatellitePoint,
  type BulkPositionResult,
  type PropagateOptions,
} from "./propagation.js";

// Re-exported so consumers never need a direct satellite.js dependency, which keeps
// the SGP4 implementation swappable and the version pinned in exactly one place.
export type { OMMJsonObject, SatRec } from "satellite.js";

export {
  azimuthToCompass,
  dopplerFactorAt,
  lookAnglesAt,
  observerAt,
} from "./look-angles.js";

export {
  ASTRONOMICAL_TWILIGHT_DEGREES,
  CIVIL_TWILIGHT_DEGREES,
  classifyShadow,
  illuminationAt,
  nextDarkness,
  observerLighting,
  sunAltitudeDegrees,
  type DarknessWindow,
  type ObserverLighting,
} from "./illumination.js";

export {
  footprintAngularRadius,
  footprintAt,
  footprintRadiusKm,
  footprintRing,
  geodetic,
  groundTrack,
  splitAtAntimeridian,
  type GroundTrack,
  type GroundTrackOptions,
  type GroundTrackPoint,
} from "./ground-track.js";

export {
  classifyVisibility,
  describeVisibility,
  predictPasses,
  NO_PASSES,
  type PassPoint,
  type PassPredictionOptions,
  type SatellitePass,
  type VisibilityClassification,
} from "./passes.js";

export {
  assessAccuracy,
  formatDuration,
  isEffectivelyLive,
  selectBestElements,
  type AccuracyAssessment,
  type DatedElementSet,
  type ElementSelection,
  type PropagationConfidence,
} from "./accuracy.js";
