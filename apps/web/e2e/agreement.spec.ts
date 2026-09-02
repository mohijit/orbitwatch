import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

/**
 * The browser half of the M6 cross-platform gate.
 *
 * The unit test in `@orbitwatch/orbit-core` proves agreement under Node — the same
 * engine that generated the expectation, and therefore the weakest of the three
 * checks. This runs the identical suite through the app's own bundler, in a real
 * browser, against the production build. Different engine build, different optimisation
 * tiers, and the actual shipped JavaScript rather than TypeScript sources.
 *
 * The third half runs on Hermes from a screen in the native app, which is the engine
 * most likely to differ: it delegates several Math functions to the platform's C
 * library. That one needs a device and is not automatable here.
 *
 * No clock pinning. Agreement is a property of the arithmetic, not of the moment —
 * every instant in the suite is an absolute timestamp in the fixture. A test that
 * needed the clock frozen would be testing something else.
 */

const repoRoot = resolve(process.cwd(), "..", "..");

const fixture = JSON.parse(
  readFileSync(resolve(repoRoot, "fixtures", "cross-platform-agreement.json"), "utf8"),
) as { cases: unknown[]; expected: { samples: unknown[]; passes: unknown[] }[] };

test("this browser agrees with every other platform", async ({ page }) => {
  await page.goto("/agreement");

  const verdict = page.getByTestId("agreement-verdict");
  // Sixteen cases of SGP4 plus sixteen 24-hour pass searches. Roughly a second on real
  // hardware, longer under a loaded suite, and it blocks the render until it finishes.
  await expect(verdict).toBeVisible({ timeout: 60_000 });

  // The exact wording matters: "Agreement confirmed" is only rendered when the report
  // has zero deviations. A partial pass would say "Disagreement in N of M".
  await expect(verdict).toContainText("Agreement confirmed");
  await expect(verdict).toContainText("16 cases");

  // Derived from the fixture rather than written out, so a regenerated corpus cannot
  // leave a stale number that quietly stops testing the full suite.
  const quantities =
    fixture.expected.reduce(
      (total, result) => total + result.samples.length * 6 + result.passes.length * 4,
      0,
    );
  await expect(verdict).toContainText(`${String(quantities)} quantities`);

  // Deviation is reported as a percentage of the allowed tolerance. On an engine that
  // agrees, it is a small fraction of one percent — the assertion is that the
  // tolerances are not silently absorbing a real difference.
  const headroom = await page.getByTestId("agreement-headroom").textContent();
  const percent = Number(/([\d.eE+-]+)%/.exec(headroom ?? "")?.[1]);
  expect(Number.isFinite(percent)).toBe(true);
  expect(percent).toBeLessThan(1);
});

test("the page explains what agreement means rather than asserting it", async ({ page }) => {
  await page.goto("/agreement");
  await expect(page.getByTestId("agreement-verdict")).toBeVisible({ timeout: 60_000 });

  const main = page.getByRole("main");
  // A green tick with no method behind it is a badge, not evidence.
  await expect(main).toContainText("SDP4");
  await expect(main).toContainText("Hermes");
  await expect(main).toContainText("millionth of a degree");
});
