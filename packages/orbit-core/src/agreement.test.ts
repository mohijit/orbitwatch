import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ANGLE_TOLERANCE_DEGREES,
  compareAgreement,
  computeAgreement,
  runAgreement,
  type AgreementCase,
  type AgreementResult,
} from "./agreement.js";

/**
 * The Node half of the M6 cross-platform gate.
 *
 * This proves agreement between the committed expectation and this engine. The browser
 * half runs the same suite in Chromium through Playwright, and the device half runs it
 * under Hermes from a screen in the native app. All three compare against the same
 * committed file, never against each other — two platforms agreeing with one another
 * is exactly what you would see if both were wrong in the same way, which a shared
 * library makes the likeliest failure of all.
 */

const repoRoot = resolve(process.cwd(), "..", "..");

const fixture = JSON.parse(
  readFileSync(resolve(repoRoot, "fixtures", "cross-platform-agreement.json"), "utf8"),
) as { cases: AgreementCase[]; expected: AgreementResult[] };

describe("cross-platform agreement", () => {
  it("covers deep-space and near-earth propagation, and several latitudes", () => {
    // A suite that quietly shrank would still pass every assertion below it, so the
    // shape of the corpus is asserted before its contents.
    expect(fixture.cases.length).toBe(16);
    expect(new Set(fixture.cases.map((one) => one.id.split("-")[0])).size).toBe(4);

    // GEO and MEO objects exceed the 225-minute period that routes propagation through
    // SDP4 rather than SGP4. Without one, half the library is untested here.
    expect(fixture.cases.some((one) => one.id.startsWith("tdrs3"))).toBe(true);
    expect(fixture.cases.some((one) => one.id.startsWith("les5"))).toBe(true);
  });

  it("agrees with the committed expectation on this engine", () => {
    const report = runAgreement(fixture.cases, fixture.expected);

    // Reported rather than merely asserted: when this fails, the deviation list is the
    // diagnosis, and a bare "expected true" would throw it away.
    expect(report.deviations).toEqual([]);
    expect(report.agreed).toBe(true);
    expect(report.casesChecked).toBe(16);
    expect(report.quantitiesChecked).toBeGreaterThan(600);
  });

  it("leaves headroom: real engine noise is far inside the tolerances", () => {
    const report = runAgreement(fixture.cases, fixture.expected);

    // The tolerances are only meaningful if they are not quietly absorbing a real
    // difference. On the engine that generated the fixture the deviation should be
    // nil, and this pins that rather than assuming it.
    expect(report.worstRatio).toBeLessThan(0.01);
  });

  it("fails when a platform disagrees by more than the tolerance", () => {
    // The suite has to be able to go red, or it is decoration. A tenth of a degree is
    // about 11 km on the ground — a difference a user would see.
    const tampered: AgreementResult[] = fixture.expected.map((result, index) =>
      index !== 0
        ? result
        : {
            ...result,
            samples: result.samples.map((sample, sampleIndex) =>
              sampleIndex !== 0 ? sample : { ...sample, azimuth: sample.azimuth + 0.1 },
            ),
          },
    );

    const report = compareAgreement(tampered, fixture.cases.map(computeAgreement));
    expect(report.agreed).toBe(false);
    expect(report.deviations).toHaveLength(1);
    expect(report.deviations[0]?.quantity).toContain("azimuth");
    expect(report.deviations[0]?.difference).toBeCloseTo(0.1, 6);
    expect(report.deviations[0]?.tolerance).toBe(ANGLE_TOLERANCE_DEGREES);
  });

  it("does not report a disagreement across the antimeridian", () => {
    // +179.9999999 and -179.9999999 are the same place. Subtracting them naively gives
    // 359.9999998, which would fail every object over the Pacific.
    const shifted: AgreementResult[] = fixture.expected.map((result) => ({
      ...result,
      samples: result.samples.map((sample) => ({
        ...sample,
        // Re-express every longitude in [0, 360) instead of [-180, 180). Same
        // positions, different convention.
        longitude: sample.longitude < 0 ? sample.longitude + 360 : sample.longitude,
      })),
    }));

    const report = compareAgreement(shifted, fixture.cases.map(computeAgreement));
    const longitudeDeviations = report.deviations.filter((one) =>
      one.quantity.includes("longitude"),
    );
    expect(longitudeDeviations).toEqual([]);
  });

  it("reports a missing case rather than skipping it", () => {
    // A platform that fails to run a case must not be able to pass by omission.
    const report = compareAgreement(fixture.expected, fixture.cases.slice(1).map(computeAgreement));
    expect(report.agreed).toBe(false);
    expect(report.deviations[0]?.quantity).toBe("case-missing");
  });
});
