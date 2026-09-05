import { expect, test, type Page } from "@playwright/test";

import { FIXTURE_OBJECT_COUNT } from "./fixture";

/**
 * The panel rail.
 *
 * The four context panels used to be one stacked column, so a user who wanted the pass
 * list also got space weather, solar activity and launches above it. They answer
 * different questions and are wanted at different times, so each is independent — and
 * the whole rail can be put away, because "show me the Earth and nothing else" is a
 * legitimate thing to want rather than a power-user trick.
 *
 * The test that matters most is the last one: a control that removes every control is a
 * trap, so hiding must always leave a way back.
 */

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );
}

test("each panel opens and closes on its own", async ({ page }) => {
  await open(page);

  /*
   * Targeted through the rail's own state rather than the panel's contents.
   *
   * Visible Tonight renders different testids depending on whether a location is set —
   * with none it correctly shows "set an observing location" instead of a pass list —
   * so asserting on the list would be testing the observer feature, not the toggle.
   * `aria-pressed` is what this test is actually about, and it is also what a screen
   * reader reads.
   */
  const tonight = page.getByTestId("panel-toggle-tonight");
  const weather = page.getByTestId("panel-toggle-weather");

  // Visible tonight is the one panel open by default: it is the question the product
  // is most often opened to answer.
  await expect(tonight).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("visible-tonight-no-observer")).toBeVisible();
  await expect(page.getByTestId("space-weather")).toHaveCount(0);

  await weather.click();
  await expect(page.getByTestId("space-weather")).toBeVisible();
  // Opening one must not close another — someone deciding whether tonight's pass is
  // worth going outside for wants both at once.
  await expect(tonight).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("visible-tonight-no-observer")).toBeVisible();

  await tonight.click();
  await expect(page.getByTestId("visible-tonight-no-observer")).toHaveCount(0);
  await expect(page.getByTestId("space-weather")).toBeVisible();
});

test("a closed panel is not mounted, so it is not polling", async ({ page }) => {
  const solarRequests: string[] = [];
  await page.route("**/solar-events*", (route) => {
    solarRequests.push(route.request().url());
    return route.continue();
  });

  await open(page);
  await page.waitForTimeout(1500);

  // Each panel fetches on mount and refreshes on a timer. A closed panel that stayed
  // mounted would poll a provider for a user looking at the globe.
  expect(solarRequests).toHaveLength(0);

  await page.getByTestId("panel-toggle-solar").click();
  await expect(page.getByTestId("solar-events")).toBeVisible();
  await expect.poll(() => solarRequests.length, { timeout: 30_000 }).toBeGreaterThan(0);
});

test("the toggle buttons report their own state", async ({ page }) => {
  await open(page);

  const weather = page.getByTestId("panel-toggle-weather");
  // aria-pressed, not aria-expanded: the panel is a sibling, not a child, so "pressed"
  // is the accurate relationship for a screen reader.
  await expect(weather).toHaveAttribute("aria-pressed", "false");
  await weather.click();
  await expect(weather).toHaveAttribute("aria-pressed", "true");
});

test("the layout survives a reload", async ({ page }) => {
  await open(page);

  await page.getByTestId("panel-toggle-launches").click();
  await page.getByTestId("panel-toggle-tonight").click();
  await expect(page.getByTestId("launches")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );

  // A layout choice that resets on every reload is not a choice.
  await expect(page.getByTestId("launches")).toBeVisible();
  await expect(page.getByTestId("visible-tonight-no-observer")).toHaveCount(0);
});

test("hiding everything leaves exactly one way back", async ({ page }) => {
  await open(page);
  await page.getByTestId("panel-toggle-weather").click();
  await expect(page.getByTestId("space-weather")).toBeVisible();

  await page.getByTestId("panel-rail-hide").click();

  // Nothing left over the globe: not the rail, not the panels that were open.
  await expect(page.getByTestId("panel-rail")).toHaveCount(0);
  await expect(page.getByTestId("space-weather")).toHaveCount(0);
  await expect(page.getByTestId("visible-tonight-no-observer")).toHaveCount(0);

  // But a control that removes every control is a trap. The restore button is always
  // there, named, and keyboard reachable.
  const restore = page.getByTestId("panel-rail-restore");
  await expect(restore).toBeVisible();
  await restore.focus();
  await expect(restore).toBeFocused();

  await restore.click();
  await expect(page.getByTestId("panel-rail")).toBeVisible();
  // What was open before hiding comes back, rather than resetting to the default.
  await expect(page.getByTestId("space-weather")).toBeVisible();
});
