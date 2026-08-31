import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isUsableTransmitter,
  parseSatnogsSatellitesResponse,
  parseSatnogsTransmittersResponse,
} from "./satnogs.js";

/**
 * Parsing tests built from REAL SatNOGS DB responses.
 *
 * SatNOGS is unreachable from the development network (TLS completes, then zero bytes
 * before timeout), so these were captured from CI, which has ordinary access. Fixtures
 * are unmodified production payloads; provenance is in fixtures/manifest.json. The
 * schema was fixed to match these responses, never the reverse.
 */

const FIXTURES = join(process.cwd(), "..", "..", "fixtures");
const readFixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

describe("SatNOGS satellites, real response", () => {
  const payload = readFixture("satnogs-satellite-iss.json");

  it("validates without a single rejected record", () => {
    const { records, rejected } = parseSatnogsSatellitesResponse(payload);
    expect(rejected).toEqual([]);
    expect(records).toHaveLength(1);
  });

  it("distinguishes sat_id (SatNOGS's own id) from norad_cat_id", () => {
    const { records } = parseSatnogsSatellitesResponse(payload);
    // The join key back to our catalog is norad_cat_id. sat_id is an unrelated opaque
    // identifier, and treating it as a catalog number would silently break every join.
    expect(records[0]?.sat_id).toBe("XSKZ-5603-1870-9019-3066");
    expect(records[0]?.norad_cat_id).toBe(25544);
  });

  it("accepts a free-form status string beyond the documented enum", () => {
    // The real response sends "in orbit", which is not in most third-party docs of
    // this API (they list alive/dead/future/re-entered). Requiring the documented set
    // would reject the ISS itself.
    const { records } = parseSatnogsSatellitesResponse(payload);
    expect(records[0]?.status).toBe("in orbit");
  });

  it("keeps the fields the transmitter panel depends on", () => {
    const { records } = parseSatnogsSatellitesResponse(payload);
    const iss = records[0];
    expect(iss?.name).toBe("ISS");
    expect(iss?.names).toContain("ZARYA");
    expect(iss?.decayed).toBeNull();
  });
});

describe("SatNOGS transmitters, real response", () => {
  const payload = readFixture("satnogs-transmitters-iss.json");

  it("validates every record with none rejected", () => {
    const { records, rejected } = parseSatnogsTransmittersResponse(payload);
    expect(rejected).toEqual([]);
    // The real ISS response carries 50 transmitters.
    expect(records.length).toBeGreaterThan(0);
  });

  it("accepts null for the frequently-absent numeric fields", () => {
    const { records } = parseSatnogsTransmittersResponse(payload);
    // Several real records omit uplink_high, drift and baud. A schema that required
    // them would have rejected a large share of a legitimate response.
    expect(records.some((t) => t.uplink_high === null)).toBe(true);
    expect(records.some((t) => t.baud === null)).toBe(true);
  });

  it("keeps status (admin-set) and alive (community-set) as separate facts", () => {
    const { records } = parseSatnogsTransmittersResponse(payload);
    const first = records[0];
    expect(first?.status).toBe("active");
    expect(first?.alive).toBe(true);
    expect(isUsableTransmitter(first!)).toBe(true);
  });

  it("filters to usable transmitters only", () => {
    const { records } = parseSatnogsTransmittersResponse(payload);
    const usable = records.filter(isUsableTransmitter);
    // Every real inactive/dead transmitter observed in the fixture is excluded.
    expect(usable.every((t) => t.alive && t.status === "active")).toBe(true);
    expect(usable.length).toBeLessThanOrEqual(records.length);
  });

  it("links every transmitter back to the ISS by norad_cat_id", () => {
    const { records } = parseSatnogsTransmittersResponse(payload);
    expect(records.every((t) => t.norad_cat_id === 25544)).toBe(true);
  });
});
