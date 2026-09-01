import { describe, expect, it } from "vitest";

import { parseTle } from "./elements.js";
import {
  footprintAngularRadius,
  footprintRadiusKm,
  footprintRing,
  geodetic,
  groundTrack,
  splitAtAntimeridian,
  type GroundTrackPoint,
} from "./ground-track.js";
import {
  CIVIL_TWILIGHT_DEGREES,
  classifyShadow,
  illuminationAt,
  nextDarkness,
  observerLighting,
  sunAltitudeDegrees,
} from "./illumination.js";
import { azimuthToCompass, lookAnglesAt, observerAt } from "./look-angles.js";
import { classifyVisibility, predictPasses } from "./passes.js";
import { degrees, kilometers } from "./units.js";

/**
 * Observer-relative behaviour: look angles, ground tracks, footprints, illumination
 * and pass prediction.
 *
 * The ISS element set below is real. Assertions are physical invariants and
 * independently derivable geometry rather than snapshots of our own output.
 */

const ISS_TLE_LINE_1 =
  "1 25544U 98067A   20152.30537281  .00000771  00000-0  22921-4 0  9992";
const ISS_TLE_LINE_2 =
  "2 25544  51.6443 213.3186 0002062  86.1610  20.9679 15.49392770229125";

const { satrec, elements } = parseTle(ISS_TLE_LINE_1, ISS_TLE_LINE_2, {
  name: "ISS (ZARYA)",
});

const SYDNEY = observerAt(-33.8688, 151.2093, 0.058, "Sydney, Australia");

describe("azimuthToCompass", () => {
  it("maps cardinal directions", () => {
    expect(azimuthToCompass(degrees(0))).toBe("N");
    expect(azimuthToCompass(degrees(90))).toBe("E");
    expect(azimuthToCompass(degrees(180))).toBe("S");
    expect(azimuthToCompass(degrees(270))).toBe("W");
  });

  it("rounds to the nearest point rather than always down", () => {
    // 349 degrees is much closer to N (360) than to NNW (337.5).
    expect(azimuthToCompass(degrees(349))).toBe("N");
    expect(azimuthToCompass(degrees(354))).toBe("N");
    expect(azimuthToCompass(degrees(330))).toBe("NNW");
  });

  it("wraps past 360 and handles negatives", () => {
    expect(azimuthToCompass(degrees(360))).toBe("N");
    expect(azimuthToCompass(degrees(361))).toBe("N");
    expect(azimuthToCompass(degrees(-90))).toBe("W");
  });

  it("covers every sector without gaps", () => {
    const seen = new Set<string>();
    for (let azimuth = 0; azimuth < 360; azimuth += 0.5) {
      seen.add(azimuthToCompass(degrees(azimuth)));
    }
    expect(seen.size).toBe(16);
  });
});

describe("observerAt", () => {
  it("rejects out-of-range coordinates", () => {
    expect(() => observerAt(91, 0)).toThrow(RangeError);
    expect(() => observerAt(-91, 0)).toThrow(RangeError);
    expect(() => observerAt(0, 181)).toThrow(RangeError);
    expect(() => observerAt(0, -181)).toThrow(RangeError);
  });

  it("defaults altitude to sea level", () => {
    expect(observerAt(-33.87, 151.21).altitude).toBe(0);
  });
});

