import { expect, test } from "@playwright/test";

import { FIXTURE_OBJECT_COUNT } from "./fixture";

/**
 * NASA GIBS imagery.
 *
 * WHAT CAN AND CANNOT BE VERIFIED HERE
 * GIBS is a tile service, not an ingestion provider: there is nothing stored and no
 * schema to validate, so the usual bar — real call, captured fixture, ingestion test —
 * does not apply. What can be checked is that the layer resolves to real NASA tile
 * requests, and that the dated-imagery caveat is on screen whenever the layer is on.
 * The second is the one that matters: a daily composite under live satellite positions
 * is a conflation of observation time and position time, and it is only honest because
 * it is labelled.
 *
 * The tile requests are intercepted rather than allowed out to NASA. The suite must
 * not depend on a third party being up, and one guarded verification of reachability
 * belongs in scripts/verify-providers.ts, not in a test that runs on every commit.
 */

/**
 * GIBS's own tile-range rule, applied locally.
 *
 * The service rejects an out-of-range tile with `TileOutOfRange` and a 400, but the
 * suite intercepts the requests rather than letting them out to NASA, so nothing would
 * notice. Reproducing the rule here keeps that check without the dependency.
 *
 * Every EPSG:4326 matrix set is 512-pixel tiles from (-180, 90) at 0.5625 deg/pixel on
 * matrix 0, halving each matrix, with the grid sized by ceil. That reproduces the
 * published table exactly: 2x1, 3x2, 5x3, 10x5, 20x10 ... 320x160.
 */
function gridAt(matrix: number): { readonly cols: number; readonly rows: number } {
  const tileDegrees = 288 / 2 ** matrix;
  return {
    cols: Math.ceil(360 / tileDegrees),
    rows: Math.ceil(180 / tileDegrees),
  };
}

interface TileRequest {
  readonly date: string | undefined;
  readonly matrixSet: string;
  readonly matrix: number;
  readonly row: number;
  readonly col: number;
}

/**
 * The date segment is optional because not every GIBS product has one: a fixed
 * composite has no Time dimension and rejects a date rather than ignoring it.
 */
function parseTile(url: string): TileRequest {
  // .../default[/<date>]/<matrixSet>/<matrix>/<row>/<col>.<ext>
  const match =
    /\/default\/(?:(\d{4}-\d{2}-\d{2})\/)?([^/]+)\/(\d+)\/(\d+)\/(\d+)\.\w+$/.exec(url);
  if (match === null) {
    throw new Error(`not a GIBS tile URL: ${url}`);
  }
  return {
    date: match[1],
    matrixSet: match[2]!,
    matrix: Number(match[3]),
    row: Number(match[4]),
    col: Number(match[5]),
  };
}

async function openImageryPanel(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );
  // The picker lives in the panel stack now. It used to be absolutely positioned over
  // the globe, underneath the context panels, where it could not be clicked at all.
  await page.getByTestId("panel-toggle-imagery").click();
  await expect(page.getByTestId("imagery-picker")).toBeVisible();
}

test("the base map is the default, with no imagery caveat shown", async ({ page }) => {
  await openImageryPanel(page);

  // Off by default: GIBS is dated and needs the network, where the bundled Natural
  // Earth base map is neither.
  await expect(page.getByTestId("imagery-date")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /base map/i })).toBeChecked();
});

