import { describe, expect, it } from "vitest";

import {
  GIBS_ATTRIBUTION,
  GIBS_LAYERS,
  IMAGERY_LAG_DAYS,
  findGibsLayer,
  gibsTileUrl,
  imageryDateFor,
} from "./imagery";

/**
 * GIBS layer selection and URL construction.
 *
 * The date arithmetic is the part worth testing: it is pure, it is easy to get wrong in
 * a way that silently returns no tiles, and the failure looks like "the imagery is
 * broken" rather than "the date was computed in the wrong timezone".
 */

describe("imageryDateFor", () => {
  it("asks for a day behind, because today's composite is often not ready", () => {
    // GIBS assembles the daily composite through the day. Asking for today early
    // returns nothing, and a missing tile is worse than a day-old one — especially
    // since the date is displayed rather than hidden.
    expect(imageryDateFor(new Date("2026-09-02T12:00:00Z"))).toBe("2026-09-01");
    expect(IMAGERY_LAG_DAYS).toBe(1);
  });

  it("uses UTC, not the viewer's local date", () => {
    /*
     * The case that breaks a naive implementation.
     *
     * 2026-09-02T22:00Z is already 3 September in Sydney. A local-date implementation
     * would ask for 2 September imagery there and 1 September in London for the same
     * instant — and east of Greenwich it can request a date GIBS has not published at
     * all, returning nothing. GIBS composites are defined on UTC days, so the request
     * must be too.
     */
    expect(imageryDateFor(new Date("2026-09-02T22:00:00Z"))).toBe("2026-09-01");
    expect(imageryDateFor(new Date("2026-09-02T01:00:00Z"))).toBe("2026-09-01");
  });

  it("crosses a month boundary correctly", () => {
    expect(imageryDateFor(new Date("2026-09-01T06:00:00Z"))).toBe("2026-08-31");
  });

  it("crosses a year boundary correctly", () => {
    expect(imageryDateFor(new Date("2027-01-01T06:00:00Z"))).toBe("2026-12-31");
  });

  it("honours an explicit lag", () => {
    expect(imageryDateFor(new Date("2026-09-10T00:00:00Z"), 0)).toBe("2026-09-10");
    expect(imageryDateFor(new Date("2026-09-10T00:00:00Z"), 7)).toBe("2026-09-03");
  });
});

describe("gibsTileUrl", () => {
  const trueColor = findGibsLayer("true-color");

  it("builds a WMTS template with Cesium's placeholders left intact", () => {
    expect(trueColor).toBeDefined();
    const url = gibsTileUrl(trueColor!, "2026-09-01");

    expect(url).toContain("gibs.earthdata.nasa.gov/wmts/epsg4326/best");
    expect(url).toContain("VIIRS_SNPP_CorrectedReflectance_TrueColor");
    expect(url).toContain("/default/2026-09-01/");
    // Substituted by Cesium at request time, so they must survive verbatim.
    expect(url).toContain("{TileMatrix}");
    expect(url).toContain("{TileRow}");
    expect(url).toContain("{TileCol}");
  });

  it("uses each layer's own format", () => {
    // Night lights are published as PNG and true colour as JPEG. Requesting the wrong
    // extension returns a 404, which renders as a blank globe rather than an error.
    const night = findGibsLayer("night-lights");
    expect(gibsTileUrl(trueColor!, "2026-09-01").endsWith(".jpg")).toBe(true);
    expect(gibsTileUrl(night!, "2026-09-01").endsWith(".png")).toBe(true);
  });

  it("is https, always", () => {
    for (const layer of GIBS_LAYERS) {
      expect(gibsTileUrl(layer, "2026-09-01").startsWith("https://")).toBe(true);
    }
  });
});

describe("layer definitions", () => {
  it("gives every layer a description that says what it does not show", () => {
    // The whole risk of this feature is a dated composite under live satellites. Each
    // description has to carry its own caveat, because the layer picker is where
    // someone decides to turn it on.
    for (const layer of GIBS_LAYERS) {
      expect(layer.description.length).toBeGreaterThan(40);
    }
    expect(findGibsLayer("true-color")?.description).toContain("not for right now");
  });

  it("returns nothing for an unknown id rather than a default layer", () => {
    // Silently falling back would render one layer while the UI claimed another.
    expect(findGibsLayer("does-not-exist")).toBeUndefined();
  });

  it("credits NASA", () => {
    expect(GIBS_ATTRIBUTION).toContain("NASA");
    expect(GIBS_ATTRIBUTION).toContain("GIBS");
  });
});
