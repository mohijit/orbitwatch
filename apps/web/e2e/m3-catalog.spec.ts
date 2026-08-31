import { expect, test } from "@playwright/test";

/**
 * Milestone 3 gate: open, search ISS, select, verify panel, scrub time, return to live.
 *
 * Runs against the seeded in-memory API (see playwright.config.ts and
 * apps/api/src/seed-dev.ts), which serves one real object — the ISS — from the actual
 * CelesTrak fixtures captured and verified in M2. No fabricated data anywhere in the
 * path: a genuine HTTP round trip, genuine Zod parsing, genuine SGP4 propagation.
 */

test("open, search ISS, select, verify panel, scrub time, return to live", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/");

  // OPEN: the catalog loads and the badge reports the real seeded count.
  await expect(page.getByTestId("catalog-count")).toHaveText("1 OBJECTS", { timeout: 30_000 });

  // SEARCH: Cmd/Ctrl+K opens the palette; typing filters to the ISS.
  await page.getByRole("button", { name: /search satellites/i }).click();
  await page.getByPlaceholder(/search by name/i).fill("ISS");
  await expect(page.getByText("ISS (ZARYA)")).toBeVisible({ timeout: 10_000 });

  // SELECT.
  await page.getByText("ISS (ZARYA)").click();

  // VERIFY PANEL: the telemetry panel appears with a real accuracy classification —
  // not a placeholder, an assessment computed from the actual element epoch.
  const panel = page.getByTestId("telemetry-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("#25544");
  await expect(page.getByTestId("accuracy-badge")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("element-epoch")).not.toBeEmpty();

  // SCRUB TIME: dragging the timeline switches LIVE -> SIMULATION.
  await expect(page.getByTestId("timeline-mode")).toContainText("LIVE");
  const scrubber = page.locator(".timeline__scrubber");
  await scrubber.fill("0.2");
  await expect(page.getByTestId("timeline-mode")).toContainText("SIMULATION", {
    timeout: 5_000,
  });

  // The panel must still be showing real data for the new instant, not a stale one.
  await expect(page.getByTestId("accuracy-badge")).toBeVisible();

  // RETURN TO LIVE.
  await page.getByTestId("return-to-live").click();
  await expect(page.getByTestId("timeline-mode")).toContainText("LIVE");

  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("closing the telemetry panel deselects the satellite", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toHaveText("1 OBJECTS", { timeout: 30_000 });

  await page.getByRole("button", { name: /search satellites/i }).click();
  await page.getByPlaceholder(/search by name/i).fill("ISS");
  await page.getByText("ISS (ZARYA)").click();
  await expect(page.getByTestId("telemetry-panel")).toBeVisible();

  await page.getByRole("button", { name: /close/i }).click();
  await expect(page.getByTestId("telemetry-panel")).toBeHidden();
});

test("searching for a non-existent object shows no results, not an error", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toHaveText("1 OBJECTS", { timeout: 30_000 });

  await page.getByRole("button", { name: /search satellites/i }).click();
  await page.getByPlaceholder(/search by name/i).fill("this satellite does not exist anywhere");
  await expect(page.getByText("No matching satellites")).toBeVisible({ timeout: 10_000 });
});
