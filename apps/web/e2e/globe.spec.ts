import { expect, test } from "@playwright/test";

/**
 * Milestone 0 renderer proof of concept.
 *
 * Proves that CesiumJS genuinely initialises and renders inside Next.js 16 with
 * Turbopack — a successful build proves only that the code compiles, not that the
 * runtime asset path, the CESIUM_BASE_URL assignment or the WebGL context work.
 */

test("serves the branded shell before the globe engine loads", async ({ page }) => {
  await page.goto("/");
  // The dark shell and brand must be present immediately: no white flash, no
  // waiting on a 7.7 MB engine before anything appears.
  await expect(page.getByText("OrbitWatch")).toBeVisible();
  await expect(page.getByText(/not continuous onboard GPS telemetry/i)).toBeVisible();
});

test("initialises Cesium and renders a globe", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const failedRequests: string[] = [];
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ""}`);
  });

  await page.goto("/");

  // The loading overlay disappears only after the Viewer is constructed.
  await expect(page.getByText("Loading catalog…")).toBeHidden({
    timeout: 90_000,
  });
  await expect(page.getByText("Failed to load catalog")).toBeHidden();

  // Cesium creates its own canvas inside the container.
  const canvas = page.locator(".globe-canvas canvas");
  await expect(canvas).toBeVisible();

  const size = await canvas.boundingBox();
  expect(size?.width ?? 0).toBeGreaterThan(200);
  expect(size?.height ?? 0).toBeGreaterThan(200);

  // A live WebGL context is the thing that actually matters.
  const rendering = await page.evaluate(() => {
    const element = document.querySelector(".globe-canvas canvas");
    if (!(element instanceof HTMLCanvasElement)) return { ok: false, reason: "no canvas" };
    const gl =
      element.getContext("webgl2") ?? element.getContext("webgl");
    if (gl === null) return { ok: false, reason: "no webgl context" };
    return { ok: true, reason: (gl as WebGLRenderingContext).getParameter(0x1f01) as string };
  });
  expect(rendering.ok, `WebGL unavailable: ${rendering.reason}`).toBe(true);

  // Cesium's attribution is a licence requirement and must never be removed.
  await expect(page.locator(".cesium-widget-credits")).toBeAttached();

  expect(failedRequests, `failed requests:\n${failedRequests.join("\n")}`).toEqual([]);
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("serves Cesium runtime assets from the copied directory", async ({ request }) => {
  // If CESIUM_BASE_URL or the copy script is wrong, these 404 and the globe silently
  // fails to load workers or textures.
  for (const path of [
    "/cesium/Widgets/widgets.css",
    "/cesium/Cesium.js",
    "/cesium/Assets/approximateTerrainHeights.json",
  ]) {
    const response = await request.get(path);
    expect(response.status(), `${path} should be served`).toBe(200);
  }
});

test("says the catalog is unavailable rather than loading forever", async ({ page }) => {
  // A failed catalog used to render "LOADING…" indefinitely, which is the app claiming
  // it is still trying after it has given up. The distinction matters to a user
  // deciding whether to wait, and it is the difference between a slow network and a
  // dead one.
  await page.route("**/catalog/elements*", (route) => route.abort("failed"));
  await page.goto("/");

  await expect(page.getByTestId("catalog-count")).toHaveText("CATALOG UNAVAILABLE", {
    timeout: 30_000,
  });
});
