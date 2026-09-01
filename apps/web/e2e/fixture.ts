import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Facts about the corpus the E2E suite runs against.
 *
 * The suite is seeded from `fixtures/celestrak-gp-e2e-subset.json`: 32 real CelesTrak
 * GP records exported from data this project ingested (provenance in
 * `fixtures/manifest.json`). Reading the file here rather than restating its contents
 * means a re-export cannot leave the tests quietly asserting stale numbers — they fail
 * instead, which is the correct outcome.
 *
 * WHY THE CLOCK IS PINNED
 * Every accuracy claim this product makes is relative to an element epoch, so any
 * assertion about accuracy, or about scrubbing to an instant before the data begins,
 * silently changes meaning as real time moves away from the fixture. Pinning the
 * browser clock to a fixed instant makes those assertions mean the same thing in a
 * year as they do today. Only the observer's clock is pinned; not one element value is
 * altered, and the app is fed exactly the data CelesTrak published.
 */

const repoRoot = resolve(process.cwd(), "..", "..");

interface OmmRecord {
  readonly NORAD_CAT_ID: number | string;
  readonly OBJECT_NAME: string;
  readonly EPOCH: string;
}

export const FIXTURE_RECORDS: readonly OmmRecord[] = JSON.parse(
  readFileSync(resolve(repoRoot, "fixtures", "celestrak-gp-e2e-subset.json"), "utf8"),
) as OmmRecord[];

/** How many objects the whole pipeline must carry, end to end. */
export const FIXTURE_OBJECT_COUNT = FIXTURE_RECORDS.length;

/**
 * The instant the browser clock is pinned to: 2026-08-31T23:00:00Z.
 *
 * Chosen to sit shortly after the fixture's retrieval time (22:51:21Z), so the app is
 * exercised in its normal state — freshly retrieved elements, a few hours past epoch —
 * rather than in a degraded one. Against the ISS epoch of 11:11:23Z that is 11.8 hours,
 * comfortably inside the LEO nominal band, and it places the two scrub targets used
 * below either side of that epoch.
 */
export const PINNED_CLOCK = new Date("2026-08-31T23:00:00.000Z");

/**
 * Timeline slider positions, as fractions of the ±48 h scrub range.
 *
 * Expressed as offsets from {@link PINNED_CLOCK} so the arithmetic is visible: the
 * slider is linear over ±48 h, so fraction = 0.5 + hours / 96.
 */
export const SCRUB = {
  /** −9.6 h → 2026-08-31T13:24Z, AFTER the ISS epoch, so replay resolves. */
  resolvable: 0.4,
  /** −28.8 h → 2026-08-30T18:12Z, BEFORE it, so replay must report no data. */
  beforeData: 0.2,
} as const;

export interface ExpectedObject {
  readonly catalogId: string;
  readonly name: string;
  /**
   * The orbit class the app must derive from this object's elements.
   *
   * Written out by hand rather than computed with `deriveOrbitGeometry`, which is the
   * function under test: asserting a value against the code that produced it proves
   * only that the code is deterministic. These came from the export tool's report and
   * are independently checkable against the published orbits.
   */
  readonly orbitClass: "LEO" | "MEO" | "GEO" | "GSO" | "HEO" | "UNKNOWN";
}

/**
 * One object per orbit class the fixture contains.
 *
 * This is the set the multi-object tests walk. It matters that the classes differ:
 * the accuracy bands are keyed on orbit class, and a bug that returns one class for
 * everything — as `undefined` once did — is invisible unless the corpus spans several.
 *
 * CLUSTER II-FM8 is genuinely UNKNOWN: its mean elements put perigee below the
 * surface, so the classifier declines to name a regime rather than guessing. Keeping a
 * real example of that is more useful than a corpus of tidy orbits.
 */
export const EXPECTED_OBJECTS: readonly ExpectedObject[] = [
  { catalogId: "25544", name: "ISS (ZARYA)", orbitClass: "LEO" },
  { catalogId: "8820", name: "LAGEOS 1", orbitClass: "MEO" },
  { catalogId: "19548", name: "TDRS 3", orbitClass: "GEO" },
  { catalogId: "41241", name: "IRNSS-1E", orbitClass: "GSO" },
  { catalogId: "25989", name: "XMM-NEWTON", orbitClass: "HEO" },
  { catalogId: "26464", name: "CLUSTER II-FM8 (TANGO)", orbitClass: "UNKNOWN" },
];

/**
 * The age the telemetry panel must report for one object, as it formats it.
 *
 * Computed here from the fixture's own EPOCH and {@link PINNED_CLOCK}, so it is an
 * independent expectation rather than a restatement of whatever the app produced — and
 * so a re-export updates it automatically instead of leaving a stale literal.
 *
 * Whole hours: every object in this corpus sits between one and forty-eight hours from
 * the pinned instant, which is the band the app renders as `Nh`. An object outside that
 * band would need minutes or days here.
 */
export function expectedEpochAge(catalogId: string): string {
  const record = fixtureRecord(catalogId);
  // CelesTrak's EPOCH carries no timezone designator and is UTC. Parsing it without
  // the Z applies the host's offset and silently shifts the age by hours.
  const epoch = new Date(`${record.EPOCH}Z`);
  const hours = Math.abs(PINNED_CLOCK.getTime() - epoch.getTime()) / 3_600_000;
  return `${String(Math.round(hours))}h`;
}

/** Look a fixture record up by catalog id, failing loudly if the corpus changed. */
export function fixtureRecord(catalogId: string): OmmRecord {
  const record = FIXTURE_RECORDS.find(
    (candidate) => String(candidate.NORAD_CAT_ID) === catalogId,
  );
  if (record === undefined) {
    throw new Error(
      `${catalogId} is not in celestrak-gp-e2e-subset.json. Re-export changed the ` +
        `corpus; update EXPECTED_OBJECTS rather than loosening the assertions.`,
    );
  }
  return record;
}
