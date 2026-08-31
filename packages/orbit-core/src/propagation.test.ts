import { sgp4 } from "satellite.js";
import { describe, expect, it } from "vitest";

import { parseTle } from "./elements.js";
import { propagateAt, sampleTimes } from "./propagation.js";

/**
 * Reference propagation tests.
 *
 * The first block uses the official SGP4 verification case from Vallado's
 * "Revisiting Spacetrack Report #3" (catalog object 00005, the canonical test
 * vehicle). Its expected state vectors are published alongside the reference
 * implementation, so this asserts our SGP4 wiring against an EXTERNAL source of
 * truth rather than against our own output — which is the only way such a test
 * proves anything.
 *
 * The remaining blocks assert physical invariants that must hold for a real ISS
 * element set regardless of which epoch it came from.
 */

// Vallado SGP4 verification case, object 00005.
const VERIFICATION_TLE_LINE_1 =
  "1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753";
const VERIFICATION_TLE_LINE_2 =
  "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667";

/**
 * A real ISS two-line element set (epoch 2020-152.30). Used for invariant tests,
 * not for exact-value assertions: the point is that a genuine element set produces
 * physically sensible output.
 */
const ISS_TLE_LINE_1 =
  "1 25544U 98067A   20152.30537281  .00000771  00000-0  22921-4 0  9992";
const ISS_TLE_LINE_2 =
  "2 25544  51.6443 213.3186 0002062  86.1610  20.9679 15.49392770229125";

describe("SGP4 reference verification (Vallado object 00005)", () => {
  const { satrec } = parseTle(VERIFICATION_TLE_LINE_1, VERIFICATION_TLE_LINE_2);

  it("reproduces the published state vector at epoch (tsince = 0)", () => {
    const result = sgp4(satrec, 0);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("unreachable");

    // Published expected values, km and km/s.
    expect(result.position.x).toBeCloseTo(7022.46529266, 4);
    expect(result.position.y).toBeCloseTo(-1400.08296755, 4);
    expect(result.position.z).toBeCloseTo(0.03995155, 4);

    expect(result.velocity.x).toBeCloseTo(1.893841015, 6);
    expect(result.velocity.y).toBeCloseTo(6.405893759, 6);
    expect(result.velocity.z).toBeCloseTo(4.534807250, 6);
  });

  it("reproduces the published state vector at tsince = 360 minutes", () => {
    const result = sgp4(satrec, 360);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("unreachable");

    // Values quoted from tcppver.out, vendored at test-fixtures/tcppver.out.
    expect(result.position.x).toBeCloseTo(-7154.03120202, 4);
    expect(result.position.y).toBeCloseTo(-3783.17682504, 4);
    expect(result.position.z).toBeCloseTo(-3536.19412294, 4);

    expect(result.velocity.x).toBeCloseTo(4.741887409, 6);
    expect(result.velocity.y).toBeCloseTo(-4.151817765, 6);
    expect(result.velocity.z).toBeCloseTo(-2.093935425, 6);
  });

  it("parses the element set without error", () => {
    expect(satrec.error).toBe(0);
    // satellite.js preserves the zero-padded satnum from the TLE; our normalised
    // catalog id strips the padding (asserted in elements.test.ts).
    expect(satrec.satnum).toBe("00005");
  });
});

