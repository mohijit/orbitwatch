import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  normalizeObjectType,
  normalizeOperationalStatus,
  parseGpResponse,
  parseSatcatResponse,
} from "./celestrak.js";

/**
 * Parsing tests built from REAL CelesTrak responses.
 *
 * These complete the verification gate: a successful request alone is not verification,
 * and neither is a schema that merely compiles. The fixtures are unmodified production
 * payloads captured from CI (celestrak.org is unreachable from the development network)
 * with provenance recorded in fixtures/manifest.json.
 *
 * The schemas were adjusted to fit these responses, never the reverse.
 */

const FIXTURES = join(process.cwd(), "..", "..", "fixtures");

const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

describe("CelesTrak GP, real response", () => {
  const payload = readFixture("celestrak-gp-iss.json");

  it("validates without a single rejected record", () => {
    const { records, rejected } = parseGpResponse(payload);
    expect(rejected).toEqual([]);
    expect(records).toHaveLength(1);
  });

  it("carries an EPOCH with no timezone designator", () => {
    const { records } = parseGpResponse(payload);
    // The documented shape says nothing about this. It is UTC, so parsing it with a
    // bare new Date() silently applies the host's offset -- a bug that passes in CI
    // and moves the satellite by hours anywhere east or west of UTC.
    expect(records[0]?.EPOCH).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+$/);
    expect(records[0]?.EPOCH).not.toMatch(/Z|[+-]\d{2}:?\d{2}$/);
  });

  it("sends NORAD_CAT_ID as a JSON number", () => {
    const { records } = parseGpResponse(payload);
    // Space-Track sends a string for the same field, so both are accepted. It is
    // stored as text regardless: Alpha-5 ids are not integers (ADR 0004).
    expect(typeof records[0]?.NORAD_CAT_ID).toBe("number");
  });
});

describe("CelesTrak SATCAT, real response", () => {
  const payload = readFixture("celestrak-satcat-iss.json");

  it("validates without a single rejected record", () => {
    const { records, rejected } = parseSatcatResponse(payload);
    expect(rejected).toEqual([]);
    expect(records).toHaveLength(1);
  });

  it("normalises an empty DECAY_DATE to undefined", () => {
    const { records } = parseSatcatResponse(payload);
    // The live response sends "" rather than null for absent values. Left as an empty
    // string it reads as present, and the ISS -- very much still in orbit -- would be
    // recorded as decayed and dropped from the catalog.
    expect(records[0]?.DECAY_DATE).toBeUndefined();
    expect(records[0]?.DATA_STATUS_CODE).toBeUndefined();
  });

  it("uses short codes the normalisers understand", () => {
    const { records } = parseSatcatResponse(payload);
    expect(records[0]?.OBJECT_TYPE).toBe("PAY");
    expect(normalizeObjectType(records[0]?.OBJECT_TYPE)).toBe("PAYLOAD");
    expect(records[0]?.OPS_STATUS_CODE).toBe("+");
    expect(normalizeOperationalStatus(records[0]?.OPS_STATUS_CODE)).toBe("OPERATIONAL");
  });

  it("keeps the fields the catalog view depends on", () => {
    const { records } = parseSatcatResponse(payload);
    const iss = records[0];
    expect(iss?.OBJECT_NAME).toBe("ISS (ZARYA)");
    expect(iss?.OBJECT_ID).toBe("1998-067A");
    expect(iss?.LAUNCH_DATE).toBe("1998-11-20");
    expect(iss?.LAUNCH_SITE).toBe("TYMSC");
    expect(iss?.RCS).toBeCloseTo(399.0524, 4);
  });
});
