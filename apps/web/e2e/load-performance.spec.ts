import { expect, test } from "@playwright/test";

import { FIXTURE_OBJECT_COUNT } from "./fixture";

/**
 * Where the load time actually goes.
 *
 * MEASURED CONCLUSIONS, KEPT SO THEY ARE NOT RE-LITIGATED FROM INTUITION
 *   - Client CPU is not the problem. Parsing the full 16,655-object catalog and
 *     building every satrec is about 20 ms and 120 ms respectively. Optimising it
 *     would be optimising a rounding error.
 *   - Transfer is. Removing the per-record envelope from the catalog response took it
 *     from 664 to 423 bytes per object: 11.06 MB to 7.05 MB uncompressed, 1.45 MB to
 *     1.04 MB over the wire, and the server's own response time from ~1.0 s to ~0.53 s.
 *   - Preloading the Cesium bundle from the document head was tried and REJECTED. It
 *     halved time-to-script (898 ms to 470 ms) and made the page worse: the 2.8 MB
 *     download competed with application boot, pushing the catalog from 670 ms to
 *     2200 ms and time-to-globe from 1800 ms to 2200-2600 ms. Getting the renderer
 *     earlier is worth nothing if it delays the data the renderer needs.
 *
 * Not a pass/fail budget — under software rasterisation the absolute numbers here are
 * several times worse than real hardware and a threshold would be measuring the CI
 * machine. What it measures is the SHAPE of the load: which phase dominates, so that
 * optimisation effort goes where the time is rather than where it is easiest to spend.
 *
 * The catalog is 39 objects here. That is deliberate for this test: Cesium's
 * initialisation cost does not vary with object count, so the fixture isolates it. The
 * catalog's own cost is measured separately at full 16,655-object scale, where it
 * belongs.
 */

test("reports where load time is spent", async ({ page }) => {
  // No pinned clock here, deliberately. `page.clock` replaces the page's time source,
  // which is the same source `performance.now()` and the navigation timings come from —
  // pinning it makes every measurement below meaningless.

  const marks: { name: string; at: number }[] = [];
  await page.exposeFunction("__mark", (name: string, at: number) => {
    marks.push({ name, at });
  });

  // Timed from the page's own timeline, not the test's: Playwright's clock includes
  // navigation and browser startup, which the user does not experience as load.
  await page.addInitScript(() => {
    const report = (name: string) => {
      (window as unknown as { __mark: (n: string, a: number) => void }).__mark(
        name,
        performance.now(),
      );
    };
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name.includes("Cesium.js")) report("cesium-script-loaded");
        if (entry.name.includes("/catalog/elements")) report("catalog-response");
      }
    });
    observer.observe({ entryTypes: ["resource"] });

    document.addEventListener("DOMContentLoaded", () => {
      report("dom-ready");
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 60_000 },
  );
  const catalogReadyAt = await page.evaluate(() => performance.now());

  // The globe is usable when a canvas exists and has painted at least once.
  await expect(page.locator("canvas")).toBeVisible({ timeout: 60_000 });
  const globeReadyAt = await page.evaluate(() => performance.now());

  const timings = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    const cesium = performance
      .getEntriesByType("resource")
      .filter((entry) => entry.name.includes("cesium"))
      .reduce(
        (total, entry) => ({
          count: total.count + 1,
          bytes: total.bytes + (entry as PerformanceResourceTiming).encodedBodySize,
          ms: total.ms + entry.duration,
        }),
        { count: 0, bytes: 0, ms: 0 },
      );
    return {
      domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? -1),
      loadEvent: Math.round(nav?.loadEventEnd ?? -1),
      cesiumRequests: cesium.count,
      cesiumBytes: cesium.bytes,
      cesiumTotalMs: Math.round(cesium.ms),
    };
  });

  console.log(
    JSON.stringify(
      {
        ...timings,
        catalogReadyMs: Math.round(catalogReadyAt),
        globeReadyMs: Math.round(globeReadyAt),
        marks: marks.map((mark) => ({ ...mark, at: Math.round(mark.at) })),
      },
      null,
      2,
    ),
  );

  // The only assertion: the app becomes usable at all. Everything above is reported.
  expect(globeReadyAt).toBeGreaterThan(0);
});
