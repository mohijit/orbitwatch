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
