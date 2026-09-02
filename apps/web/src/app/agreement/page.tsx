"use client";

import { runAgreement, type AgreementCase, type AgreementResult } from "@orbitwatch/orbit-core";
import Link from "next/link";
import { useMemo } from "react";

import fixture from "../../../../../fixtures/cross-platform-agreement.json";

/**
 * Cross-platform agreement, verified in the browser you are reading this in.
 *
 * M6 requires that identical elements, observer and timestamp produce identical
 * positions, look angles and pass times on every platform. This page is the browser
 * half of that gate: it runs the suite in your own JavaScript engine and reports the
 * result, rather than asking you to believe a badge.
 *
 * WHY THIS IS NOT REDUNDANT WITH THE UNIT TEST
 * The Node test proves agreement under the engine that generated the expectation, which
 * is the weakest of the three checks. This one runs the same code through the app's own
 * bundler, in a browser, on the user's hardware — a different engine build, different
 * optimisation tiers, and the actual shipped bundle rather than TypeScript sources.
 *
 * The mobile app carries the same screen, which is where the interesting engine is:
 * Hermes delegates several Math functions to the platform's libm and is the most
 * likely of the three to differ.
 *
 * The comparison is always against the committed file, never against another platform.
 * Two platforms agreeing with each other is exactly what would be observed if both
 * were wrong in the same way, which a shared library makes the likeliest failure mode.
 */

const suite = fixture as unknown as {
  anchor: string;
  cases: AgreementCase[];
  expected: AgreementResult[];
};

export default function AgreementPage() {
  // Roughly a second of SGP4 across sixteen cases. Memoised so a re-render does not
  // repeat it; there is no reason to run it more than once per visit.
  const report = useMemo(() => runAgreement(suite.cases, suite.expected), []);

  return (
    <main className="prose-page">
      <p className="prose-page__back">
        <Link href="/">← Back to the globe</Link>
      </p>

      <h1>Cross-platform agreement</h1>

      <p className="prose-page__lead">
        OrbitWatch computes every position on your own device, from published orbital
        elements, using one shared implementation. This page checks that this browser
        gets the same answers as every other platform — run just now, in your engine.
      </p>

      <p
        className={`agreement__verdict agreement__verdict--${report.agreed ? "ok" : "fail"}`}
        data-testid="agreement-verdict"
      >
        {report.agreed
          ? `Agreement confirmed across ${String(report.casesChecked)} cases and ` +
            `${String(report.quantitiesChecked)} quantities.`
          : `Disagreement in ${String(report.deviations.length)} of ` +
            `${String(report.quantitiesChecked)} quantities.`}
      </p>

      <p data-testid="agreement-headroom">
        Largest deviation observed: {(report.worstRatio * 100).toPrecision(3)}% of the
        allowed tolerance.
      </p>

      {report.agreed ? null : (
        <table className="prose-page__table">
          <thead>
            <tr>
              <th>Case</th>
              <th>Quantity</th>
              <th>Expected</th>
              <th>This engine</th>
              <th>Difference</th>
            </tr>
          </thead>
          <tbody>
            {report.deviations.slice(0, 40).map((deviation, index) => (
              <tr key={index}>
                <td>{deviation.caseId}</td>
                <td>{deviation.quantity}</td>
                <td>{deviation.expected}</td>
                <td>{deviation.actual}</td>
                <td>{deviation.difference.toExponential(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>What is being compared</h2>
      <p>
        Sixteen cases: four real objects across four orbital regimes — the ISS in low
        orbit, TDRS 3 in geostationary, LES-5 in medium orbit and RADIO ROSTO in a
        highly elliptical one — each against four observing locations chosen for the
        geometry they stress rather than for where people live: Sydney, Quito on the
        equator, Tromsø inside the Arctic circle, and a point on the antimeridian.
      </p>
      <p>
        Objects above a 225-minute period are propagated by SDP4 rather than SGP4, with
        lunar and solar perturbations the near-earth model never applies. Including
        geostationary and medium orbits is what stops half the library going unchecked.
      </p>
      <p>
        For each pair, five instants spanning a day and a half from the element epoch are
        evaluated for latitude, longitude, altitude, azimuth, elevation and range, and a
        24-hour pass search is compared on acquisition, maximum and loss times plus peak
        elevation.
      </p>

      <h2>Why the test is not bit-for-bit</h2>
      <p>
        The same source runs on at least three JavaScript engines: V8 in Chrome and
        Node, JavaScriptCore on iOS, and Hermes in the native apps. Their{" "}
        <code>Math</code> implementations are not identical — Hermes hands several
        functions to the platform&rsquo;s C library — so results can differ in the last
        few digits. That is not a defect in any of them.
      </p>
      <p>
        So agreement is defined physically: platforms agree when they would send an
        observer to the same place at the same moment. Angles must match to a
        millionth of a degree (about 11 cm on the ground), distances to a metre, and
        pass times to a second. Every one of those is far tighter than the accuracy of
        the orbital elements themselves, so a real divergence still fails loudly.
      </p>
    </main>
  );
}
