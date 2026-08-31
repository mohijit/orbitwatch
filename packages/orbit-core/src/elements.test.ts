import type { OMMJsonObject } from "satellite.js";
import { describe, expect, it } from "vitest";

import { ElementParseError, normalizeCatalogId, parseOmm, parseTle } from "./elements.js";
import { propagateAt } from "./propagation.js";

/**
 * Element parsing and normalisation.
 *
 * The centrepiece is the OMM/TLE equivalence test: the same orbit expressed in both
 * formats must propagate to the same place. That is what justifies treating OMM as
 * canonical while still accepting TLE, and it would catch a unit or field-mapping
 * error in either path.
 */

const ISS_TLE_LINE_1 =
  "1 25544U 98067A   20152.30537281  .00000771  00000-0  22921-4 0  9992";
const ISS_TLE_LINE_2 =
  "2 25544  51.6443 213.3186 0002062  86.1610  20.9679 15.49392770229125";

/**
 * The same element set expressed as CCSDS OMM, using CelesTrak's conventions:
 * numeric fields as JSON numbers, no CCSDS_OMM_VERS, eccentricity as a decimal
 * fraction rather than the TLE's implied leading "0.".
 */
const ISS_OMM: OMMJsonObject = {
  OBJECT_NAME: "ISS (ZARYA)",
  OBJECT_ID: "1998-067A",
  EPOCH: "2020-05-31T07:19:44.211456",
  MEAN_MOTION: 15.4939277,
  ECCENTRICITY: 0.0002062,
  INCLINATION: 51.6443,
  RA_OF_ASC_NODE: 213.3186,
  ARG_OF_PERICENTER: 86.161,
  MEAN_ANOMALY: 20.9679,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: "U",
  NORAD_CAT_ID: 25544,
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 22912,
  BSTAR: 0.000022921,
  MEAN_MOTION_DOT: 0.00000771,
  MEAN_MOTION_DDOT: 0,
};

describe("parseOmm", () => {
  it("normalises an OMM record into typed elements", () => {
    const { elements } = parseOmm(ISS_OMM, {
      provider: "celestrak",
      retrievedAt: new Date("2026-08-31T12:00:00Z"),
    });

    expect(elements.catalogId).toBe("25544");
    expect(elements.name).toBe("ISS (ZARYA)");
    expect(elements.internationalDesignator).toBe("1998-067A");
    expect(elements.format).toBe("OMM_JSON");
    expect(elements.provider).toBe("celestrak");
    expect(elements.inclination).toBeCloseTo(51.6443, 4);
    expect(elements.eccentricity).toBeCloseTo(0.0002062, 7);
    expect(elements.meanMotion).toBeCloseTo(15.4939277, 6);
    expect(elements.revolutionAtEpoch).toBe(22912);
  });

  it("keeps element epoch and retrieval time distinct", () => {
    // These are different facts and the UI must never conflate them.
    const retrievedAt = new Date("2026-08-31T12:00:00Z");
    const { elements } = parseOmm(ISS_OMM, { retrievedAt });

    expect(elements.epoch.getTime()).not.toBe(retrievedAt.getTime());
    expect(elements.epoch.toISOString()).toMatch(/^2020-05-31T07:19:44/);
    expect(elements.retrievedAt).toBe(retrievedAt);
  });

  it("interprets a timezone-less EPOCH as UTC, not local time", () => {
    // Regression test. CelesTrak emits EPOCH without a designator, and ECMAScript
    // parses such strings as LOCAL time. On a UTC+10 machine that silently moved
    // every satellite's epoch back ten hours; on a UTC CI server it looked fine.
    const { elements } = parseOmm({
      ...ISS_OMM,
      EPOCH: "2020-05-31T07:19:44.211456",
    });

    expect(elements.epoch.toISOString()).toBe("2020-05-31T07:19:44.211Z");
    expect(elements.epoch.getUTCHours()).toBe(7);
    expect(elements.epoch.getUTCDate()).toBe(31);
  });

  it("honours an explicit designator when one is present", () => {
    const withZ = parseOmm({ ...ISS_OMM, EPOCH: "2020-05-31T07:19:44.211Z" });
    expect(withZ.elements.epoch.toISOString()).toBe("2020-05-31T07:19:44.211Z");

    // A real offset must be respected rather than overwritten with Z.
    const withOffset = parseOmm({ ...ISS_OMM, EPOCH: "2020-05-31T09:19:44.211+02:00" });
    expect(withOffset.elements.epoch.toISOString()).toBe("2020-05-31T07:19:44.211Z");
  });

  it("agrees with the TLE path on the element epoch", () => {
    // The TLE path derives the epoch from the Julian date, which is unambiguous.
    // If the OMM path had a timezone bug, these would disagree by the host offset.
    const fromOmm = parseOmm(ISS_OMM).elements.epoch;
    const fromTle = parseTle(ISS_TLE_LINE_1, ISS_TLE_LINE_2).elements.epoch;

    expect(Math.abs(fromOmm.getTime() - fromTle.getTime())).toBeLessThan(1000);
  });

  it("accepts numeric fields encoded as strings (the Space-Track convention)", () => {
    const stringified: OMMJsonObject = {
      ...ISS_OMM,
      MEAN_MOTION: "15.4939277",
      ECCENTRICITY: "0.0002062",
      INCLINATION: "51.6443",
      NORAD_CAT_ID: "25544",
      BSTAR: "0.000022921",
    };

    const { elements } = parseOmm(stringified);
    expect(elements.catalogId).toBe("25544");
    expect(elements.inclination).toBeCloseTo(51.6443, 4);
    expect(elements.meanMotion).toBeCloseTo(15.4939277, 6);
  });

  it("retains the raw OMM for the DATA tab", () => {
    const { elements } = parseOmm(ISS_OMM);
    expect(elements.rawOmm).toBeDefined();
    expect(elements.rawOmm?.["OBJECT_NAME"]).toBe("ISS (ZARYA)");
    expect(elements.rawTle).toBeUndefined();
  });

  it("rejects a record with no usable catalog id", () => {
    const broken = { ...ISS_OMM, NORAD_CAT_ID: "" } as unknown as OMMJsonObject;
    expect(() => parseOmm(broken)).toThrow(ElementParseError);
  });

  it("rejects an unparseable epoch", () => {
    const broken: OMMJsonObject = { ...ISS_OMM, EPOCH: "not-a-date" };
    expect(() => parseOmm(broken)).toThrow(ElementParseError);
  });

  it("rejects a non-numeric required field", () => {
    const broken = { ...ISS_OMM, INCLINATION: "abc" } as unknown as OMMJsonObject;
    expect(() => parseOmm(broken)).toThrow(/INCLINATION/);
  });
});

