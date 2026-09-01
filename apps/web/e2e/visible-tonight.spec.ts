import { expect, test, type Page } from "@playwright/test";

import { FIXTURE_OBJECT_COUNT, PINNED_CLOCK, VISUAL_OBJECT_COUNT } from "./fixture";

/**
 * Milestone 4: "Visible Tonight".
 *
 * This is the feature with the most room to mislead, so the assertions are about what
 * it refuses to claim as much as what it shows.
 *
 * THE SCOPE IS THE POINT
 * The search covers CelesTrak's `visual` group, not the catalog. Measured against the
 * real 16,500-object catalog for one night over Sydney, the same lighting rule yields
 * about 3,614 "optically favourable" passes — nearly all Starlink and debris nobody
 * can pick out — because GP elements carry no size, albedo, shape or attitude to
 * filter on. Group membership is the only published statement about which objects can
 * be seen, and the panel says so on screen rather than implying a completeness it does
 * not have.
 *
 * DETERMINISM
 * Clock pinned and timezone fixed to Sydney (see fixture.ts). The pinned instant is
 * mid-morning local, which puts the next darkness window at that evening's dusk — the
 * only geometry in which anything is naked-eye visible, and therefore the case worth
 * testing. Pinning to the middle of the night instead put every object in Earth's
 * shadow: correct physics, and a useless test.
 */

test.use({ timezoneId: "Australia/Sydney" });

const OBSERVER = { latitude: "-33.8688", longitude: "151.2093" };

async function openWithObserver(page: Page): Promise<void> {
  await page.clock.setFixedTime(PINNED_CLOCK);
  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );

  await page.getByTestId("observer-summary").click();
  await page.getByLabel("Latitude in degrees").fill(OBSERVER.latitude);
  await page.getByLabel("Longitude in degrees").fill(OBSERVER.longitude);
  await page.getByTestId("observer-set-manual").click();
  // Close the observer panel so it does not overlay the list.
  await page.getByTestId("observer-summary").click();
}

test("without a location it asks for one instead of guessing", async ({ page }) => {
  await page.clock.setFixedTime(PINNED_CLOCK);
  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );

  // Which passes are visible depends entirely on where you are. With no location there
  // is no honest answer, and an empty list would read as "nothing tonight".
  await expect(page.getByTestId("visible-tonight-no-observer")).toBeVisible();
});

test("finds the dusk passes and rejects the ones in Earth's shadow", async ({ page }) => {
  await openWithObserver(page);

  // The search runs in the propagation worker over the whole darkness window, so give
  // it room; it is seconds of SGP4, not a request.
  await expect(page.getByTestId("visible-tonight-window")).toBeVisible({ timeout: 60_000 });

  // Only the curated group is searched, and the panel reports how many that was.
  await expect(page.getByTestId("visible-tonight-window")).toContainText(
    `${VISUAL_OBJECT_COUNT} bright objects searched`,
  );

  // Two of the eight are sunlit while Sydney is dark, both shortly after dusk. The
  // others pass overhead later that night and are in Earth's shadow, so they are
  // correctly absent — a list that showed all of them would be reporting geometry and
  // calling it visibility.
  const passes = page.getByTestId("visible-tonight-pass");
  await expect(passes).toHaveCount(2);

  const names = page.getByTestId("visible-tonight-name");
  await expect(names.nth(0)).toHaveText("COSMO-SKYMED 1");
  await expect(names.nth(1)).toHaveText("AJISAI (EGS)");

  // Both are dusk passes: 18:39 and 18:43 local, minutes after the sky goes dark.
  await expect(passes.nth(0)).toContainText("18:39");
  await expect(passes.nth(1)).toContainText("18:43");

  // TERRA passes at 75 degrees later the same night — higher than either of the two
  // above — and must NOT be listed, because elevation is not visibility.
  await expect(page.getByText("TERRA", { exact: true })).toBeHidden();
});

test("states the scope on screen rather than implying the whole catalog", async ({ page }) => {
  await openWithObserver(page);
  await expect(page.getByTestId("visible-tonight-window")).toBeVisible({ timeout: 60_000 });

  // A user has to be able to tell that this is not "every satellite you could see".
  const panel = page.getByTestId("visible-tonight");
  await expect(panel).toContainText("visual");
  await expect(panel).toContainText("not the full catalog");
  await expect(panel).toContainText("no brightness data");
});
