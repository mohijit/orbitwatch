import { expect, test } from "@playwright/test";

import { FIXTURE_OBJECT_COUNT, PINNED_CLOCK } from "./fixture";

/**
 * Upcoming launches, end to end.
 *
 * The seeded API replays a real captured Launch Library `mode=detailed` page through
 * the same ingestion the scheduler runs, with the server's clock pinned just before the
 * earliest launch in it so "upcoming" means what it says.
 *
 * THE ASSERTION THAT MATTERS IS ABOUT PRECISION
 * LL2 sends a full ISO timestamp for every launch and, separately, how precise it
 * actually is. The captured page contains one launch accurate to the MINUTE and one
 * only to the HOUR. Rendering both identically would be inventing precision — the
 * failure this panel exists to avoid — so the test checks that the coarser one is
 * qualified on screen.
 */

test.use({ timezoneId: "Australia/Sydney" });

test("lists the next launches with their real detail", async ({ page }) => {
  await page.clock.setFixedTime(PINNED_CLOCK);
  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );

  const panel = page.getByTestId("launches");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("launch")).not.toHaveCount(0);

  // Real values from the captured page — the fields `mode=list` omits and that make a
  // launch legible at all.
  await expect(panel).toContainText("Rocket Lab");
  await expect(panel).toContainText("New Zealand");

  // Attribution travels with the data from the API.
  await expect(panel).toContainText("Launch Library");
});

test("never shows more precision than the provider claims", async ({ page }) => {
  await page.clock.setFixedTime(PINNED_CLOCK);
  await page.goto("/");
  await expect(page.getByTestId("launches")).toBeVisible({ timeout: 30_000 });

  // The Pallas-1 demo flight is published as accurate to the hour, so its time must be
  // qualified rather than presented as a to-the-minute T-0. A launch known to the
  // minute carries no qualifier.
  const qualifiers = page.getByTestId("launch-qualifier");
  await expect(qualifiers).toHaveCount(1);
  await expect(qualifiers.first()).toContainText("±1 hour");

  // And the qualifier belongs to the hour-precision launch, not an arbitrary row.
  const hourly = page.getByTestId("launch").filter({ hasText: "Pallas-1" });
  await expect(hourly.getByTestId("launch-qualifier")).toContainText("±1 hour");
});
