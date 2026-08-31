import type { SatRec } from "satellite.js";

import {
  illuminationAt,
  observerLighting,
  type ObserverLighting,
} from "./illumination.js";
import { lookAnglesAt } from "./look-angles.js";
import type { PropagateOptions } from "./propagation.js";
import type { CompassPoint, IlluminationState, LookAngles, ObserverLocation } from "./types.js";
import type { Degrees, Kilometers } from "./units.js";

/**
 * Pass prediction.
 *
 * Computed locally with SGP4. No third-party pass API is involved, which is what lets
 * the product work offline from cached elements and lets the user's observer location
 * stay on their device.
 *
 * ALGORITHM
 *   1. Step coarsely through the interval, evaluating elevation.
 *   2. Detect sign changes across the minimum-elevation threshold — these bracket
 *      acquisition (AOS) and loss (LOS) of signal.
 *   3. Refine each crossing by bisection to sub-second accuracy.
 *   4. Locate maximum elevation inside the bracket by ternary search.
 *   5. Evaluate geometry and lighting at AOS, maximum and LOS.
 *
 * WHY BISECTION AND TERNARY SEARCH
 * Elevation as a function of time is smooth and single-peaked within a pass, so it is
 * unimodal — exactly the precondition ternary search needs. Crossing detection is a
 * root-find on a monotonic segment, which bisection handles robustly without needing
 * derivatives.
 */

export interface PassPredictionOptions extends PropagateOptions {
  /**
   * Minimum elevation that counts as a pass, in degrees.
   *
   * 10 degrees is a common default: below that, terrain, buildings and atmospheric
   * extinction make a pass largely academic.
   */
  readonly minimumElevation?: number;
  /**
   * Coarse search step, in seconds.
   *
   * Must be comfortably shorter than the shortest pass, or a pass can be stepped over
   * entirely. A very low LEO pass at the horizon lasts a few minutes, so 30 seconds
   * leaves a wide margin. Raising this materially risks missing short passes.
   */
  readonly coarseStepSeconds?: number;
  /** Stop after this many passes. Guards against unbounded work over long ranges. */
  readonly maximumPasses?: number;
}

/** Geometry at one notable instant during a pass. */
export interface PassPoint {
  readonly time: Date;
  readonly azimuth: Degrees;
  readonly compass: CompassPoint;
  readonly elevation: Degrees;
  readonly range: Kilometers;
}

/**
 * How likely the pass is to be seen with the naked eye.
 *
 * Deliberately categorical. A numeric magnitude would require a per-object brightness
 * model (size, shape, attitude, albedo) that public catalogs do not provide, so
 * quoting one would be inventing precision we do not have.
 */
export type VisibilityClassification =
  | "LIKELY_VISIBLE"
  | "POSSIBLY_VISIBLE"
  | "NOT_OPTICALLY_FAVOURABLE"
  | "DAYLIGHT"
  | "SATELLITE_IN_SHADOW";

export interface SatellitePass {
  readonly aos: PassPoint;
  readonly maximum: PassPoint;
  readonly los: PassPoint;
  readonly durationSeconds: number;
  /** Closest approach during the pass, which occurs at maximum elevation. */
  readonly minimumRange: Kilometers;
  /** Spacecraft illumination at maximum elevation. */
  readonly illumination: IlluminationState | undefined;
  /** Sky brightness at the observer at maximum elevation. */
  readonly observerLighting: ObserverLighting;
  readonly visibility: VisibilityClassification;
}

/**
 * Maximum elevation below which a pass is not worth calling visible even under
 * perfect lighting. Low passes sit in haze and are usually blocked by terrain.
 */
const LIKELY_VISIBLE_MIN_ELEVATION = 30;

/** Bisection stops once the bracket is this small. */
const REFINEMENT_TOLERANCE_MS = 500;

/** Ternary search stops once the bracket is this small. */
const PEAK_TOLERANCE_MS = 1000;

/**
 * Predict passes of a satellite over an observer.
 *
 * Returns passes whose maximum elevation reaches `minimumElevation`. A pass already
 * in progress at `start` is reported with its AOS clamped to `start`.
 */
