import { expect, test, type Page } from "@playwright/test";

import { FIXTURE_OBJECT_COUNT } from "./fixture";

/**
 * Setting a location must not put the app into a per-second rebuild loop.
 *
 * THE BUG THIS EXISTS TO CATCH
 * `useObserver` built its `location` object during render, so the observer had a new
 * identity on every render. The page re-renders once a second in LIVE mode, so every
 * memo and effect keyed on the observer re-ran once a second even though the
 * coordinates had not changed. The expensive one was a 24-hour pass search, measured
 * at 28 ms, running at 1 Hz on the main thread instead of once every five minutes.
 * All of it began the moment a location was set, which is why the app felt slower
 * from precisely that point.
 *
 * WHY NOT MEASURE LONG TASKS
 * That was the first attempt and it was useless: `longtask` entries begin at 50 ms, and
 * a 28 ms block every second never crosses the threshold. The test passed with the bug
 * deliberately reinstated, which makes it worse than no test — it is assurance that
 * nothing is wrong, sourced from an instrument that cannot see the problem.
 *
 * WHAT IS MEASURED INSTEAD
 * The globe removes and re-adds its observer marker whenever the observer's identity
 * changes. That is a direct, countable consequence of the same identity, on the same
 * render path, and it is exactly one add for a location that is set once. Counting
 * entity churn detects the bug at its cause rather than hoping the symptom is large
 * enough to register.
 *
 * No pinned clock: the whole point is behaviour across real ticking seconds.
 */

const OBSERVER = { latitude: "-33.8688", longitude: "151.2093" };
/** Long enough to span several LIVE ticks; the bug rebuilt the marker on each one. */
const WINDOW_MS = 6000;

declare global {
  interface Window {
    __observerEntityAdds?: number;
  }
}

async function open(page: Page): Promise<void> {
  // Count every observer-marker insertion from before the page scripts run. Cesium's
  // namespace is polled rather than trapped with a property setter: its bundle is an
  // esbuild IIFE whose exports are getter-only, so defineProperty never fires and
  // breaks the page instead.
  await page.addInitScript(() => {
    window.__observerEntityAdds = 0;
    const timer = setInterval(() => {
      const cesium = (window as unknown as { Cesium?: { EntityCollection?: { prototype: Record<string, unknown> } } })
        .Cesium;
      const prototype = cesium?.EntityCollection?.prototype;
      if (prototype === undefined || (prototype as { __patched?: boolean }).__patched === true) return;

      (prototype as { __patched?: boolean }).__patched = true;
      const original = prototype["add"] as (this: unknown, entity: unknown) => unknown;
      prototype["add"] = function patched(this: unknown, entity: unknown) {
        const id = (entity as { id?: unknown } | undefined)?.id;
        if (id === "observer-location") {
          window.__observerEntityAdds = (window.__observerEntityAdds ?? 0) + 1;
        }
        return original.call(this, entity);
      };
      clearInterval(timer);
    }, 10);
  });

  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );
  await expect(page.locator("canvas")).toBeVisible({ timeout: 60_000 });
}

test("a location set once is applied once, not rebuilt every tick", async ({ page }) => {
  await open(page);

  await page.getByTestId("observer-summary").click();
  await page.getByLabel("Latitude in degrees").fill(OBSERVER.latitude);
  await page.getByLabel("Longitude in degrees").fill(OBSERVER.longitude);
  await page.getByTestId("observer-set-manual").click();
  await page.getByTestId("observer-summary").click();

  await expect
    .poll(async () => page.evaluate(() => window.__observerEntityAdds ?? 0), { timeout: 30_000 })
    .toBeGreaterThan(0);

  const afterSet = await page.evaluate(() => window.__observerEntityAdds ?? 0);
  await page.waitForTimeout(WINDOW_MS);
  const afterWaiting = await page.evaluate(() => window.__observerEntityAdds ?? 0);

  console.log(
    JSON.stringify({ afterSet, afterWaiting, addedWhileIdle: afterWaiting - afterSet, WINDOW_MS }),
  );

  // Six seconds of LIVE ticking with an unchanged location must add nothing. With the
  // identity bug this was one rebuild per second — and one 24-hour pass search with it.
  expect(afterWaiting - afterSet).toBe(0);
});
