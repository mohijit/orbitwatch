import type { OMMJsonObject } from "satellite.js";

import { parseOmm } from "./elements.js";
import { lookAnglesAt, observerAt } from "./look-angles.js";
import { predictPasses } from "./passes.js";
import { propagateAt } from "./propagation.js";

/**
 * Cross-platform agreement: the same inputs must produce the same sky, everywhere.
 *
 * WHAT THIS ACTUALLY GUARDS AGAINST
 * Web, mobile, the ingestion worker and the API all compute positions from this one
 * package, so it is tempting to call agreement automatic. It is not. The same source
 * runs on four different JavaScript engines — V8 in Chrome and Node, JavaScriptCore on
 * iOS Safari, and Hermes on both native platforms — and they do not agree bit for bit.
 * `Math.sin`, `Math.pow` and friends are implemented per engine, and Hermes in
 * particular delegates to the platform's libm. Date parsing and number formatting
 * differ too. None of that is a bug in any engine; all of it can move a computed
 * azimuth in the last few digits, and an equality assertion would fail on a user's
 * phone for a reason nobody could reproduce on a laptop.
 *
 * SO THE ASSERTION IS PHYSICAL, NOT BITWISE
 * Two platforms agree when they would send an observer to the same place at the same
 * time — not when their doubles are identical. Every tolerance below is a physical
 * quantity with a reason, and each is orders of magnitude tighter than the underlying
 * SGP4 model's own accuracy, so a real divergence still fails loudly.
 *
 * HOW IT RUNS
 * This module has no imports outside `orbit-core` and touches no DOM, filesystem,
 * network or timer. That is what lets the identical function run under vitest on Node,
 * inside a browser through Playwright, and on a device under Hermes — comparing all of
 * them against one committed set of expected values rather than against each other,
 * which would only prove that two runs of the same code agree.
 */

// --- tolerances -------------------------------------------------------------------

/**
 * Angles: one microdegree.
 *
 * About 0.11 m on the ground, and roughly ten thousand times finer than the pointing
 * accuracy of any telescope mount a person aims by hand. Engine-level libm differences
 * land near 1e-13 degrees, so this leaves a wide margin above the noise and still
 * catches any divergence a human could ever observe.
 */
export const ANGLE_TOLERANCE_DEGREES = 1e-6;

/**
 * Distances: one metre.
 *
 * The satellite is hundreds to tens of thousands of kilometres away and the elements
 * themselves are good to a kilometre at best, so a metre is far inside the noise of
 * the physics while being far outside the noise of the arithmetic.
 */
export const DISTANCE_TOLERANCE_KM = 1e-3;

/**
 * Pass times: one second.
 *
 * Acquisition and loss of signal are found by bisection to a 500 ms bracket, so two
 * engines can legitimately settle on either side of it. One second is the smallest
 * threshold that does not simply re-test the search's own stopping rule, and it is
 * still far below the minute-scale error that ageing elements introduce.
 */
export const TIME_TOLERANCE_MS = 1000;

// --- the cases --------------------------------------------------------------------

export interface AgreementObserver {
  readonly label: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly altitudeKm: number;
}

export interface AgreementCase {
  readonly id: string;
  /**
   * The object's real published OMM record, verbatim.
   *
   * Embedded in the fixture rather than referenced by catalog number, because an
   * agreement fixture must be self-contained: the whole point is that a device with no
   * database and no network can run it and get the same answer.
   */
  readonly omm: OMMJsonObject;
  readonly observer: AgreementObserver;
  /** ISO instants to evaluate the state and look angles at. */
  readonly instants: readonly string[];
  /** Pass search window, as ISO instants. */
  readonly passWindow: { readonly start: string; readonly end: string };
}

/** One computed sample: where it is, and where to point. */
export interface AgreementSample {
  readonly instant: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly altitudeKm: number;
  readonly azimuth: number;
  readonly elevation: number;
  readonly rangeKm: number;
}

export interface AgreementPass {
  readonly aosMs: number;
  readonly maxMs: number;
  readonly losMs: number;
  readonly maxElevation: number;
}

