import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { OMMJsonObject } from "satellite.js";

import { computeAgreement, type AgreementCase } from "../agreement.js";

/**
 * Generate the committed cross-platform agreement fixture.
 *
 * WHY GENERATED, AND WHY COMMITTED
 * The expected values have to come from somewhere. Computing them on each platform and
 * comparing platforms to each other would pass trivially the day every platform is
 * wrong in the same way — which is precisely what a shared library makes likely. So one
 * run, on one engine, is frozen into a file, and every platform is then measured
 * against that fixed thing. A change in the numbers becomes a reviewable diff rather
 * than an invisible drift.
 *
 * The elements are real records already committed under `fixtures/`, with provenance in
 * `fixtures/manifest.json`. Nothing here invents an orbit.
 *
 *   pnpm --filter @orbitwatch/orbit-core exec tsx src/cli/generate-agreement-fixture.ts
 */

const repoRoot = resolve(process.cwd(), "..", "..");
const SOURCE = resolve(repoRoot, "fixtures", "celestrak-gp-e2e-subset.json");
const OUTPUT = resolve(repoRoot, "fixtures", "cross-platform-agreement.json");

/**
 * Four objects spanning four orbit regimes, deliberately.
 *
 * SGP4 and SDP4 are different propagators: anything with a period above 225 minutes
 * takes the deep-space path, with lunar and solar perturbations the near-earth path
 * never touches. A suite of low-orbit objects would leave that whole half of the
 * library unverified across platforms. HEO adds a high-eccentricity case, where the
 * geometry changes fastest and small differences have the most room to grow.
 */
const CASE_OBJECTS = [
  { catalogId: "25544", id: "iss-leo" },
  { catalogId: "19548", id: "tdrs3-geo" },
  { catalogId: "2866", id: "les5-meo" },
  { catalogId: "23439", id: "rosto-heo" },
] as const;

/**
 * Three observers chosen for the geometry they break, not for where people live.
 *
 * The equator and a high northern latitude bracket the range where the topocentric
 * transform behaves differently, and the antimeridian observer is there because a
 * longitude either side of the date line is the classic place for a sign convention to
 * differ between two implementations without anyone noticing.
 */
const OBSERVERS = [
  { label: "Sydney", latitude: -33.8688, longitude: 151.2093, altitudeKm: 0.058 },
  { label: "Quito", latitude: -0.1807, longitude: -78.4678, altitudeKm: 2.85 },
  { label: "Tromso", latitude: 69.6492, longitude: 18.9553, altitudeKm: 0.01 },
  { label: "Antimeridian", latitude: 0, longitude: 179.9, altitudeKm: 0 },
] as const;

/** Epoch of the fixture's ISS record: the anchor every instant is relative to. */
function anchorInstant(records: readonly OMMJsonObject[]): Date {
  const iss = records.find(
    (record) => String((record as { NORAD_CAT_ID?: unknown }).NORAD_CAT_ID) === "25544",
  );
  if (iss === undefined) throw new Error("The source fixture has no ISS record.");
  // CelesTrak's EPOCH carries no zone designator and is UTC.
  return new Date(`${String((iss as { EPOCH: string }).EPOCH)}Z`);
}

function main(): void {
  const records = JSON.parse(readFileSync(SOURCE, "utf8")) as OMMJsonObject[];
  const anchor = anchorInstant(records);

  // Hours from the anchor. Zero is at epoch, where SGP4 is most accurate; the rest
  // spread across a day and a half so the deep-space perturbation terms have time to
  // matter and any divergence has time to accumulate.
  const OFFSET_HOURS = [0, 0.25, 3, 12, 36];

  const cases: AgreementCase[] = [];
  for (const { catalogId, id } of CASE_OBJECTS) {
    const omm = records.find(
      (record) => String((record as { NORAD_CAT_ID?: unknown }).NORAD_CAT_ID) === catalogId,
    );
    if (omm === undefined) {
      throw new Error(
        `${catalogId} is not in the source fixture. A re-export changed the corpus; ` +
          `update CASE_OBJECTS rather than dropping the case.`,
      );
    }

    for (const observer of OBSERVERS) {
      cases.push({
        id: `${id}-${observer.label.toLowerCase()}`,
        omm,
        observer,
        instants: OFFSET_HOURS.map((hours) =>
          new Date(anchor.getTime() + hours * 3_600_000).toISOString(),
        ),
        passWindow: {
          start: anchor.toISOString(),
          end: new Date(anchor.getTime() + 24 * 3_600_000).toISOString(),
        },
      });
    }
  }

  const expected = cases.map(computeAgreement);

  const fixture = {
    generatedFrom: "fixtures/celestrak-gp-e2e-subset.json",
    note:
      "Expected values for the cross-platform agreement suite. Generated once on Node " +
      "(V8) and committed; every platform is measured against these numbers rather " +
      "than against another platform's run. Regenerate only when the source elements " +
      "change, and review the diff.",
    anchor: anchor.toISOString(),
    cases,
    expected,
  };

  writeFileSync(OUTPUT, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

  const samples = expected.reduce((total, result) => total + result.samples.length, 0);
  const passes = expected.reduce((total, result) => total + result.passes.length, 0);
  console.log(
    `Wrote ${OUTPUT}\n  ${String(cases.length)} cases, ` +
      `${String(samples)} sampled instants, ${String(passes)} passes.`,
  );
}

main();
