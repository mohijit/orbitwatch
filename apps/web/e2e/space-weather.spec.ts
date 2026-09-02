import { expect, test, type Page } from "@playwright/test";

import { FIXTURE_OBJECT_COUNT, PINNED_CLOCK } from "./fixture";

/**
 * Space weather, end to end.
 *
 * The seeded API replays three real captured NOAA SWPC responses through the same
 * ingestion the scheduler runs. The assertions are about the claim the panel makes,
 * not merely that it rendered: this exists to qualify how far a propagated position
 * can be trusted, and a number with no explanation would be decoration.
 */

test.use({ timezoneId: "Australia/Sydney" });

/**
 * Space weather is not open by default; the panel rail starts with only the pass list
 * showing. Both tests below are about what the panel says, so both have to open it.
 */
async function openSpaceWeather(page: Page): Promise<void> {
  await page.getByTestId("panel-toggle-weather").click();
  await expect(page.getByTestId("panel-toggle-weather")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

test("reports current conditions and what they mean for accuracy", async ({ page }) => {
  await page.clock.setFixedTime(PINNED_CLOCK);
  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );
  await openSpaceWeather(page);

  const panel = page.getByTestId("space-weather");
  await expect(panel).toBeVisible({ timeout: 30_000 });

  // Kp from the captured NOAA series, not an invented placeholder.
  await expect(page.getByTestId("space-weather-kp")).toContainText("Kp");
  await expect(page.getByTestId("space-weather-kp")).not.toContainText("—");

  // R/S/G as NOAA publishes them, all zero in the captured document.
  await expect(page.getByTestId("space-weather-scales")).toHaveText("R0 S0 G0");

  // The reason it is here at all. A bare index would be a weather widget.
  await expect(page.getByTestId("space-weather-meaning")).toContainText(/drag/i);
  await expect(panel).toContainText("NOAA");
});

test("says conditions are unknown rather than implying they are calm", async ({ page }) => {
  // Kp 0 means a quiet magnetosphere; no reading at all means nobody has told us.
  // Collapsing the two would have the app report calm during a storm it failed to
  // fetch, which is the one thing this panel must never do.
  await page.route("**/space-weather", (route) => route.abort("failed"));
  await page.goto("/");
  await openSpaceWeather(page);

  await expect(page.getByTestId("space-weather-unavailable")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("space-weather-unavailable")).toContainText(
    "not a quiet magnetosphere",
  );
});
