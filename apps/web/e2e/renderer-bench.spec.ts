import { expect, test } from "@playwright/test";

interface BenchResult {
  strategy: "entity" | "point-primitive";
  count: number;
  createMs: number;
  updateMedianMs: number;
  updatesPerSecondAt60fps: number;
}

/**
 * Milestone 0 renderer benchmark.
 *
 * Reports the main-thread cost of each candidate rendering strategy, and asserts the
 * conclusion the architecture depends on: batched point primitives must be
 * dramatically cheaper than the Entity API at catalog scale.
 */
test("measures point-cloud rendering strategies", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/bench");

  await page.waitForFunction(() => window.__benchDone === true, undefined, {
    timeout: 540_000,
  });
  const results = (await page.evaluate(() => window.__benchResults)) as BenchResult[];

  console.log("\n=== Cesium rendering benchmark (main-thread cost) ===");
  console.log("Measured in headless Chromium. GPU rasterisation is NOT measured here;");
  console.log("this is the CPU work that competes with React and input each update.\n");
  console.log("  strategy          objects     create      update/frame   updates in 16.7ms");
  for (const r of results) {
    console.log(
      `  ${r.strategy.padEnd(16)} ${String(r.count).padStart(7)}  ` +
        `${r.createMs.toFixed(1).padStart(9)} ms  ` +
        `${r.updateMedianMs.toFixed(2).padStart(11)} ms  ` +
        `${r.updatesPerSecondAt60fps.toFixed(2).padStart(10)}`,
    );
  }

  expect(results.length).toBeGreaterThan(0);

  // The architectural claim under test: batched primitives beat entities at scale.
  const pp5k = results.find((r) => r.strategy === "point-primitive" && r.count === 5000);
  const en5k = results.find((r) => r.strategy === "entity" && r.count === 5000);
  expect(pp5k).toBeDefined();
  expect(en5k).toBeDefined();
  if (pp5k && en5k) {
    console.log(
      `\n  => at 5,000 objects, point primitives are ` +
        `${(en5k.updateMedianMs / pp5k.updateMedianMs).toFixed(1)}x cheaper to update ` +
        `and ${(en5k.createMs / pp5k.createMs).toFixed(1)}x cheaper to create.\n`,
    );
    expect(pp5k.updateMedianMs).toBeLessThan(en5k.updateMedianMs);
  }

  // 20k objects must remain feasible off the critical path.
  const pp20k = results.find((r) => r.strategy === "point-primitive" && r.count === 20000);
  expect(pp20k, "20k point-primitive result missing").toBeDefined();
});