export function predictPasses(
  satrec: SatRec,
  observer: ObserverLocation,
  start: Date,
  end: Date,
  options: PassPredictionOptions = {},
): readonly SatellitePass[] {
  const {
    minimumElevation = 10,
    coarseStepSeconds = 30,
    maximumPasses = 100,
    ...propagateOptions
  } = options;

  if (end.getTime() <= start.getTime()) {
    throw new RangeError("Pass prediction end must be after start");
  }
  if (coarseStepSeconds <= 0) {
    throw new RangeError("coarseStepSeconds must be positive");
  }

  const elevationAt = (time: Date): number | undefined =>
    lookAnglesAt(satrec, observer, time, propagateOptions)?.elevation;

  const passes: SatellitePass[] = [];
  const stepMs = coarseStepSeconds * 1000;

  let previousTime = start;
  let previousElevation = elevationAt(start);
  // Tracks the start of a pass currently in progress.
  let ascendingCrossing: Date | undefined =
    previousElevation !== undefined && previousElevation >= minimumElevation
      ? start
      : undefined;

  for (
    let currentMs = start.getTime() + stepMs;
    currentMs <= end.getTime() && passes.length < maximumPasses;
    currentMs += stepMs
  ) {
    const currentTime = new Date(currentMs);
    const currentElevation = elevationAt(currentTime);

    if (currentElevation === undefined || previousElevation === undefined) {
      previousTime = currentTime;
      previousElevation = currentElevation;
      continue;
    }

    const wasBelow = previousElevation < minimumElevation;
    const isBelow = currentElevation < minimumElevation;

    if (wasBelow && !isBelow) {
      // Rising through the threshold: refine to find AOS.
      ascendingCrossing = refineCrossing(
        elevationAt,
        previousTime,
        currentTime,
        minimumElevation,
        true,
      );
    } else if (!wasBelow && isBelow && ascendingCrossing !== undefined) {
      // Falling through the threshold: refine to find LOS and emit the pass.
      const los = refineCrossing(
        elevationAt,
        previousTime,
        currentTime,
        minimumElevation,
        false,
      );

      const pass = buildPass(
        satrec,
        observer,
        ascendingCrossing,
        los,
        propagateOptions,
      );
      if (pass !== undefined) passes.push(pass);
      ascendingCrossing = undefined;
    }

    previousTime = currentTime;
    previousElevation = currentElevation;
  }

  // A pass still in progress when the window closes is reported, truncated at `end`,
  // rather than silently dropped — "the ISS is overhead right now" is exactly what a
  // user most wants to know.
  if (ascendingCrossing !== undefined && passes.length < maximumPasses) {
    const pass = buildPass(satrec, observer, ascendingCrossing, end, propagateOptions);
    if (pass !== undefined) passes.push(pass);
  }

  return passes;
}

/**
 * Refine a threshold crossing by bisection.
 *
 * `rising` says which side of the bracket is below the threshold, so the same routine
 * handles both AOS and LOS.
 */
function refineCrossing(
  elevationAt: (time: Date) => number | undefined,
  before: Date,
  after: Date,
  threshold: number,
  rising: boolean,
): Date {
  let lowMs = before.getTime();
  let highMs = after.getTime();

  while (highMs - lowMs > REFINEMENT_TOLERANCE_MS) {
    const midMs = Math.floor((lowMs + highMs) / 2);
    const elevation = elevationAt(new Date(midMs));

    if (elevation === undefined) {
      // Cannot evaluate here; accept the current bracket rather than looping forever.
      break;
    }

    const above = elevation >= threshold;
    // When rising, the crossing lies after the last below-threshold sample.
    if (above === rising) {
      highMs = midMs;
    } else {
      lowMs = midMs;
    }
  }

  return new Date(rising ? highMs : lowMs);
}

/**
 * Locate maximum elevation within a pass by ternary search.
 *
 * Valid because elevation is unimodal across a single pass: it rises monotonically to
 * a peak and falls monotonically after.
 */