describe("OMM and TLE equivalence", () => {
  it("propagates the same orbit to the same place from either format", () => {
    const fromTle = parseTle(ISS_TLE_LINE_1, ISS_TLE_LINE_2, { name: "ISS (ZARYA)" });
    const fromOmm = parseOmm(ISS_OMM);

    const at = new Date("2020-05-31T09:00:00Z");
    const tleState = propagateAt(fromTle.satrec, at);
    const ommState = propagateAt(fromOmm.satrec, at);

    expect(tleState.ok).toBe(true);
    expect(ommState.ok).toBe(true);
    if (!tleState.ok || !ommState.ok) throw new Error("unreachable");

    // Tolerances are loose in absolute terms but tight relative to an orbit that
    // covers ~27,000 km in this interval: the TLE encodes fewer digits than the OMM,
    // so exact agreement is not expected, but kilometre-level agreement proves the
    // two paths are reading the same physical elements.
    expect(ommState.state.positionEci.x).toBeCloseTo(tleState.state.positionEci.x, 0);
    expect(ommState.state.positionEci.y).toBeCloseTo(tleState.state.positionEci.y, 0);
    expect(ommState.state.positionEci.z).toBeCloseTo(tleState.state.positionEci.z, 0);

    expect(ommState.state.geodetic.altitude).toBeCloseTo(
      tleState.state.geodetic.altitude,
      1,
    );
  });

  it("produces the same catalog id from both formats", () => {
    expect(parseTle(ISS_TLE_LINE_1, ISS_TLE_LINE_2).elements.catalogId).toBe(
      parseOmm(ISS_OMM).elements.catalogId,
    );
  });
});

describe("normalizeCatalogId", () => {
  it("strips zero padding from numeric identifiers", () => {
    expect(normalizeCatalogId("00005")).toBe("5");
    expect(normalizeCatalogId("00025544")).toBe("25544");
    expect(normalizeCatalogId("25544")).toBe("25544");
  });

  it("accepts numbers", () => {
    expect(normalizeCatalogId(25544)).toBe("25544");
    expect(normalizeCatalogId(25544.0)).toBe("25544");
  });

  it("supports identifiers beyond five digits", () => {
    // The catalog has outgrown the legacy five-digit TLE field; six-digit ids must
    // survive unchanged rather than being truncated or wrapped.
    expect(normalizeCatalogId("270000")).toBe("270000");
    expect(normalizeCatalogId(270000)).toBe("270000");
  });

  it("preserves Alpha-5 identifiers", () => {
    // "A0001" denotes 100001 in the Alpha-5 encoding; stripping or renumbering it
    // would silently collide with a different object.
    expect(normalizeCatalogId("A0001")).toBe("A0001");
    expect(normalizeCatalogId("a0001")).toBe("A0001");
  });

  it("rejects unusable input", () => {
    expect(normalizeCatalogId("")).toBeUndefined();
    expect(normalizeCatalogId("   ")).toBeUndefined();
    expect(normalizeCatalogId(null)).toBeUndefined();
    expect(normalizeCatalogId(undefined)).toBeUndefined();
    expect(normalizeCatalogId(Number.NaN)).toBeUndefined();
  });
});

describe("parseTle", () => {
  it("expands the international designator with the correct century", () => {
    // 98 -> 1998 via the satellite-era pivot (57-99 are 19xx).
    expect(parseTle(ISS_TLE_LINE_1, ISS_TLE_LINE_2).elements.internationalDesignator).toBe(
      "1998-067A",
    );
  });

  it("treats a two-digit year below 57 as 20xx", () => {
    const line1 = "1 25544U 06067A   20152.30537281  .00000771  00000-0  22921-4 0  9992";
    expect(parseTle(line1, ISS_TLE_LINE_2).elements.internationalDesignator).toBe(
      "2006-067A",
    );
  });

  it("retains the raw TLE lines", () => {
    const { elements } = parseTle(ISS_TLE_LINE_1, ISS_TLE_LINE_2);
    expect(elements.rawTle).toEqual([ISS_TLE_LINE_1, ISS_TLE_LINE_2]);
    expect(elements.rawOmm).toBeUndefined();
  });

  it("defaults the provider to user-import", () => {
    expect(parseTle(ISS_TLE_LINE_1, ISS_TLE_LINE_2).elements.provider).toBe("user-import");
  });
});
