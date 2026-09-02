import { observerAt, type SatellitePass, type VisibilityClassification } from "@orbitwatch/orbit-core";
import { describe, expect, it } from "vitest";

import { sharePassText, shareSatelliteText } from "./share";

/**
 * Shared text.
 *
 * The failure mode here is not a crash — it is a sentence that says something untrue,
 * read hours later by someone with none of the app's context around it. So these tests
 * are largely about what the text must NOT do: promise a sighting, imply a live
 * observation, or leak the sender's coordinates.
 */

function pass(
  visibility: VisibilityClassification = "LIKELY_VISIBLE",
  maxElevation = 78,
): SatellitePass {
  const aos = new Date("2026-09-02T19:31:00Z");
  return {
    aos: { time: aos, azimuth: 300, compass: "WNW", elevation: 10, range: 2000 },
    maximum: {
      time: new Date(aos.getTime() + 180_000),
      azimuth: 45,
      compass: "NE",
      elevation: maxElevation,
      range: 430,
    },
    los: { time: new Date(aos.getTime() + 372_000), azimuth: 120, compass: "ESE", elevation: 10, range: 2100 },
    durationSeconds: 372,
    minimumRange: 430,
    illumination: "SUNLIT",
    observerLighting: "DARK",
    visibility,
  } as SatellitePass;
}

const SYDNEY = observerAt(-33.8688, 151.2093, 0.058, "Sydney Observatory Hill");

describe("sharePassText", () => {
  it("states the object, the geometry and how long it lasts", () => {
    const text = sharePassText({
      catalogId: "25544",
      name: "ISS (ZARYA)",
      pass: pass(),
      observer: SYDNEY,
    });

    expect(text).toContain("ISS (ZARYA)");
    expect(text).toContain("Sydney Observatory Hill");
    expect(text).toContain("rises WNW");
    expect(text).toContain("78° NE");
    expect(text).toContain("sets ESE");
    expect(text).toContain("6 min");
  });

  it("never includes the observer's coordinates", () => {
    // An observing location is a home address to a few metres, and a share sheet is
    // exactly where someone gives one away without meaning to.
    const text = sharePassText({
      catalogId: "25544",
      name: "ISS (ZARYA)",
      pass: pass(),
      observer: SYDNEY,
    });

    expect(text).not.toContain("33.8688");
    expect(text).not.toContain("151.2093");
    expect(text).not.toMatch(/-?\d+\.\d{4}/);
  });

  it("falls back to a phrase rather than naming a place it was not given", () => {
    const text = sharePassText({
      catalogId: "25544",
      name: "ISS (ZARYA)",
      pass: pass(),
      observer: undefined,
    });
    expect(text).toContain("my observing location");
  });

  it("carries the date, because shared text is read later", () => {
    const text = sharePassText({
      catalogId: "25544",
      name: "ISS (ZARYA)",
      pass: pass(),
      observer: SYDNEY,
    });
    // A bare "19:31" is ambiguous the moment it leaves the app. The exact rendering is
    // the reader's locale; that it includes a month is the property that matters.
    expect(text).toMatch(/Sep|September|09/);
  });

  it("says so when the pass cannot actually be seen", () => {
    // Sharing only the geometry — "peaks at 78°!" — would imply exactly what the rest
    // of this product refuses to imply.
    const shadow = sharePassText({
      catalogId: "25544",
      name: "ISS (ZARYA)",
      pass: pass("SATELLITE_IN_SHADOW"),
      observer: SYDNEY,
    });
    expect(shadow).toContain("Earth's shadow");
    expect(shadow).toContain("not visible");

    const daylight = sharePassText({
      catalogId: "25544",
      name: "ISS (ZARYA)",
      pass: pass("DAYLIGHT"),
      observer: SYDNEY,
    });
    expect(daylight).toContain("daylight");
    expect(daylight).toContain("not visible");
  });

  it("distinguishes a likely pass from a marginal one", () => {
    expect(
      sharePassText({ catalogId: "25544", name: "ISS", pass: pass("LIKELY_VISIBLE"), observer: SYDNEY }),
    ).toContain("Should be visible");
    expect(
      sharePassText({ catalogId: "25544", name: "ISS", pass: pass("POSSIBLY_VISIBLE"), observer: SYDNEY }),
    ).toContain("Might be visible");
  });

  it("always says it is a prediction, not an observation", () => {
    for (const visibility of ["LIKELY_VISIBLE", "DAYLIGHT"] as const) {
      const text = sharePassText({
        catalogId: "25544",
        name: "ISS (ZARYA)",
        pass: pass(visibility),
        observer: SYDNEY,
      });
      expect(text).toContain("Predicted from published orbital elements");
      expect(text).toContain("weather is not included");
      expect(text).not.toMatch(/\blive\b(?! observation)|tracking now|currently at/i);
    }
  });

  it("ends with a link that resolves back to the same object", () => {
    const text = sharePassText({
      catalogId: "25544",
      name: "ISS (ZARYA)",
      pass: pass(),
      observer: SYDNEY,
    });
    expect(text).toContain("https://orbitwatch.app/satellite/25544");
  });
});

describe("shareSatelliteText", () => {
  it("names the object and states how positions are derived", () => {
    const text = shareSatelliteText("20580", "HST");
    expect(text).toContain("HST");
    expect(text).toContain("#20580");
    expect(text).toContain("SGP4/SDP4");
    expect(text).toContain("https://orbitwatch.app/satellite/20580");
  });
});
