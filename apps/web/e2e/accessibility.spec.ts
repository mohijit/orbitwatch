import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { FIXTURE_OBJECT_COUNT, PINNED_CLOCK } from "./fixture";

/**
 * Accessibility, checked mechanically and by keyboard.
 *
 * TWO KINDS OF CHECK, BECAUSE ONE IS NOT ENOUGH
 * axe finds violations of machine-checkable rules — an unlabelled control, a contrast
 * failure, a broken landmark structure. It cannot tell whether the product is usable
 * without a mouse, which for a 3-D globe is the question that actually matters. So the
 * keyboard journeys below drive the app the way someone with no pointing device would,
 * and assert they arrive somewhere useful.
 *
 * WHY THE GLOBE IS role="application"
 * A WebGL canvas has no accessible structure to expose; there is nothing meaningful to
 * put in an accessibility tree. What it can do is accept keys. `role="application"`
 * tells a screen reader to stop intercepting keystrokes and pass them through, which
 * is what makes arrow-key camera control work at all. It is the correct role here and
 * the wrong one almost everywhere else, so the app uses it exactly once.
 */

test.use({ timezoneId: "Australia/Sydney" });

async function openApp(page: Page): Promise<void> {
  await page.clock.setFixedTime(PINNED_CLOCK);
  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );
}

/**
 * WCAG 2.1 A and AA. Colour contrast is included deliberately: a dark instrument panel
 * full of muted grey text is exactly where it tends to fail, and "it looks fine to me"
 * is not a measurement.
 */
function audit(page: Page) {
  return new AxeBuilder({ page }).withTags([
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
  ]);
}

test("the globe page has no automatically detectable violations", async ({ page }) => {
  await openApp(page);
  const results = await audit(page).analyze();

  // The violation list is the diagnosis; a bare length assertion throws it away.
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.html.slice(0, 120)),
    })),
  ).toEqual([]);
});

test("the search dialog has no violations while open", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: /search satellites/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  const results = await audit(page).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});

test("the telemetry panel has no violations while open", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: /search satellites/i }).click();
  await page.getByPlaceholder(/search by name/i).fill("ISS");
  await page.getByText("ISS (ZARYA)", { exact: true }).click();
  await expect(page.getByTestId("accuracy-badge")).toBeVisible({ timeout: 60_000 });

  const results = await audit(page).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});

for (const path of ["/methodology", "/agreement"]) {
  test(`${path} has no automatically detectable violations`, async ({ page }) => {
    await page.goto(path);
    const results = await audit(page).analyze();
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
}

test("a satellite can be found and selected with the keyboard alone", async ({ page }) => {
  await openApp(page);

  // No mouse from here on. This is the journey a keyboard user actually takes: the
  // globe's points are three pixels wide and cannot be a selection mechanism for
  // anybody, so search has to be reachable and sufficient.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: /skip to the globe/i })).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: /search satellites/i })).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  // The dialog moves focus to its own input rather than leaving it behind the overlay.
  await expect(page.getByPlaceholder(/search by name/i)).toBeFocused();

  await page.keyboard.type("ISS");

  /*
   * Wait for the FIRST option to be the ISS, not merely for it to appear somewhere.
   *
   * Enter selects the highlighted row, which is always index 0. Asserting only that
   * the ISS is visible passes against the unfiltered list — which contains it — and
   * then Enter picks whatever happens to be first, giving a confident pass on the
   * wrong satellite. The search is debounced, so this is a real race and not a
   * theoretical one: it selected TEMPSAT 1.
   */
  await expect(page.getByRole("option").first()).toContainText("ISS (ZARYA)", {
    timeout: 30_000,
  });
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("telemetry-panel")).toBeVisible();
  await expect(page.getByTestId("satellite-name")).toHaveText("ISS (ZARYA)", {
    timeout: 60_000,
  });
});

test("closing the search dialog returns focus to what opened it", async ({ page }) => {
  await openApp(page);

  const trigger = page.getByRole("button", { name: /search satellites/i });
  await trigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  // Focus dumped onto <body> is the standard way a dialog strands a keyboard user:
  // the next Tab restarts from the top of the page.
  await expect(trigger).toBeFocused();
});

test("the globe is focusable and reports what it is", async ({ page }) => {
  await openApp(page);

  const globe = page.getByRole("application", { name: /interactive 3-d globe/i });
  await globe.focus();
  await expect(globe).toBeFocused();

  // Arrow keys must not scroll the page instead of moving the camera; a globe that
  // scrolls the document when focused is worse than one that ignores the key.
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
});

test("selection is announced, not only drawn", async ({ page }) => {
  await openApp(page);

  // A sighted user sees a panel appear. Without a live region, a screen reader user
  // gets nothing at all: focus has not moved and the change is somewhere off-screen.
  const status = page.getByTestId("selection-status");

  await page.getByRole("button", { name: /search satellites/i }).click();
  await page.getByPlaceholder(/search by name/i).fill("ISS");
  await page.getByText("ISS (ZARYA)", { exact: true }).click();

  await expect(status).toContainText("ISS (ZARYA)", { timeout: 60_000 });
  await expect(status).toHaveAttribute("aria-live", "polite");
});