describe("propagateAt with a real ISS element set", () => {
  const { satrec, elements } = parseTle(ISS_TLE_LINE_1, ISS_TLE_LINE_2, {
    name: "ISS (ZARYA)",
  });

  it("extracts the catalog id and designator from the TLE", () => {
    expect(elements.catalogId).toBe("25544");
    expect(elements.internationalDesignator).toBe("1998-067A");
    expect(elements.format).toBe("TLE");
  });

  it("recovers the element epoch from the TLE", () => {
    // Day 152.30537281 of 2020 is 2020-05-31T07:19:44Z.
    expect(elements.epoch.toISOString()).toMatch(/^2020-05-31T07:1[89]/);
  });

  it("produces a physically plausible state at epoch", () => {
    const result = propagateAt(satrec, elements.epoch);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const { geodetic, speed } = result.state;

    // The ISS orbits between roughly 400 and 430 km.
    expect(geodetic.altitude).toBeGreaterThan(380);
    expect(geodetic.altitude).toBeLessThan(450);

    // Orbital speed in LEO is close to 7.66 km/s.
    expect(speed).toBeGreaterThan(7.5);
    expect(speed).toBeLessThan(7.8);

    // GEODETIC latitude can slightly exceed the orbital inclination (51.6443°).
    // Inclination is defined against the geocentric equatorial plane, but geodetic
    // latitude is measured from the ellipsoid normal, which on an oblate Earth runs
    // up to ~0.19° higher at mid-latitudes. Asserting <= inclination here would be
    // wrong physics; the true bound is inclination plus that deflection.
    expect(Math.abs(geodetic.latitude)).toBeLessThanOrEqual(51.9);

    // Longitude must be normalised into (-180, 180].
    expect(geodetic.longitude).toBeGreaterThan(-180);
    expect(geodetic.longitude).toBeLessThanOrEqual(180);
  });

  it("keeps latitude within inclination across a full revolution", () => {
    // Sampling a whole orbit catches frame or unit errors that a single sample hides.
    const start = elements.epoch;
    const oneOrbitLater = new Date(start.getTime() + 93 * 60 * 1000);

    for (const time of sampleTimes(start, oneOrbitLater, 60)) {
      const result = propagateAt(satrec, time);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");

      // See the geodetic-vs-geocentric note above: the bound is inclination + ~0.2°.
      expect(Math.abs(result.state.geodetic.latitude)).toBeLessThanOrEqual(51.9);
      expect(result.state.geodetic.longitude).toBeGreaterThan(-180.0001);
      expect(result.state.geodetic.longitude).toBeLessThanOrEqual(180.0001);
      expect(result.state.geodetic.altitude).toBeGreaterThan(300);
    }
  });

  it("returns both ascending and descending states over one revolution", () => {
    const start = elements.epoch;
    const oneOrbitLater = new Date(start.getTime() + 93 * 60 * 1000);

    const flags = sampleTimes(start, oneOrbitLater, 120).map((time) => {
      const result = propagateAt(satrec, time);
      return result.ok ? result.state.ascending : undefined;
    });

    expect(flags).toContain(true);
    expect(flags).toContain(false);
  });

  it("keeps ECI and ECF magnitudes equal (a frame rotation preserves length)", () => {
    const result = propagateAt(satrec, elements.epoch);
    if (!result.ok) throw new Error("unreachable");

    const { positionEci, positionEcf } = result.state;
    const eciMagnitude = Math.hypot(positionEci.x, positionEci.y, positionEci.z);
    const ecfMagnitude = Math.hypot(positionEcf.x, positionEcf.y, positionEcf.z);

    expect(ecfMagnitude).toBeCloseTo(eciMagnitude, 6);
  });
});

describe("sampleTimes", () => {
  const start = new Date("2026-08-31T00:00:00.000Z");

  it("includes both endpoints when the range divides evenly", () => {
    const times = sampleTimes(start, new Date("2026-08-31T00:01:00.000Z"), 30);
    expect(times).toHaveLength(3);
    expect(times[0]?.toISOString()).toBe("2026-08-31T00:00:00.000Z");
    expect(times[2]?.toISOString()).toBe("2026-08-31T00:01:00.000Z");
  });

  it("does not overshoot the end when the range divides unevenly", () => {
    const end = new Date("2026-08-31T00:00:50.000Z");
    const times = sampleTimes(start, end, 30);
    expect(times).toHaveLength(2);
    expect(times.at(-1)!.getTime()).toBeLessThanOrEqual(end.getTime());
  });

  it("returns a single sample when start equals end", () => {
    expect(sampleTimes(start, start, 30)).toHaveLength(1);
  });

  it("rejects a non-positive step", () => {
    expect(() => sampleTimes(start, start, 0)).toThrow(RangeError);
    expect(() => sampleTimes(start, start, -5)).toThrow(RangeError);
  });

  it("rejects an end before the start", () => {
    const earlier = new Date(start.getTime() - 1000);
    expect(() => sampleTimes(start, earlier, 30)).toThrow(RangeError);
  });
});
