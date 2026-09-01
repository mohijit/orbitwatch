import { expect, test, type Page } from "@playwright/test";

import { FIXTURE_OBJECT_COUNT, PINNED_CLOCK, SCRUB } from "./fixture";

/**
 * Milestone 3 gate: open, search ISS, select, verify panel, scrub time, return to live.
 *
 * Runs against the seeded in-memory API (see playwright.config.ts and
 * apps/api/src/seed-dev.ts), which ingests 32 real CelesTrak GP records through the
 * real ingestion pipeline. No fabricated data anywhere in the path: a genuine HTTP
 * round trip, genuine Zod parsing, genuine SGP4 propagation.
 *
 * This file walks one object deliberately — it is the user journey, and a journey is
 * followed by one satellite at a time. What it adds now is that the object is picked
 * out of a corpus of 32 rather than being the only thing present, so "found the ISS"
 * means the search and selection path actually discriminated. The corpus-scale
 * properties are covered separately in multi-object.spec.ts.
 *
 * The clock is pinned (see fixture.ts): every accuracy claim here is relative to an
 * element epoch, so without pinning these assertions would slowly change meaning as
 * real time moves away from the fixture and eventually stop testing anything.
 */

async function open(page: Page): Promise<void> {
  await page.clock.setFixedTime(PINNED_CLOCK);
  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );
}

test("open, search ISS, select, verify panel, scrub time, return to live", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  // React reports hydration mismatches as an uncaught error, not console.error, so a
  // console-only listener silently passes a page that fails to hydrate.
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

  // OPEN: the catalog loads and the badge reports the real seeded count.
  await open(page);

  // SEARCH: Cmd/Ctrl+K opens the palette; typing filters the corpus down to the ISS.
  await page.getByRole("button", { name: /search satellites/i }).click();
  await page.getByPlaceholder(/search by name/i).fill("ISS");
  await expect(page.getByText("ISS (ZARYA)", { exact: true })).toBeVisible({ timeout: 10_000 });

  // SELECT.
  await page.getByText("ISS (ZARYA)", { exact: true }).click();

  // VERIFY PANEL: the telemetry panel appears with a real accuracy classification —
  // not a placeholder, an assessment computed from the actual element epoch.
  const panel = page.getByTestId("telemetry-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("#25544");
  await expect(page.getByTestId("accuracy-badge")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("element-epoch")).not.toBeEmpty();

  // The orbit class must be derived from this object's own elements, not left unset.
  // UNKNOWN here would mean the accuracy assessment fell back to its default bands,
  // which for a non-LEO object silently reports the wrong confidence.
  await expect(page.getByTestId("orbit-class")).toHaveText("LEO");

  // The accuracy label encodes hours-from-epoch ("NOMINAL · 12h"), so it is the
  // evidence that the panel recomputed for a new instant rather than showing a stale one.
  const liveLabel = await page.getByTestId("element-epoch").textContent();

  // SCRUB TIME: dragging the timeline switches LIVE -> SIMULATION.
  await expect(page.getByTestId("timeline-mode")).toContainText("LIVE");
  const scrubber = page.locator(".timeline__scrubber");

  // The seeded database holds a single element set per object, so the target must land
  // AFTER that set's epoch for historical replay to resolve anything; scrubbing
  // further back is the separate "no data that far back" case below.
  await scrubber.fill(String(SCRUB.resolvable));
  await expect(page.getByTestId("timeline-mode")).toContainText("SIMULATION", {
    timeout: 5_000,
  });

  // The panel must be showing real data for the NEW instant, not the live one. The
  // element set is unchanged, so only the distance from its epoch can have moved.
  await expect(page.getByTestId("accuracy-badge")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("element-epoch")).not.toHaveText(liveLabel ?? "", {
    timeout: 15_000,
  });

  // RETURN TO LIVE.
  await page.getByTestId("return-to-live").click();
  await expect(page.getByTestId("timeline-mode")).toContainText("LIVE");

  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("closing the telemetry panel deselects the satellite", async ({ page }) => {
  await open(page);

  await page.getByRole("button", { name: /search satellites/i }).click();
  await page.getByPlaceholder(/search by name/i).fill("ISS");
  await page.getByText("ISS (ZARYA)", { exact: true }).click();
  await expect(page.getByTestId("telemetry-panel")).toBeVisible();

  await page.getByRole("button", { name: /close/i }).click();
  await expect(page.getByTestId("telemetry-panel")).toBeHidden();
});

test("searching for a non-existent object shows no results, not an error", async ({ page }) => {
  await open(page);

  await page.getByRole("button", { name: /search satellites/i }).click();
  await page.getByPlaceholder(/search by name/i).fill("this satellite does not exist anywhere");
  await expect(page.getByText("No matching satellites")).toBeVisible({ timeout: 10_000 });
});

test("scrubbing past the earliest element set reports no data, not a stale position", async ({
  page,
}) => {
  await open(page);

  await page.getByRole("button", { name: /search satellites/i }).click();
  await page.getByPlaceholder(/search by name/i).fill("ISS");
  await page.getByText("ISS (ZARYA)", { exact: true }).click();
  await expect(page.getByTestId("accuracy-badge")).toBeVisible({ timeout: 10_000 });

  // Before the epoch of the only element set the seed holds for this object. The
  // honest outcome is "we have nothing for that moment" — never the previous position
  // left on screen, which would silently present one instant's data as another's.
  await page.locator(".timeline__scrubber").fill(String(SCRUB.beforeData));
  await expect(page.getByTestId("timeline-mode")).toContainText("SIMULATION", {
    timeout: 5_000,
  });

  await expect(page.locator(".telemetry-panel__status--error")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("accuracy-badge")).toBeHidden();
});