function findPeak(
  elevationAt: (time: Date) => number | undefined,
  start: Date,
  end: Date,
): Date {
  let lowMs = start.getTime();
  let highMs = end.getTime();

  while (highMs - lowMs > PEAK_TOLERANCE_MS) {
    const third = (highMs - lowMs) / 3;
    const leftMs = Math.floor(lowMs + third);
    const rightMs = Math.floor(highMs - third);

    const left = elevationAt(new Date(leftMs));
    const right = elevationAt(new Date(rightMs));

    if (left === undefined || right === undefined) break;

    if (left < right) {
      lowMs = leftMs;
    } else {
      highMs = rightMs;
    }
  }

  return new Date(Math.floor((lowMs + highMs) / 2));
}

function buildPass(
  satrec: SatRec,
  observer: ObserverLocation,
  aosTime: Date,
  losTime: Date,
  propagateOptions: PropagateOptions,
): SatellitePass | undefined {
  const elevationAt = (time: Date): number | undefined =>
    lookAnglesAt(satrec, observer, time, propagateOptions)?.elevation;

  const maximumTime = findPeak(elevationAt, aosTime, losTime);

  const aosAngles = lookAnglesAt(satrec, observer, aosTime, propagateOptions);
  const maxAngles = lookAnglesAt(satrec, observer, maximumTime, propagateOptions);
  const losAngles = lookAnglesAt(satrec, observer, losTime, propagateOptions);

  if (aosAngles === undefined || maxAngles === undefined || losAngles === undefined) {
    return undefined;
  }

  const illumination = illuminationAt(satrec, maximumTime, propagateOptions);
  const lighting = observerLighting(observer, maximumTime);

  return {
    aos: toPassPoint(aosTime, aosAngles),
    maximum: toPassPoint(maximumTime, maxAngles),
    los: toPassPoint(losTime, losAngles),
    durationSeconds: Math.round((losTime.getTime() - aosTime.getTime()) / 1000),
    // Range is minimised at maximum elevation, since that is the closest approach.
    minimumRange: maxAngles.range,
    illumination: illumination?.state,
    observerLighting: lighting,
    visibility: classifyVisibility(
      illumination?.state,
      lighting,
      maxAngles.elevation,
    ),
  };
}

function toPassPoint(time: Date, angles: LookAngles): PassPoint {
  return {
    time,
    azimuth: angles.azimuth,
    compass: angles.compass,
    elevation: angles.elevation,
    range: angles.range,
  };
}

/**
 * Classify optical visibility from transparent, stated criteria.
 *
 * The rule is the classic one for naked-eye satellite spotting: the spacecraft must
 * be in sunlight while the observer is in darkness. Each branch corresponds to a
 * physical reason a pass can or cannot be seen, so the UI can explain itself.
 */
export function classifyVisibility(
  illumination: IlluminationState | undefined,
  lighting: ObserverLighting,
  maximumElevation: number,
): VisibilityClassification {
  // Daylight at the observer washes out all but the very brightest objects.
  if (lighting === "DAYLIGHT") return "DAYLIGHT";

  // An unlit satellite reflects nothing, however dark the sky is.
  if (illumination === "UMBRA") return "SATELLITE_IN_SHADOW";

  if (illumination === "SUNLIT" && maximumElevation >= LIKELY_VISIBLE_MIN_ELEVATION) {
    return "LIKELY_VISIBLE";
  }

  if (illumination === "SUNLIT" || illumination === "PENUMBRA") {
    return "POSSIBLY_VISIBLE";
  }

  return "NOT_OPTICALLY_FAVOURABLE";
}

/** Human-readable explanation of a classification, for tooltips. */
export function describeVisibility(classification: VisibilityClassification): string {
  switch (classification) {
    case "LIKELY_VISIBLE":
      return "The satellite is in sunlight, your sky is dark, and the pass reaches a useful elevation.";
    case "POSSIBLY_VISIBLE":
      return "Conditions are marginal — the satellite is lit and your sky is dark, but the pass is low or the spacecraft is entering shadow.";
    case "DAYLIGHT":
      return "It is too bright at your location; only exceptionally bright objects are visible in daylight.";
    case "SATELLITE_IN_SHADOW":
      return "The satellite is in Earth's shadow during this pass, so it reflects no sunlight.";
    case "NOT_OPTICALLY_FAVOURABLE":
      return "This pass is not favourable for visual observation.";
  }
}

/** Build an observer-agnostic empty result, for UI states with no location set. */
export const NO_PASSES: readonly SatellitePass[] = [];
