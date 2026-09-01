import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Facts about the corpus the E2E suite runs against.
 *
 * The suite is seeded from two files, both real CelesTrak records exported from data
 * this project ingested (provenance in `fixtures/manifest.json`):
 *
 *   celestrak-gp-e2e-subset.json  a subset of one GROUP=active response — the catalog
 *   celestrak-gp-e2e-visual.json  a subset of one GROUP=visual response — the objects
 *                                 CelesTrak curates as bright enough to see by eye
 *
 * Reading them here rather than restating their contents means a re-export cannot
 * leave the tests quietly asserting stale numbers.
 *
 * WHY THE CLOCK IS PINNED
 * Every accuracy claim this product makes is relative to an element epoch, and every
 * visibility claim is relative to where the sun is. Both change meaning as real time
 * moves away from the fixture, so unpinned assertions would slowly stop testing
 * anything. Only the observer's clock is pinned; not one element value is altered.
 */

const repoRoot = resolve(process.cwd(), "..", "..");

interface OmmRecord {
  readonly NORAD_CAT_ID: number | string;
  readonly OBJECT_NAME: string;
  readonly EPOCH: string;
}

function readFixture(name: string): readonly OmmRecord[] {
  return JSON.parse(readFileSync(resolve(repoRoot, "fixtures", name), "utf8")) as OmmRecord[];
}

export const FIXTURE_RECORDS = readFixture("celestrak-gp-e2e-subset.json");
export const VISUAL_RECORDS = readFixture("celestrak-gp-e2e-visual.json");

/** How many objects the whole pipeline must carry, end to end. */
export const FIXTURE_OBJECT_COUNT = FIXTURE_RECORDS.length;

/** How many of those are in CelesTrak's `visual` group. */
export const VISUAL_OBJECT_COUNT = VISUAL_RECORDS.length;

/** Look a fixture record up by catalog id, failing loudly if the corpus changed. */
export function fixtureRecord(catalogId: string): OmmRecord {
  const record = FIXTURE_RECORDS.find(
    (candidate) => String(candidate.NORAD_CAT_ID) === catalogId,
  );
  if (record === undefined) {
    throw new Error(
      `${catalogId} is not in celestrak-gp-e2e-subset.json. A re-export changed the ` +
        `corpus; update EXPECTED_OBJECTS rather than loosening the assertions.`,
    );
  }
  return record;
}

/**
 * CelesTrak's EPOCH carries no timezone designator and is UTC. Parsing it without the
 * Z applies the host's offset and silently shifts everything by hours.
 */
function epochOf(record: OmmRecord): Date {
  return new Date(`${record.EPOCH}Z`);
}

/**
 * How far after the ISS epoch to pin the clock.
 *
 * Derived rather than written as a literal, because a re-export moves every epoch and
 * a hard-coded instant would silently stop lining up with the data. Two constraints
 * pick the number:
 *
 *   * The timeline scrubs +/-48 h, so fraction 0.4 is -9.6 h and 0.2 is -28.8 h from
 *     the pinned instant. Sitting between those puts one scrub target after the ISS
 *     epoch (historical replay resolves) and the other before it (replay correctly
 *     reports no data). Any offset in (9.6, 28.8) satisfies that.
 *
 *   * Within that range, 18 h places the pinned instant mid-morning in Sydney, which
 *     puts the NEXT darkness window at that evening's dusk. Dusk is when a satellite
 *     is still sunlit while the observer is dark — the only geometry in which anything
 *     is visible to the naked eye, and the case "Visible Tonight" exists to serve.
 *     Pinning to the middle of the night instead put every object in Earth's shadow
 *     and produced an empty list: correct physics, useless demonstration.
 */
const PINNED_OFFSET_HOURS = 18;

export const PINNED_CLOCK = new Date(
  epochOf(fixtureRecord("25544")).getTime() + PINNED_OFFSET_HOURS * 3_600_000,
);

/**
 * Timeline slider positions, as fractions of the +/-48 h scrub range.
 *
 * The slider is linear over +/-48 h, so fraction = 0.5 + hours / 96.
 */
export const SCRUB = {
  /** -9.6 h, AFTER the ISS epoch, so historical replay resolves. */
  resolvable: 0.4,
  /** -28.8 h, BEFORE it, so replay must report no data. */
  beforeData: 0.2,
} as const;

export interface ExpectedObject {
  readonly catalogId: string;
  readonly name: string;
  /**
   * The orbit class the app must derive from this object's elements.
   *
   * Written out by hand rather than computed with `deriveOrbitGeometry`, which is the
   * function under test. Each is independently checkable against the published orbit:
   * TDRS 3 and SDO sit at geosynchronous altitude, LES-5 and the GPS constellation are
   * medium Earth orbit, RS15 is a Molniya-like ellipse, and the ISS is the canonical
   * low Earth orbit.
   */
  readonly orbitClass: "LEO" | "MEO" | "GEO" | "GSO" | "HEO" | "HIGH" | "UNKNOWN";
}

/**
 * One object per orbit class the corpus contains.
 *
 * The classes must differ: accuracy bands are keyed on orbit class, and a bug that
 * returns one class for everything — as `undefined` once did — is invisible unless the
 * corpus spans several.
 */
export const EXPECTED_OBJECTS: readonly ExpectedObject[] = [
  { catalogId: "25544", name: "ISS (ZARYA)", orbitClass: "LEO" },
  { catalogId: "2866", name: "LES-5", orbitClass: "MEO" },
  { catalogId: "19548", name: "TDRS 3", orbitClass: "GEO" },
  { catalogId: "36395", name: "SDO", orbitClass: "GSO" },
  { catalogId: "23439", name: "RADIO ROSTO (RS15)", orbitClass: "HEO" },
  { catalogId: "47242", name: "IPM 2 & BREEZE-M R/B", orbitClass: "HIGH" },
];

/**
 * The age the telemetry panel must report for one object, as it formats it.
 *
 * Computed from the fixture's own EPOCH and {@link PINNED_CLOCK}, so it is an
 * independent expectation rather than a restatement of what the app produced, and a
 * re-export updates it automatically instead of leaving a stale literal.
 *
 * Whole hours: every object in this corpus sits between one and forty-eight hours from
 * the pinned instant, which is the band the app renders as `Nh`.
 */
export function expectedEpochAge(catalogId: string): string {
  const hours =
    Math.abs(PINNED_CLOCK.getTime() - epochOf(fixtureRecord(catalogId)).getTime()) /
    3_600_000;
  return `${String(Math.round(hours))}h`;
}