export interface AgreementResult {
  readonly id: string;
  readonly samples: readonly AgreementSample[];
  readonly passes: readonly AgreementPass[];
}

/**
 * Compute every quantity the fixture pins, for one case.
 *
 * Deliberately exercises the whole chain a user's screen depends on — parse, propagate,
 * transform to geodetic, transform to topocentric, then search for passes — rather than
 * a single primitive. A divergence in any one step is a divergence in the answer.
 */
export function computeAgreement(testCase: AgreementCase): AgreementResult {
  const { satrec } = parseOmm(testCase.omm);
  const observer = observerAt(
    testCase.observer.latitude,
    testCase.observer.longitude,
    testCase.observer.altitudeKm,
    testCase.observer.label,
  );

  const samples: AgreementSample[] = [];
  for (const instant of testCase.instants) {
    const at = new Date(instant);
    const state = propagateAt(satrec, at);
    const angles = lookAnglesAt(satrec, observer, at);

    if (!state.ok || angles === undefined) {
      throw new Error(
        `Agreement case ${testCase.id} could not be propagated at ${instant}. ` +
          `A case that does not compute cannot demonstrate agreement.`,
      );
    }

    samples.push({
      instant,
      latitude: state.state.geodetic.latitude,
      longitude: state.state.geodetic.longitude,
      altitudeKm: state.state.geodetic.altitude,
      azimuth: angles.azimuth,
      elevation: angles.elevation,
      rangeKm: angles.range,
    });
  }

  const passes = predictPasses(
    satrec,
    observer,
    new Date(testCase.passWindow.start),
    new Date(testCase.passWindow.end),
    { minimumElevation: 10 },
  ).map((pass) => ({
    aosMs: pass.aos.time.getTime(),
    maxMs: pass.maximum.time.getTime(),
    losMs: pass.los.time.getTime(),
    maxElevation: pass.maximum.elevation,
  }));

  return { id: testCase.id, samples, passes };
}

// --- comparison -------------------------------------------------------------------

export interface AgreementDeviation {
  readonly caseId: string;
  readonly quantity: string;
  readonly expected: number;
  readonly actual: number;
  readonly difference: number;
  readonly tolerance: number;
}

export interface AgreementReport {
  readonly agreed: boolean;
  readonly casesChecked: number;
  readonly quantitiesChecked: number;
  readonly deviations: readonly AgreementDeviation[];
  /** Largest observed difference as a fraction of its tolerance, across everything. */
  readonly worstRatio: number;
}

/**
 * Longitude difference across the antimeridian.
 *
 * Two engines that both place a satellite at the date line can report +179.9999999 and
 * -179.9999999, which are the same place and differ by 359.9999998 if subtracted
 * naively. Without this, the suite would report a catastrophic disagreement for objects
 * that happen to be over the Pacific.
 */
function angularDifference(expected: number, actual: number): number {
  const raw = Math.abs(expected - actual);
  return raw > 180 ? 360 - raw : raw;
}

/**
 * Compare a computed result against the committed expectation.
 *
 * Returns every deviation rather than throwing on the first, because a platform that
 * disagrees usually disagrees about many things at once and the pattern is the
 * diagnosis: all azimuths off means the topocentric transform, one instant off means
 * a date-parsing difference, everything off means the parse.
 */
