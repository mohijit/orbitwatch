import { describe, expect, it } from "vitest";

import {
  GIBS_ATTRIBUTION,
  GIBS_BASE_MATRIX,
  GIBS_LAYERS,
  GIBS_LEVEL_ZERO_TILES_X,
  GIBS_LEVEL_ZERO_TILES_Y,
  GIBS_TILE_SIZE,
  IMAGERY_LAG_DAYS,
  findGibsLayer,
  gibsMaximumLevel,
  gibsTileMatrixLabels,
  gibsTileUrl,
  imageryCaveat,
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

  it("uses each layer's own declared format", () => {
    // Requesting the wrong extension returns a 404, which renders as a blank globe
    // rather than an error — so the extension has to come from the layer, never from a
    // default that happens to suit whichever product was added first.
    for (const layer of GIBS_LAYERS) {
      expect(gibsTileUrl(layer, "2026-09-01").endsWith(`.${layer.format}`)).toBe(true);
    }
  });

  it("dates a daily product and does not date a fixed one", () => {
    /*
     * A fixed product has no Time dimension. The date segment is not ignored by GIBS —
     * it addresses a different resource, which does not exist. City lights is the same
     * map every night, so there is no date to put there in the first place.
     */
    expect(gibsTileUrl(trueColor!, "2026-09-01")).toContain("/default/2026-09-01/250m/");

    const night = findGibsLayer("night-lights")!;
    expect(night.cadence).toBe("fixed");
    expect(gibsTileUrl(night, "2026-09-01")).toContain("/default/500m/");
    expect(gibsTileUrl(night, "2026-09-01")).not.toContain("2026-09-01");
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

  it("shows city lights rather than at-sensor radiance", () => {
    /*
     * The trap this locks out.
     *
     * VIIRS_SNPP_DayNightBand_At_Sensor_Radiance is the obvious pick for a layer called
     * "night lights" and is the wrong one: it is radiance across the whole disc, so the
     * daylit half is sunlight and the half a user is looking at shows no city lights at
     * all. It renders perfectly well while showing nothing the label promises.
     */
    const night = findGibsLayer("night-lights");
    expect(night?.product).toBe("VIIRS_CityLights_2012");
    expect(night?.product).not.toContain("At_Sensor_Radiance");
    // The description has to admit it is not tonight, since the label suggests it is.
    expect(night?.description).toContain("same map every night");
  });

  it("credits NASA", () => {
    expect(GIBS_ATTRIBUTION).toContain("NASA");
    expect(GIBS_ATTRIBUTION).toContain("GIBS");
  });
});

/*
 * The tile grid.
 *
 * These numbers are not preferences, they are transcribed from the service's own
 * WMTSCapabilities, and both of the bugs this file now guards against were silent:
 * neither produced an error anywhere a user or a test could see, only a layer that
 * did nothing and a layer drawn in the wrong place.
 */
describe("tile matrix sets", () => {
  it("asks for each layer in the matrix set it is actually published in", () => {
    // Night lights is 500m only. Requesting it at 250m returns
    // `TILEMATRIXSET is invalid for LAYER` on every tile, and a layer whose every tile
    // 400s looks exactly like a layer that is switched off.
    expect(findGibsLayer("true-color")?.tileMatrixSet).toBe("250m");
    expect(findGibsLayer("night-lights")?.tileMatrixSet).toBe("500m");

    expect(gibsTileUrl(findGibsLayer("true-color")!, "2026-09-01")).toContain("/250m/");
    expect(gibsTileUrl(findGibsLayer("night-lights")!, "2026-09-01")).toContain("/500m/");
  });

  it("does not share one matrix set across layers", () => {
    // The regression, stated directly: the URL builder used to hard-code 250m, so this
    // is the assertion that fails if anyone reintroduces a single shared value.
    const sets = new Set(GIBS_LAYERS.map((layer) => layer.tileMatrixSet));
    expect(sets.size).toBeGreaterThan(1);
  });

  it("starts at the first matrix that tiles the globe exactly", () => {
    /*
     * GIBS matrix widths are ceil(360 / tile size), so the shallow levels overhang the
     * world: matrix 0 is 2 tiles of 288 degrees (576 total), matrix 1 is 3 of 144
     * (432), matrix 2 is 5 of 72 (360 wide but 216 tall). Matrix 3 is 10 x 5 tiles of
     * 36 degrees — 360 x 180 exactly — and it doubles cleanly from there, which is the
     * only shape GeographicTilingScheme can express.
     */
    expect(GIBS_BASE_MATRIX).toBe(3);
    expect(GIBS_LEVEL_ZERO_TILES_X * 36).toBe(360);
    expect(GIBS_LEVEL_ZERO_TILES_Y * 36).toBe(180);
    expect(GIBS_TILE_SIZE).toBe(512);
  });

  it("maps every Cesium level to a published GIBS matrix", () => {
    for (const layer of GIBS_LAYERS) {
      const labels = gibsTileMatrixLabels(layer);

      // Cesium level 0 must request matrix 3, not matrix 0. Getting this wrong asks a
      // 288-degree tile to fill a 36-degree rectangle, which is the squeeze bug.
      expect(labels[0]).toBe(String(GIBS_BASE_MATRIX));
      expect(labels.at(-1)).toBe(String(layer.deepestMatrix));

      // One label per level, or Cesium substitutes its own level number past the end
      // of the array and requests a matrix that does not exist.
      expect(labels).toHaveLength(gibsMaximumLevel(layer) + 1);
      expect(labels).toEqual(labels.map((_, level) => String(level + GIBS_BASE_MATRIX)));
    }
  });

  it("stops at each layer's deepest published matrix", () => {
    // 250m publishes matrices 0-8, 500m only 0-7. Asking one level too deep returns an
    // exception, which Cesium renders as a hole rather than an error.
    expect(gibsMaximumLevel(findGibsLayer("true-color")!)).toBe(5);
    expect(gibsMaximumLevel(findGibsLayer("night-lights")!)).toBe(4);
  });
});

describe("imageryCaveat", () => {
  it("names the date for a daily product", () => {
    expect(imageryCaveat(findGibsLayer("true-color")!, new Date("2026-09-02T12:00:00Z"))).toBe(
      "Imagery from 2026-09-01 · satellite positions are live",
    );
  });

  it("does not invent a date for a fixed product", () => {
    // The failure worth preventing: a fixed composite stamped with today's date reads
    // as an observation of tonight, which is exactly the conflation the layer's whole
    // presentation is built to avoid.
    const caveat = imageryCaveat(findGibsLayer("night-lights")!, new Date("2026-09-02T12:00:00Z"));
    expect(caveat).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(caveat).toContain("Fixed composite");
  });

  it("always says the positions are live, whatever the imagery is", () => {
    // The one invariant across every layer: whatever the imagery's age, the satellites
    // drawn over it are where they are now, and a reader must not have to infer that.
    for (const layer of GIBS_LAYERS) {
      expect(imageryCaveat(layer, new Date())).toContain("satellite positions are live");
    }
  });
});
