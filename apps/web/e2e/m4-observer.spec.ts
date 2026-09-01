import { expect, test, type Page } from "@playwright/test";

import { FIXTURE_OBJECT_COUNT, PINNED_CLOCK } from "./fixture";

/**
 * Milestone 4 gate: the observer.
 *
 * Look angles and pass times are the first things this product says that are wrong,
 * rather than merely imprecise, if the observing location is wrong — so these tests
 * check both that the numbers appear and that the app refuses to invent a location
 * when it does not have one.
 *
 * DETERMINISM
 * The browser clock is pinned (see fixture.ts) and the timezone is fixed to Sydney.
 * Both are required: pass times are relative to the element epoch, and the pass list
 * deliberately renders in the viewer's own zone, so an unpinned zone would make every
 * displayed time machine-dependent.
 *
 * The expected values below were computed from the committed fixture's real ISS
 * elements at the pinned instant, and are checked against physics rather than against
 * a previous run: at 09:00 local the sun is up, so daytime passes are classified
 * DAYLIGHT however bright the spacecraft is, and the 18:39 local pass is the only one
 * where the observer is in twilight while the satellite is still sunlit.
 */

test.use({ timezoneId: "Australia/Sydney" });

/** Sydney Observatory Hill. Below the ISS inclination, so passes genuinely occur. */
const OBSERVER = { latitude: "-33.8688", longitude: "151.2093" };

async function open(page: Page): Promise<void> {
  await page.clock.setFixedTime(PINNED_CLOCK);
  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );
}

async function selectIss(page: Page): Promise<void> {
  await page.getByRole("button", { name: /search satellites/i }).click();
  await page.getByPlaceholder(/search by name/i).fill("ISS");
  await page.getByText("ISS (ZARYA)", { exact: true }).click();
  await expect(page.getByTestId("telemetry-panel")).toContainText("#25544");
}

async function setObserverManually(page: Page): Promise<void> {
  await page.getByTestId("observer-summary").click();
  await page.getByLabel("Latitude in degrees").fill(OBSERVER.latitude);
  await page.getByLabel("Longitude in degrees").fill(OBSERVER.longitude);
  await page.getByTestId("observer-set-manual").click();
}

test("without a location the app says so rather than guessing one", async ({ page }) => {
  await open(page);

  // No default, no IP lookup, no silently-assumed city. A tracker that guesses gives
  // confident answers for somewhere the user is not.
  await expect(page.getByTestId("observer-summary")).toContainText("No location set");

  await selectIss(page);
  await expect(page.getByTestId("look-angles-no-observer")).toBeVisible();
  await expect(page.getByTestId("pass-list-no-observer")).toBeVisible();
});

test("entering coordinates produces look angles and real passes", async ({ page }) => {
  await open(page);
  await setObserverManually(page);

  await expect(page.getByTestId("observer-summary")).toContainText("33.8688° S");
  await expect(page.getByTestId("observer-summary")).toContainText("151.2093° E");

  // 09:00 local on 1 September: the sun is well up, so the sky must read DAYLIGHT.
  // This is the observer-side half of the visibility rule, computed from the pinned
  // instant and the entered coordinate.
  await expect(page.getByTestId("observer-sky")).toContainText("Daylight");
  await expect(page.getByTestId("observer-sun-altitude")).toContainText("+30.8°");

  await selectIss(page);

  // Look angles: a real azimuth with a compass bearing, a real elevation, a range in
  // the low thousands of km, and a signed range rate. The ISS is just above the
  // eastern horizon at this instant and receding.
  const azimuth = page.getByTestId("look-angles-azimuth");
  await expect(azimuth).toContainText("98.3°");
  await expect(azimuth).toContainText("E");
  await expect(page.getByTestId("look-angles-elevation")).toHaveText("2.9°");
  await expect(page.getByTestId("look-angles-range")).toContainText("2,088 km");
  await expect(page.getByTestId("look-angles-range-rate")).toContainText("receding");
  await expect(page.getByTestId("look-angles-horizon")).toHaveText("Above the horizon");

  // Passes: four in the next 24 hours over this location, which is what the real
  // elements give. A pass list that silently returned nothing would be the easy bug.
  const passes = page.getByTestId("pass-list-item");
  await expect(passes).toHaveCount(4);

  // Every pass must state a maximum elevation and a visibility classification --
  // never a bare time, which would imply the pass is worth going outside for.
  await expect(page.getByTestId("pass-max-elevation").first()).toContainText("max 65°");
  await expect(page.getByTestId("pass-visibility").first()).toHaveText("Daylight");

  // The evening pass is the only one where the observer is in twilight while the
  // spacecraft is still lit. That is the entire naked-eye visibility rule, and it
  // must not be reported for the daytime passes.
  await expect(page.getByTestId("pass-visibility").nth(3)).toHaveText("Possibly visible");
});

test("the observing location survives a reload", async ({ page }) => {
  await open(page);
  await setObserverManually(page);
  await expect(page.getByTestId("observer-summary")).toContainText("33.8688° S");

  await page.reload();
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );

  // Restored from local storage, and still labelled as hand-entered: provenance has
  // to survive too, or a coordinate typed months ago looks like a device fix.
  await expect(page.getByTestId("observer-summary")).toContainText("33.8688° S");
  await page.getByTestId("observer-summary").click();
  await expect(page.getByTestId("observer-provenance")).toContainText("Entered by hand");
});

test("a stored location that no longer parses is discarded, not repaired", async ({ page }) => {
  await page.clock.setFixedTime(PINNED_CLOCK);
  await page.goto("/");

  // A latitude of 200 degrees is not a place. Writing it back as 90, or using it as
  // it stands, would both produce confident nonsense; the app must forget it.
  await page.evaluate(() => {
    window.localStorage.setItem(
      "orbitwatch.observer.v1",
      JSON.stringify({
        latitude: 200,
        longitude: 0,
        altitude: 0,
        source: "MANUAL",
        savedAt: "2026-08-31T00:00:00.000Z",
      }),
    );
  });
  await page.reload();

  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("observer-summary")).toContainText("No location set");
});

test("picking on the globe sets the location", async ({ page }) => {
  await open(page);

  await page.getByTestId("observer-summary").click();
  await page.getByTestId("observer-pick-globe").click();

  // The mode is announced, because a click on the globe now means something different
  // from what it meant a moment ago.
  await expect(page.getByTestId("picking-hint")).toBeVisible();

  // The camera looks at 20E 15N from 26,000 km, so the centre of the viewport is on
  // the globe rather than off its limb.
  const canvas = page.locator(".globe-canvas canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(
    (box?.x ?? 0) + (box?.width ?? 0) / 2,
    (box?.y ?? 0) + (box?.height ?? 0) / 2,
  );

  // Picking mode ends on the first click, and the location is recorded as coming from
  // the globe rather than being passed off as a measured fix.
  await expect(page.getByTestId("picking-hint")).toBeHidden();
  await expect(page.getByTestId("observer-summary")).not.toContainText("No location set");
  // The panel is still open from the click that started picking, so provenance is
  // already on screen; clicking the summary again would toggle it shut.
  await expect(page.getByTestId("observer-provenance")).toContainText("Picked on the globe");
});