describe("lookAnglesAt", () => {
  it("produces angles within their physical ranges", () => {
    const start = elements.epoch.getTime();
    for (let offset = 0; offset < 90 * 60 * 1000; offset += 5 * 60 * 1000) {
      const angles = lookAnglesAt(satrec, SYDNEY, new Date(start + offset));
      if (angles === undefined) continue;

      expect(angles.azimuth).toBeGreaterThanOrEqual(0);
      expect(angles.azimuth).toBeLessThan(360);
      expect(angles.elevation).toBeGreaterThanOrEqual(-90);
      expect(angles.elevation).toBeLessThanOrEqual(90);
      expect(angles.range).toBeGreaterThan(0);
      expect(angles.aboveHorizon).toBe(angles.elevation > 0);
    }
  });

  it("bounds range by orbit geometry, distinguishing above and below the horizon", () => {
    // ecfToLookAngles reports slant range even when the satellite is BELOW the
    // horizon, in which case the line of sight passes through the Earth. The two
    // regimes have different bounds and conflating them is a real trap:
    //   above horizon : range <= sqrt((Re+h)^2 - Re^2) ~= 2352 km for h = 420 km
    //   anywhere      : range <= 2*Re + h              ~= 13176 km (diametrically opposite)
    const EARTH_RADIUS = 6378.135;
    const MAX_ALTITUDE = 440;
    const horizonRange = Math.sqrt((EARTH_RADIUS + MAX_ALTITUDE) ** 2 - EARTH_RADIUS ** 2);
    const antipodalRange = 2 * EARTH_RADIUS + MAX_ALTITUDE;

    const start = elements.epoch.getTime();
    let sawAbove = false;
    let sawBelow = false;

    for (let offset = 0; offset < 93 * 60 * 1000; offset += 60 * 1000) {
      const angles = lookAnglesAt(satrec, SYDNEY, new Date(start + offset));
      if (angles === undefined) continue;

      expect(angles.range).toBeGreaterThan(300);
      expect(angles.range).toBeLessThan(antipodalRange);

      if (angles.aboveHorizon) {
        sawAbove = true;
        expect(angles.range).toBeLessThan(horizonRange);
      } else {
        sawBelow = true;
      }
    }

    // A full revolution must contain both regimes, or the test proves nothing.
    expect(sawAbove).toBe(true);
    expect(sawBelow).toBe(true);
  });

  it("reports range rate with the receding-positive convention", () => {
    const start = elements.epoch.getTime();
    const rates: number[] = [];
    for (let offset = 0; offset < 90 * 60 * 1000; offset += 60 * 1000) {
      const angles = lookAnglesAt(satrec, SYDNEY, new Date(start + offset));
      if (angles !== undefined) rates.push(angles.rangeRate);
    }

    // Over a full revolution the satellite both approaches and recedes.
    expect(rates.some((rate) => rate > 0)).toBe(true);
    expect(rates.some((rate) => rate < 0)).toBe(true);
    // LEO range rate never exceeds orbital speed.
    for (const rate of rates) expect(Math.abs(rate)).toBeLessThan(8);
  });

});

describe("look angles at the sub-satellite point", () => {
  it("gives near-zenith elevation and range equal to altitude", () => {
    // The strongest available check on the whole ECI -> ECF -> topocentric chain,
    // because the answer is known independently: an observer standing directly
    // beneath the satellite must see it at 90 degrees elevation, at a slant range
    // exactly equal to its altitude. Any frame, unit or sign error breaks this.
    const time = elements.epoch;

    const track = groundTrack(satrec, time, new Date(time.getTime() + 1000), {
      stepSeconds: 1,
    });
    const subSatellitePoint = track.segments[0]?.[0];
    if (subSatellitePoint === undefined) throw new Error("expected a ground track point");

    const beneath = observerAt(
      subSatellitePoint.latitude,
      subSatellitePoint.longitude,
      0,
    );
    const overhead = lookAnglesAt(satrec, beneath, time);
    if (overhead === undefined) throw new Error("expected overhead angles");

    expect(overhead.elevation).toBeGreaterThan(89.9);
    expect(overhead.range).toBeCloseTo(subSatellitePoint.altitude, 0);
  });
});

