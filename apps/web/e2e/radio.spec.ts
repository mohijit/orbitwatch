import { expect, test, type Page } from "@playwright/test";

import { FIXTURE_OBJECT_COUNT, PINNED_CLOCK } from "./fixture";

/**
 * Radio, end to end.
 *
 * The seeded API replays a real captured SatNOGS response — 50 ISS transmitters —
 * through the same ingestion the scheduled worker runs. So this exercises the whole
 * path: provider schema, normalisation, the store, the endpoint and the panel, against
 * frequencies SatNOGS actually published.
 *
 * The assertions are deliberately about values a radio amateur would recognise. A test
 * that only checked "some rows appeared" would pass just as happily on a unit error,
 * and a unit error here means someone tunes to the wrong place.
 */

test.use({ timezoneId: "Australia/Sydney" });

async function selectIss(page: Page): Promise<void> {
  await page.clock.setFixedTime(PINNED_CLOCK);
  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );

  await page.getByRole("button", { name: /search satellites/i }).click();
  await page.getByPlaceholder(/search by name/i).fill("ISS");
  await page.getByText("ISS (ZARYA)", { exact: true }).click();
  await expect(page.getByTestId("accuracy-badge")).toBeVisible({ timeout: 60_000 });
}

test("shows what the ISS transmits, at the right frequencies", async ({ page }) => {
  await selectIss(page);

  const panel = page.getByTestId("radio-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });

  const transmitters = page.getByTestId("radio-transmitter");
  await expect(transmitters.first()).toBeVisible();

  // 145.825 MHz is the ISS APRS digipeater — a real, checkable frequency, and exactly
  // where a factor of a thousand would hide. Rendered to the kilohertz because someone
  // is going to type it into a receiver.
  await expect(panel).toContainText("145.825 MHz");

  // Only active transmitters. The captured response contains dead ones too, and a
  // ground station tuning to a decommissioned downlink hears nothing while believing
  // the tracker.
  const count = await transmitters.count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThan(50);
});

test("credits SatNOGS, because the licence requires it", async ({ page }) => {
  await selectIss(page);

  // CC BY-SA 4.0. The text travels with the data from the API rather than being
  // written into the component, so it cannot be lost by editing the UI.
  const attribution = page.getByTestId("radio-attribution");
  await expect(attribution).toBeVisible({ timeout: 30_000 });
  await expect(attribution).toContainText("SatNOGS");
  await expect(attribution).toContainText("CC BY-SA");
});

test("says an object has no published radio rather than showing nothing", async ({ page }) => {
  await page.clock.setFixedTime(PINNED_CLOCK);
  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );

  // TDRS 3 is in the corpus and has no transmitters in the seeded SatNOGS data. An
  // empty panel would be indistinguishable from a failed lookup; the difference
  // matters, so it is stated.
  await page.getByRole("button", { name: /search satellites/i }).click();
  await page.getByPlaceholder(/search by name/i).fill("TDRS 3");
  await page.getByText("TDRS 3", { exact: true }).click();
  await expect(page.getByTestId("accuracy-badge")).toBeVisible({ timeout: 60_000 });

  await expect(page.getByTestId("radio-empty")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("radio-empty")).toContainText("No active transmitters");
});
