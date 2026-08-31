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
  propagateSeries,
  sampleTimes,
  subSatellitePoint,
  type PropagateOptions,
} from "./propagation.js";

// Re-exported so consumers never need a direct satellite.js dependency, which keeps
// the SGP4 implementation swappable and the version pinned in exactly one place.
export type { OMMJsonObject, SatRec } from "satellite.js";