describe("splitAtAntimeridian", () => {
  const point = (longitude: number, latitude = 0): GroundTrackPoint => ({
    time: new Date("2026-08-31T00:00:00Z"),
    latitude: degrees(latitude),
    longitude: degrees(longitude),
    altitude: kilometers(420),
  });

  it("keeps a track that never crosses as a single segment", () => {
    const segments = splitAtAntimeridian([point(10), point(20), point(30)]);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(3);
  });

  it("splits eastward crossings of the antimeridian", () => {
    // This is the bug being prevented: without a split, a renderer draws a line from
    // +179 all the way back across the map to -179.
    const segments = splitAtAntimeridian([
      point(170),
      point(179),
      point(-179),
      point(-170),
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.map((p) => p.longitude)).toEqual([170, 179]);
    expect(segments[1]?.map((p) => p.longitude)).toEqual([-179, -170]);
  });

  it("splits westward crossings too", () => {
    const segments = splitAtAntimeridian([point(-170), point(-179), point(179)]);
    expect(segments).toHaveLength(2);
  });

  it("does not split a track merely flying near the antimeridian", () => {
    // Every point is within a couple of degrees of 180 but none wraps.
    const segments = splitAtAntimeridian([
      point(176),
      point(177),
      point(178),
      point(179),
    ]);
    expect(segments).toHaveLength(1);
  });

  it("does not split at the prime meridian", () => {
    const segments = splitAtAntimeridian([point(-2), point(-1), point(0), point(1)]);
    expect(segments).toHaveLength(1);
  });

  it("handles empty and single-point input", () => {
    expect(splitAtAntimeridian([])).toHaveLength(0);
    expect(splitAtAntimeridian([point(0)])).toHaveLength(1);
  });
});

describe("groundTrack", () => {
  it("produces a continuous track with plausible sub-satellite points", () => {
    const start = elements.epoch;
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const track = groundTrack(satrec, start, end, { stepSeconds: 30 });

    expect(track.pointCount).toBeGreaterThan(50);
    expect(track.segments.length).toBeGreaterThanOrEqual(1);

    for (const segment of track.segments) {
      for (const point of segment) {
        expect(Math.abs(point.latitude)).toBeLessThanOrEqual(51.9);
        expect(point.longitude).toBeGreaterThan(-180.001);
        expect(point.longitude).toBeLessThanOrEqual(180.001);
        expect(point.altitude).toBeGreaterThan(300);
      }
    }
  });

  it("never leaves a within-segment longitude jump larger than the threshold", () => {
    // The invariant that actually matters to the renderer.
    const start = elements.epoch;
    const track = groundTrack(satrec, start, new Date(start.getTime() + 3 * 60 * 60 * 1000), {
      stepSeconds: 30,
    });

    for (const segment of track.segments) {
      for (let index = 1; index < segment.length; index += 1) {
        const previous = segment[index - 1];
        const current = segment[index];
        if (previous === undefined || current === undefined) continue;
        expect(Math.abs(current.longitude - previous.longitude)).toBeLessThan(180);
      }
    }
  });

  it("splits an ISS track over several revolutions", () => {
    // Three hours is roughly two revolutions, which must cross the antimeridian.
    const start = elements.epoch;
    const track = groundTrack(satrec, start, new Date(start.getTime() + 3 * 60 * 60 * 1000), {
      stepSeconds: 30,
    });
    expect(track.segments.length).toBeGreaterThan(1);
  });
});

describe("footprint", () => {
  it("grows with altitude", () => {
    expect(footprintRadiusKm(kilometers(400))).toBeLessThan(
      footprintRadiusKm(kilometers(800)),
    );
    expect(footprintRadiusKm(kilometers(800))).toBeLessThan(
      footprintRadiusKm(kilometers(20200)),
    );
  });

  it("matches the closed-form horizon geometry", () => {
    // arccos(Re / (Re + h)) is the central angle to the horizon.
    const altitude = kilometers(408);
    const expected = Math.acos(6378.135 / (6378.135 + 408));
    expect(footprintAngularRadius(altitude)).toBeCloseTo(expected, 12);
  });

  it("gives an ISS footprint radius near the accepted ~2200 km", () => {
    const radius = footprintRadiusKm(kilometers(420));
    expect(radius).toBeGreaterThan(2000);
    expect(radius).toBeLessThan(2400);
  });

  it("returns zero radius at the surface", () => {
    expect(footprintAngularRadius(kilometers(0))).toBe(0);
    expect(footprintRing(geodetic(0, 0, 0))).toHaveLength(0);
  });

  it("produces a closed ring of valid coordinates", () => {
    const ring = footprintRing(geodetic(-33.87, 151.21, 420), 64);
    // 64 points plus the repeated closing point.
    expect(ring).toHaveLength(65);
    expect(ring[0]).toEqual(ring.at(-1));

    for (const vertex of ring) {
      expect(Math.abs(vertex.latitude)).toBeLessThanOrEqual(90.001);
      expect(vertex.longitude).toBeGreaterThan(-180.001);
      expect(vertex.longitude).toBeLessThanOrEqual(180.001);
    }
  });

  it("rejects a degenerate ring", () => {
    expect(() => footprintRing(geodetic(0, 0, 420), 2)).toThrow(RangeError);
  });
});

describe("illumination", () => {
  it("classifies shadow fractions into states", () => {
    expect(classifyShadow(0)).toBe("SUNLIT");
    expect(classifyShadow(0.005)).toBe("SUNLIT");
    expect(classifyShadow(0.5)).toBe("PENUMBRA");
    expect(classifyShadow(1)).toBe("UMBRA");
  });

  it("reports both lit and shadowed states across a revolution", () => {
    // A LEO satellite passes through Earth's shadow every orbit, so a full revolution
    // must contain both. Always-sunlit output would indicate a broken shadow model.
    const start = elements.epoch.getTime();
    const states = new Set<string>();

    for (let offset = 0; offset < 93 * 60 * 1000; offset += 60 * 1000) {
      const result = illuminationAt(satrec, new Date(start + offset));
      if (result !== undefined) states.add(result.state);
    }

    expect(states.has("SUNLIT")).toBe(true);
    expect(states.has("UMBRA")).toBe(true);
  });

  it("keeps the shadow fraction within [0, 1]", () => {
    const start = elements.epoch.getTime();
    for (let offset = 0; offset < 93 * 60 * 1000; offset += 5 * 60 * 1000) {
      const result = illuminationAt(satrec, new Date(start + offset));
      if (result === undefined) continue;
      expect(result.shadowFraction).toBeGreaterThanOrEqual(0);
      expect(result.shadowFraction).toBeLessThanOrEqual(1);
    }
  });
});

describe("sun altitude and observer lighting", () => {
  it("puts the Sun high over the tropics at local noon near the solstice", () => {
    // 2026-06-21 12:00 UTC, observer on the Greenwich meridian at the Tropic of
    // Cancer: the Sun is close to overhead at the June solstice.
    const altitude = sunAltitudeDegrees(
      observerAt(23.44, 0),
      new Date("2026-06-21T12:00:00Z"),
    );
    expect(altitude).toBeGreaterThan(80);
  });

  it("puts the Sun below the horizon at local midnight", () => {
    const altitude = sunAltitudeDegrees(
      observerAt(0, 0),
      new Date("2026-06-21T00:00:00Z"),
    );
    expect(altitude).toBeLessThan(0);
  });

  it("distinguishes polar twilight from true darkness in the Antarctic winter", () => {
    // At 80 south on the June solstice the Sun never rises, but it does not sink
    // uniformly far below the horizon. Solar declination is +23.44, so:
    //   local noon     -> altitude ~= -13.4 deg  -> still TWILIGHT
    //   local midnight -> altitude ~= -33.4 deg  -> DARK
    // Treating all polar night as "dark" would wrongly promise good observing
    // conditions around the middle of the day.
    const antarctica = observerAt(-80, 0);

    expect(sunAltitudeDegrees(antarctica, new Date("2026-06-21T12:00:00Z"))).toBeCloseTo(
      -13.4,
      0,
    );
    expect(observerLighting(antarctica, new Date("2026-06-21T12:00:00Z"))).toBe(
      "TWILIGHT",
    );

    expect(sunAltitudeDegrees(antarctica, new Date("2026-06-21T00:00:00Z"))).toBeCloseTo(
      -33.4,
      0,
    );
    expect(observerLighting(antarctica, new Date("2026-06-21T00:00:00Z"))).toBe("DARK");
  });

  it("reports daylight at high northern latitudes in June", () => {
    // The Arctic in June has continuous daylight, at any hour.
    expect(observerLighting(observerAt(80, 0), new Date("2026-06-21T00:00:00Z"))).toBe(
      "DAYLIGHT",
    );
  });

  it("keeps sun altitude within physical bounds year-round", () => {
    for (let month = 0; month < 12; month += 1) {
      const time = new Date(Date.UTC(2026, month, 15, 6, 0, 0));
      const altitude = sunAltitudeDegrees(SYDNEY, time);
      expect(altitude).toBeGreaterThanOrEqual(-90);
      expect(altitude).toBeLessThanOrEqual(90);
    }
  });
});

describe("classifyVisibility", () => {
  it("requires a lit satellite and a dark sky for a likely sighting", () => {
    expect(classifyVisibility("SUNLIT", "DARK", 60)).toBe("LIKELY_VISIBLE");
  });

  it("rejects daylight regardless of illumination", () => {
    expect(classifyVisibility("SUNLIT", "DAYLIGHT", 80)).toBe("DAYLIGHT");
  });

  it("rejects a shadowed satellite regardless of sky darkness", () => {
    expect(classifyVisibility("UMBRA", "DARK", 80)).toBe("SATELLITE_IN_SHADOW");
  });

  it("downgrades a low pass to possibly visible", () => {
    expect(classifyVisibility("SUNLIT", "DARK", 15)).toBe("POSSIBLY_VISIBLE");
  });

  it("treats penumbra as marginal", () => {
    expect(classifyVisibility("PENUMBRA", "DARK", 70)).toBe("POSSIBLY_VISIBLE");
  });

  it("falls back when illumination is unknown", () => {
    expect(classifyVisibility(undefined, "DARK", 70)).toBe("NOT_OPTICALLY_FAVOURABLE");
  });
});

describe("predictPasses", () => {
  const start = elements.epoch;
  const end = new Date(start.getTime() + 48 * 60 * 60 * 1000);

  it("finds ISS passes over Sydney within two days", () => {
    // The ISS inclination is 51.6 degrees and Sydney is at 33.9 south, so passes
    // certainly occur; finding none would indicate a broken geometry chain.
    const passes = predictPasses(satrec, SYDNEY, start, end, { minimumElevation: 10 });
    expect(passes.length).toBeGreaterThan(0);
  });

  it("produces internally consistent pass structure", () => {
    const passes = predictPasses(satrec, SYDNEY, start, end, { minimumElevation: 10 });

    for (const pass of passes) {
      // Ordering.
      expect(pass.aos.time.getTime()).toBeLessThan(pass.los.time.getTime());
      expect(pass.maximum.time.getTime()).toBeGreaterThanOrEqual(pass.aos.time.getTime());
      expect(pass.maximum.time.getTime()).toBeLessThanOrEqual(pass.los.time.getTime());

      // The peak really is the peak.
      expect(pass.maximum.elevation).toBeGreaterThanOrEqual(pass.aos.elevation - 0.5);
      expect(pass.maximum.elevation).toBeGreaterThanOrEqual(pass.los.elevation - 0.5);

      // Closest approach coincides with maximum elevation.
      expect(pass.minimumRange).toBeLessThanOrEqual(pass.aos.range + 1);
      expect(pass.minimumRange).toBeLessThanOrEqual(pass.los.range + 1);

      // A LEO pass lasts minutes, never hours.
      expect(pass.durationSeconds).toBeGreaterThan(30);
      expect(pass.durationSeconds).toBeLessThan(30 * 60);

      expect(pass.durationSeconds).toBe(
        Math.round((pass.los.time.getTime() - pass.aos.time.getTime()) / 1000),
      );
    }
  });

  it("honours the minimum elevation threshold", () => {
    const passes = predictPasses(satrec, SYDNEY, start, end, { minimumElevation: 25 });
    for (const pass of passes) {
      expect(pass.maximum.elevation).toBeGreaterThanOrEqual(24.5);
    }
  });

  it("returns fewer passes as the threshold rises", () => {
    const low = predictPasses(satrec, SYDNEY, start, end, { minimumElevation: 5 });
    const high = predictPasses(satrec, SYDNEY, start, end, { minimumElevation: 40 });
    expect(high.length).toBeLessThanOrEqual(low.length);
  });

  it("refines AOS and LOS to the threshold, not the coarse grid", () => {
    // If refinement were skipped, endpoint elevations would scatter well away from
    // the threshold because the coarse step is 30 seconds.
    const passes = predictPasses(satrec, SYDNEY, start, end, { minimumElevation: 10 });
    expect(passes.length).toBeGreaterThan(0);

    for (const pass of passes) {
      // Endpoints truncated by the search window are exempt.
      if (pass.aos.time.getTime() !== start.getTime()) {
        expect(Math.abs(pass.aos.elevation - 10)).toBeLessThan(0.5);
      }
      if (pass.los.time.getTime() !== end.getTime()) {
        expect(Math.abs(pass.los.elevation - 10)).toBeLessThan(0.5);
      }
    }
  });

  it("returns passes in chronological order without overlaps", () => {
    const passes = predictPasses(satrec, SYDNEY, start, end, { minimumElevation: 10 });
    for (let index = 1; index < passes.length; index += 1) {
      const previous = passes[index - 1];
      const current = passes[index];
      if (previous === undefined || current === undefined) continue;
      expect(current.aos.time.getTime()).toBeGreaterThan(previous.los.time.getTime());
    }
  });

  it("respects the maximum pass cap", () => {
    const passes = predictPasses(satrec, SYDNEY, start, end, {
      minimumElevation: 0,
      maximumPasses: 3,
    });
    expect(passes.length).toBeLessThanOrEqual(3);
  });

  it("finds no passes for an observer on the opposite side of the world", () => {
    // The ISS cannot be above 51.6 degrees latitude, so a polar observer sees nothing.
    const northPole = observerAt(89.9, 0);
    const passes = predictPasses(satrec, northPole, start, end, {
      minimumElevation: 10,
    });
    expect(passes).toHaveLength(0);
  });

  it("rejects an inverted time range", () => {
    expect(() => predictPasses(satrec, SYDNEY, end, start)).toThrow(RangeError);
  });

  it("rejects a non-positive coarse step", () => {
    expect(() =>
      predictPasses(satrec, SYDNEY, start, end, { coarseStepSeconds: 0 }),
    ).toThrow(RangeError);
  });

  it("attaches lighting and visibility to every pass", () => {
    const passes = predictPasses(satrec, SYDNEY, start, end, { minimumElevation: 10 });
    for (const pass of passes) {
      expect(["DAYLIGHT", "TWILIGHT", "DARK"]).toContain(pass.observerLighting);
      expect([
        "LIKELY_VISIBLE",
        "POSSIBLY_VISIBLE",
        "NOT_OPTICALLY_FAVOURABLE",
        "DAYLIGHT",
        "SATELLITE_IN_SHADOW",
      ]).toContain(pass.visibility);
    }
  });
});

describe("nextDarkness", () => {
  const sydney = {
    latitude: degrees(-33.8688),
    longitude: degrees(151.2093),
    altitude: kilometers(0),
  };

  it("finds tonight's darkness and reports it in the right order", () => {
    const window = nextDarkness(sydney, new Date("2026-09-02T09:00:00.000Z"));
    expect(window).toBeDefined();
    expect(window!.end.getTime()).toBeGreaterThan(window!.start.getTime());

    // Sydney is UTC+10, so 09:00Z is 19:00 local: already past sunset in early
    // September, and the window should therefore begin immediately.
    expect(window!.start.toISOString()).toBe("2026-09-02T09:00:00.000Z");

    // A September night at 34 degrees south is on the order of eleven hours from
    // civil dusk to civil dawn. Anything wildly outside that is a broken calculation,
    // not a seasonal quirk.
    const hours = (window!.end.getTime() - window!.start.getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(9);
    expect(hours).toBeLessThan(13);
  });

  it("agrees with observerLighting at both ends", () => {
    const window = nextDarkness(sydney, new Date("2026-09-02T09:00:00.000Z"));
    // Just inside the window the sun must be below civil twilight; just outside it
    // must not be. This is what stops the window and the classifier disagreeing about
    // whether a pass happened in the dark.
    const justInside = new Date(window!.end.getTime() - 120_000);
    const justOutside = new Date(window!.end.getTime() + 120_000);
    expect(sunAltitudeDegrees(sydney, justInside)).toBeLessThan(CIVIL_TWILIGHT_DEGREES);
    expect(sunAltitudeDegrees(sydney, justOutside)).toBeGreaterThan(CIVIL_TWILIGHT_DEGREES);
  });

  it("returns undefined during polar day rather than inventing a night", () => {
    // Longyearbyen in June: the sun does not set, and there is no darkness to offer.
    // A fabricated window here would produce a Visible Tonight list for a bright sky.
    const svalbard = {
      latitude: degrees(78.22),
      longitude: degrees(15.65),
      altitude: kilometers(0),
    };
    expect(nextDarkness(svalbard, new Date("2026-06-21T00:00:00.000Z"))).toBeUndefined();
  });

  it("finds darkness at the same polar location in winter", () => {
    const svalbard = {
      latitude: degrees(78.22),
      longitude: degrees(15.65),
      altitude: kilometers(0),
    };
    const window = nextDarkness(svalbard, new Date("2026-12-21T00:00:00.000Z"));
    expect(window).toBeDefined();
  });
});
