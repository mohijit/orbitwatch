import { describe, expect, it } from "vitest";

import { parseTle } from "./elements.js";
import { classifyOrbit, deriveOrbitGeometry } from "./orbit-class.js";
import { kilometers, minutes } from "./units.js";

/**
 * Orbit classification.
 *
 * The cases below are drawn from real orbital regimes rather than round numbers,
 * because the interesting failures happen at the boundaries: Molniya spans LEO and
 * beyond-GEO altitudes, Tundra is both eccentric and geosynchronous, and a drifting
 * geostationary satellite is geosynchronous without being geostationary.
 */

const classify = (input: {
  periodMinutes: number;
  eccentricity: number;
  inclinationDegrees: number;
  apogeeKm: number;
  perigeeKm: number;
}) =>
  classifyOrbit({
    period: minutes(input.periodMinutes),
    eccentricity: input.eccentricity,
    inclinationDegrees: input.inclinationDegrees,
    apogeeAltitude: kilometers(input.apogeeKm),
    perigeeAltitude: kilometers(input.perigeeKm),
  });

describe("classifyOrbit", () => {
  it("classifies the ISS as LEO", () => {
    expect(
      classify({
        periodMinutes: 92.9,
        eccentricity: 0.0002,
        inclinationDegrees: 51.64,
        apogeeKm: 420,
        perigeeKm: 415,
      }),
    ).toBe("LEO");
  });

  it("classifies a Starlink shell as LEO", () => {
    expect(
      classify({
        periodMinutes: 95.6,
        eccentricity: 0.0001,
        inclinationDegrees: 53.0,
        apogeeKm: 551,
        perigeeKm: 549,
      }),
    ).toBe("LEO");
  });

  it("classifies GPS as MEO", () => {
    expect(
      classify({
        periodMinutes: 717.9,
        eccentricity: 0.011,
        inclinationDegrees: 55.0,
        apogeeKm: 20380,
        perigeeKm: 20000,
      }),
    ).toBe("MEO");
  });

  it("classifies a station-kept geostationary satellite as GEO", () => {
    expect(
      classify({
        periodMinutes: 1436.1,
        eccentricity: 0.0002,
        inclinationDegrees: 0.05,
        apogeeKm: 35792,
        perigeeKm: 35780,
      }),
    ).toBe("GEO");
  });

  it("classifies an inclined geosynchronous satellite as GSO, not GEO", () => {
    // Same period, but a 55 degree inclination means it traces a figure-eight and
    // is emphatically not fixed in the sky.
    expect(
      classify({
        periodMinutes: 1436.1,
        eccentricity: 0.0005,
        inclinationDegrees: 55.0,
        apogeeKm: 35800,
        perigeeKm: 35770,
      }),
    ).toBe("GSO");
  });

  it("classifies a Molniya orbit as HEO despite a LEO-altitude perigee", () => {
    // The trap this guards: perigee 500 km would read as LEO, apogee 39900 km would
    // read as beyond-GEO, and the mean of the two is meaningless.
    expect(
      classify({
        periodMinutes: 717.7,
        eccentricity: 0.74,
        inclinationDegrees: 63.4,
        apogeeKm: 39900,
        perigeeKm: 500,
      }),
    ).toBe("HEO");
  });

  it("classifies a Tundra orbit as GSO, because the synchronous period dominates", () => {
    expect(
      classify({
        periodMinutes: 1436.1,
        eccentricity: 0.27,
        inclinationDegrees: 63.4,
        apogeeKm: 46300,
        perigeeKm: 25300,
      }),
    ).toBe("GSO");
  });

  it("classifies a graveyard orbit above GEO as HIGH", () => {
    expect(
      classify({
        periodMinutes: 1465,
        eccentricity: 0.0003,
        inclinationDegrees: 8.0,
        apogeeKm: 36100,
        perigeeKm: 36050,
      }),
    ).toBe("HIGH");
  });

  it("does not use the solar day for geosynchronicity", () => {
    // A 1440-minute period is the SOLAR day and is roughly 4 minutes longer than the
    // sidereal day. It sits inside the tolerance, so it still reads as synchronous —
    // this test pins the behaviour so a future change to the constant is deliberate.
    expect(
      classify({
        periodMinutes: 1440,
        eccentricity: 0.0002,
        inclinationDegrees: 0.02,
        apogeeKm: 35850,
        perigeeKm: 35840,
      }),
    ).toBe("GEO");
  });

  it("returns UNKNOWN for physically impossible elements", () => {
    expect(
      classify({
        periodMinutes: 0,
        eccentricity: 0.001,
        inclinationDegrees: 10,
        apogeeKm: 500,
        perigeeKm: 400,
      }),
    ).toBe("UNKNOWN");

    expect(
      classify({
        periodMinutes: 95,
        eccentricity: 1.5,
        inclinationDegrees: 10,
        apogeeKm: 500,
        perigeeKm: 400,
      }),
    ).toBe("UNKNOWN");
  });

  it("returns UNKNOWN when perigee is below the surface", () => {
    // Characteristic of stale elements for an object that has already re-entered.
    expect(
      classify({
        periodMinutes: 88,
        eccentricity: 0.01,
        inclinationDegrees: 51,
        apogeeKm: 200,
        perigeeKm: -50,
      }),
    ).toBe("UNKNOWN");
  });
});

describe("deriveOrbitGeometry", () => {
  const { satrec } = parseTle(
    "1 25544U 98067A   20152.30537281  .00000771  00000-0  22921-4 0  9992",
    "2 25544  51.6443 213.3186 0002062  86.1610  20.9679 15.49392770229125",
  );

  it("derives ISS geometry consistent with its published orbit", () => {
    const geometry = deriveOrbitGeometry(satrec);

    // The ISS orbits roughly every 93 minutes at about 410-420 km.
    expect(geometry.period).toBeGreaterThan(92);
    expect(geometry.period).toBeLessThan(94);

    expect(geometry.perigeeAltitude).toBeGreaterThan(380);
    expect(geometry.apogeeAltitude).toBeLessThan(450);
    expect(geometry.apogeeAltitude).toBeGreaterThanOrEqual(geometry.perigeeAltitude);

    expect(geometry.orbitClass).toBe("LEO");
  });

  it("derives a semi-major axis consistent with apogee and perigee", () => {
    const geometry = deriveOrbitGeometry(satrec);
    const EARTH_RADIUS_KM = 6378.135;

    // a = Re + (apogee altitude + perigee altitude) / 2
    const expected =
      EARTH_RADIUS_KM + (geometry.apogeeAltitude + geometry.perigeeAltitude) / 2;

    expect(geometry.semiMajorAxis).toBeCloseTo(expected, 0);
  });
});