test("turning imagery on requests NASA tiles and states the date", async ({ page }) => {
  const requested: string[] = [];
  // Intercepted: the suite must not depend on NASA being reachable, and a real fetch
  // would make every run slower and flakier for no extra information.
  await page.route("**/gibs.earthdata.nasa.gov/**", (route) => {
    requested.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
  });

  await openImageryPanel(page);
  await expect(page.locator("canvas")).toBeVisible({ timeout: 60_000 });

  await page.getByRole("radio", { name: /earth today/i }).check();

  // The caveat appears with the layer, not somewhere a reader might miss.
  const caveat = page.getByTestId("imagery-date");
  await expect(caveat).toBeVisible();
  await expect(caveat).toContainText("satellite positions are live");
  await expect(caveat).toContainText(/Imagery from \d{4}-\d{2}-\d{2}/);

  await expect.poll(() => requested.length, { timeout: 30_000 }).toBeGreaterThan(0);

  // The right product, the right projection, and a real date rather than a template
  // placeholder left unsubstituted.
  const first = requested[0] ?? "";
  expect(first).toContain("VIIRS_SNPP_CorrectedReflectance_TrueColor");
  expect(first).toContain("/wmts/epsg4326/best/");
  expect(first).toMatch(/\/default\/\d{4}-\d{2}-\d{2}\//);
  expect(first).not.toContain("{TileMatrix}");

  /*
   * Every tile asked for must be one GIBS would actually serve.
   *
   * This is the check that catches the squeeze bug. Cesium's tiling scheme is a
   * power-of-two pyramid and GIBS's grid is not, so pointing the default scheme at it
   * produced tiles that were individually well-formed and collectively wrong: matrix 0
   * covers 288 degrees per tile and was being painted into a 36-degree rectangle,
   * condensing the imagery into a corner of the globe. Anchoring Cesium's level zero
   * on matrix 3 is what makes the two grids agree, and asserting the matrix number is
   * at least 3 is how that stays true.
   */
  const tiles = requested.map(parseTile);
  expect(tiles.length).toBeGreaterThan(0);

  for (const tile of tiles) {
    expect(tile.matrixSet).toBe("250m");
    expect(tile.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Matrices 0-2 overhang the world and cannot be addressed by a geographic
    // rectangle at all; 8 is the deepest 250m publishes.
    expect(tile.matrix).toBeGreaterThanOrEqual(3);
    expect(tile.matrix).toBeLessThanOrEqual(8);

    const grid = gridAt(tile.matrix);
    expect(tile.col).toBeLessThan(grid.cols);
    expect(tile.row).toBeLessThan(grid.rows);
  }

  // A whole-globe view is one full matrix-3 grid, so the imagery covers the Earth
  // rather than part of it. Fewer than a globe's worth of distinct tiles is the
  // signature of the imagery being drawn somewhere too small.
  const covered = new Set(
    tiles.filter((tile) => tile.matrix === 3).map((tile) => `${tile.row}/${tile.col}`),
  );
  expect(covered.size).toBeGreaterThan(10);
});

test("night lights is requested as an undated 500m composite", async ({ page }) => {
  const requested: string[] = [];
  await page.route("**/gibs.earthdata.nasa.gov/**", (route) => {
    requested.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
  });

  await openImageryPanel(page);
  await expect(page.locator("canvas")).toBeVisible({ timeout: 60_000 });

  await page.getByRole("radio", { name: /night lights/i }).check();
  await expect.poll(() => requested.length, { timeout: 30_000 }).toBeGreaterThan(0);

  /*
   * The bug this replaces: the matrix set was hard-coded to 250m for both layers, and
   * the day/night band is only published at 500m. GIBS answered every single tile with
   * `TILEMATRIXSET is invalid for LAYER` and a 400, so selecting the layer appeared to
   * do nothing whatsoever — no error, no change, no clue.
   */
  for (const tile of requested.map(parseTile)) {
    expect(tile.matrixSet).toBe("500m");
    // A fixed composite has no Time dimension; a date here addresses a resource that
    // does not exist, which is the same silent all-400s failure in a new costume.
    expect(tile.date).toBeUndefined();
    expect(tile.matrix).toBeGreaterThanOrEqual(3);
    // 500m stops one matrix shallower than 250m.
    expect(tile.matrix).toBeLessThanOrEqual(7);

    const grid = gridAt(tile.matrix);
    expect(tile.col).toBeLessThan(grid.cols);
    expect(tile.row).toBeLessThan(grid.rows);
  }

  expect(requested.every((url) => url.includes("VIIRS_CityLights_2012"))).toBe(true);
  expect(requested.every((url) => url.endsWith(".jpg"))).toBe(true);

  // The caveat has to change with the layer: a fixed map dated to today would read as
  // an observation of tonight.
  const caveat = page.getByTestId("imagery-date");
  await expect(caveat).toContainText("Fixed composite");
  await expect(caveat).toContainText("satellite positions are live");
  await expect(caveat).not.toContainText(/\d{4}-\d{2}-\d{2}/);
});

test("switching back to the base map removes the caveat", async ({ page }) => {
  await page.route("**/gibs.earthdata.nasa.gov/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/jpeg", body: "" }),
  );

  await openImageryPanel(page);
  await expect(page.locator("canvas")).toBeVisible({ timeout: 60_000 });

  await page.getByRole("radio", { name: /night lights/i }).check();
  await expect(page.getByTestId("imagery-date")).toBeVisible();

  // The caveat must not outlive the layer it describes.
  await page.getByRole("radio", { name: /base map/i }).check();
  await expect(page.getByTestId("imagery-date")).toHaveCount(0);
});