export function compareAgreement(
  expected: readonly AgreementResult[],
  actual: readonly AgreementResult[],
): AgreementReport {
  const deviations: AgreementDeviation[] = [];
  let quantitiesChecked = 0;
  let worstRatio = 0;

  const check = (
    caseId: string,
    quantity: string,
    expectedValue: number,
    actualValue: number,
    tolerance: number,
    angular = false,
  ): void => {
    quantitiesChecked += 1;
    const difference = angular
      ? angularDifference(expectedValue, actualValue)
      : Math.abs(expectedValue - actualValue);
    worstRatio = Math.max(worstRatio, difference / tolerance);
    if (difference > tolerance) {
      deviations.push({
        caseId,
        quantity,
        expected: expectedValue,
        actual: actualValue,
        difference,
        tolerance,
      });
    }
  };

  const actualById = new Map(actual.map((result) => [result.id, result]));

  for (const expectedCase of expected) {
    const actualCase = actualById.get(expectedCase.id);
    if (actualCase === undefined) {
      deviations.push({
        caseId: expectedCase.id,
        quantity: "case-missing",
        expected: 1,
        actual: 0,
        difference: 1,
        tolerance: 0,
      });
      continue;
    }

    // A platform that silently produced fewer samples or found fewer passes has
    // disagreed in the most consequential way available, so count is checked first.
    if (actualCase.samples.length !== expectedCase.samples.length) {
      deviations.push({
        caseId: expectedCase.id,
        quantity: "sample-count",
        expected: expectedCase.samples.length,
        actual: actualCase.samples.length,
        difference: Math.abs(expectedCase.samples.length - actualCase.samples.length),
        tolerance: 0,
      });
      continue;
    }

    if (actualCase.passes.length !== expectedCase.passes.length) {
      deviations.push({
        caseId: expectedCase.id,
        quantity: "pass-count",
        expected: expectedCase.passes.length,
        actual: actualCase.passes.length,
        difference: Math.abs(expectedCase.passes.length - actualCase.passes.length),
        tolerance: 0,
      });
      continue;
    }

    for (const [index, expectedSample] of expectedCase.samples.entries()) {
      const actualSample = actualCase.samples[index];
      if (actualSample === undefined) continue;
      const where = `${expectedSample.instant}`;

      check(expectedCase.id, `${where} latitude`, expectedSample.latitude, actualSample.latitude, ANGLE_TOLERANCE_DEGREES);
      check(expectedCase.id, `${where} longitude`, expectedSample.longitude, actualSample.longitude, ANGLE_TOLERANCE_DEGREES, true);
      check(expectedCase.id, `${where} altitude`, expectedSample.altitudeKm, actualSample.altitudeKm, DISTANCE_TOLERANCE_KM);
      check(expectedCase.id, `${where} azimuth`, expectedSample.azimuth, actualSample.azimuth, ANGLE_TOLERANCE_DEGREES, true);
      check(expectedCase.id, `${where} elevation`, expectedSample.elevation, actualSample.elevation, ANGLE_TOLERANCE_DEGREES);
      check(expectedCase.id, `${where} range`, expectedSample.rangeKm, actualSample.rangeKm, DISTANCE_TOLERANCE_KM);
    }

    for (const [index, expectedPass] of expectedCase.passes.entries()) {
      const actualPass = actualCase.passes[index];
      if (actualPass === undefined) continue;
      const where = `pass ${String(index)}`;

      check(expectedCase.id, `${where} AOS`, expectedPass.aosMs, actualPass.aosMs, TIME_TOLERANCE_MS);
      check(expectedCase.id, `${where} max`, expectedPass.maxMs, actualPass.maxMs, TIME_TOLERANCE_MS);
      check(expectedCase.id, `${where} LOS`, expectedPass.losMs, actualPass.losMs, TIME_TOLERANCE_MS);
      check(expectedCase.id, `${where} max elevation`, expectedPass.maxElevation, actualPass.maxElevation, ANGLE_TOLERANCE_DEGREES);
    }
  }

  return {
    agreed: deviations.length === 0,
    casesChecked: expected.length,
    quantitiesChecked,
    deviations,
    worstRatio,
  };
}

/**
 * Run every case and compare against the expectation, in one call.
 *
 * This is the entry point a platform runs. Keeping it a single pure function of its
 * inputs is what lets the browser test, the Node test and the on-device screen share
 * one implementation instead of three that could drift apart — which would be an
 * unusually silly way to fail an agreement test.
 */
export function runAgreement(
  cases: readonly AgreementCase[],
  expected: readonly AgreementResult[],
): AgreementReport {
  return compareAgreement(expected, cases.map(computeAgreement));
}
