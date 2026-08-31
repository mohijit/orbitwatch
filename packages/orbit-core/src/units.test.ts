import { describe, expect, it } from "vitest";

import {
  MINUTES_PER_DAY,
  SIDEREAL_DAY_MINUTES,
  degrees,
  earthRadii,
  earthRadiiToKilometers,
  kilometers,
  kilometersToMeters,
  meters,
  metersToKilometers,
  normalizeDegrees,
  normalizeLongitude,
  periodFromMeanMotion,
  radians,
  radiansPerMinute,
  radiansPerMinuteToRevolutionsPerDay,
  revolutionsPerDay,
  revolutionsPerDayToRadiansPerMinute,
  toDegrees,
  toRadians,
} from "./units.js";

describe("angle conversions", () => {
  it("round-trips degrees through radians", () => {
    for (const value of [0, 1, 45, 51.6443, 90, 180, 270, 359.999]) {
      expect(toDegrees(toRadians(degrees(value)))).toBeCloseTo(value, 10);
    }
  });

  it("converts known angles correctly", () => {
    expect(toRadians(degrees(180))).toBeCloseTo(Math.PI, 12);
    expect(toRadians(degrees(90))).toBeCloseTo(Math.PI / 2, 12);
    expect(toDegrees(radians(Math.PI))).toBeCloseTo(180, 12);
  });
});

describe("distance conversions", () => {
  it("round-trips kilometres through metres", () => {
    expect(metersToKilometers(kilometersToMeters(kilometers(408.21)))).toBeCloseTo(
      408.21,
      10,
    );
  });

  it("converts Earth radii using the SGP4 (WGS72) radius", () => {
    // Deliberately the WGS72 value, matching what SGP4 itself uses, so that a
    // round-trip through satrec.alta/altp is self-consistent.
    expect(earthRadiiToKilometers(earthRadii(1))).toBeCloseTo(6378.135, 6);
    expect(earthRadiiToKilometers(earthRadii(0))).toBe(0);
  });

  it("keeps metres and kilometres distinct", () => {
    expect(kilometersToMeters(kilometers(1))).toBe(1000);
    expect(metersToKilometers(meters(1000))).toBe(1);
  });
});

describe("mean motion conversions", () => {
  it("round-trips revolutions per day through radians per minute", () => {
    const original = revolutionsPerDay(15.4939277);
    const roundTripped = radiansPerMinuteToRevolutionsPerDay(
      revolutionsPerDayToRadiansPerMinute(original),
    );
    expect(roundTripped).toBeCloseTo(15.4939277, 10);
  });

  it("converts one revolution per day to the expected angular rate", () => {
    const rate = revolutionsPerDayToRadiansPerMinute(revolutionsPerDay(1));
    expect(rate).toBeCloseTo((2 * Math.PI) / MINUTES_PER_DAY, 12);
  });

  it("derives the ISS orbital period from its mean motion", () => {
    // 15.4939277 rev/day is one revolution every ~92.9 minutes.
    const period = periodFromMeanMotion(
      revolutionsPerDayToRadiansPerMinute(revolutionsPerDay(15.4939277)),
    );
    expect(period).toBeCloseTo(92.94, 1);
  });

  it("derives a geosynchronous period close to the sidereal day", () => {
    const period = periodFromMeanMotion(
      revolutionsPerDayToRadiansPerMinute(revolutionsPerDay(1.0027379)),
    );
    expect(period).toBeCloseTo(SIDEREAL_DAY_MINUTES, 0);
  });
});

describe("normalizeDegrees", () => {
  it("maps angles into [0, 360)", () => {
    expect(normalizeDegrees(degrees(0))).toBe(0);
    expect(normalizeDegrees(degrees(359.9))).toBeCloseTo(359.9, 10);
    expect(normalizeDegrees(degrees(360))).toBe(0);
    expect(normalizeDegrees(degrees(361))).toBeCloseTo(1, 10);
    expect(normalizeDegrees(degrees(720))).toBe(0);
  });

  it("maps negative angles into the positive range", () => {
    // A compass bearing must never display as negative.
    expect(normalizeDegrees(degrees(-1))).toBeCloseTo(359, 10);
    expect(normalizeDegrees(degrees(-90))).toBeCloseTo(270, 10);
    expect(normalizeDegrees(degrees(-400))).toBeCloseTo(320, 10);
  });
});

describe("normalizeLongitude", () => {
  it("leaves in-range longitudes untouched", () => {
    expect(normalizeLongitude(degrees(0))).toBe(0);
    expect(normalizeLongitude(degrees(151.21))).toBeCloseTo(151.21, 10);
    expect(normalizeLongitude(degrees(-73.5))).toBeCloseTo(-73.5, 10);
  });

  it("wraps values past the antimeridian", () => {
    expect(normalizeLongitude(degrees(180))).toBeCloseTo(180, 10);
    expect(normalizeLongitude(degrees(181))).toBeCloseTo(-179, 10);
    expect(normalizeLongitude(degrees(-181))).toBeCloseTo(179, 10);
    expect(normalizeLongitude(degrees(540))).toBeCloseTo(180, 10);
  });

  it("keeps every result inside (-180, 180]", () => {
    for (let value = -1080; value <= 1080; value += 7.5) {
      const wrapped = normalizeLongitude(degrees(value));
      expect(wrapped).toBeGreaterThan(-180.0000001);
      expect(wrapped).toBeLessThanOrEqual(180.0000001);
    }
  });
});

describe("unit branding", () => {
  it("keeps branded values usable as plain numbers at runtime", () => {
    // The brand is a compile-time construct only; it must not survive into the
    // runtime value, or arithmetic and JSON serialisation would break.
    const altitude = kilometers(408.21);
    expect(altitude + 1).toBeCloseTo(409.21, 10);
    expect(JSON.parse(JSON.stringify({ altitude }))).toEqual({ altitude: 408.21 });
    expect(typeof altitude).toBe("number");
  });

  it("exposes the expected constants", () => {
    expect(MINUTES_PER_DAY).toBe(1440);
    // The sidereal day is ~4 minutes shorter than the solar day.
    expect(MINUTES_PER_DAY - SIDEREAL_DAY_MINUTES).toBeCloseTo(3.93, 1);
  });
});

describe("radiansPerMinute constructor", () => {
  it("wraps a raw rate without altering it", () => {
    expect(radiansPerMinute(0.0011)).toBe(0.0011);
  });
});
