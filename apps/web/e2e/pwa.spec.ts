import { expect, test, type Page } from "@playwright/test";

import { FIXTURE_OBJECT_COUNT } from "./fixture";

/**
 * Installability and offline behaviour.
 *
 * WHY THE SECOND LOAD MATTERS
 * Nothing is precached. A service worker installs on the first visit but the assets
 * that visit already fetched went straight to the network, so the cache is populated
 * by the NEXT load, once the worker is controlling the page. That is real behaviour
 * rather than a testing artefact — a first visit followed immediately by a flight
 * genuinely has nothing — so the tests reproduce it exactly rather than reaching for
 * an API that would warm the cache in a way no user ever does.
 *
 * THE TEST THAT MATTERS MOST IS THE LAST ONE
 * Anyone can cache everything and call the app offline-capable. The question this
 * suite actually answers is whether the things that must NOT be served from a cache
 * are absent when the network is.
 */

/** Load, let the worker take control, then load again so the cache is populated. */
async function warmCache(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 30_000,
  });

  await page.reload();
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );
  // The catalog is fetched by the propagation worker, so "the badge has a count" is
  // the signal that the response has been through the service worker and been stored.
  await expect(page.locator("canvas")).toBeVisible({ timeout: 60_000 });
}

test("the manifest describes an installable app", async ({ request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.status()).toBe(200);

  const manifest = (await response.json()) as {
    name: string;
    short_name: string;
    start_url: string;
    display: string;
    icons: { src: string; sizes: string; purpose: string }[];
  };

  expect(manifest.short_name).toBe("OrbitWatch");
  expect(manifest.start_url).toBe("/");
  expect(manifest.display).toBe("standalone");

  // 192 and 512 are what Chrome requires before it will offer to install at all.
  const sizes = manifest.icons.map((icon) => icon.sizes);
  expect(sizes).toContain("192x192");
  expect(sizes).toContain("512x512");

  /*
   * A maskable icon that is a relabelled copy of the standard one passes every
   * manifest checker and loses its edges to the launcher's crop on a real device, so
   * the two must be different files.
   */
  const maskable = manifest.icons.filter((icon) => icon.purpose.includes("maskable"));
  expect(maskable).toHaveLength(1);
  const plain = manifest.icons.filter((icon) => icon.purpose === "any").map((icon) => icon.src);
  expect(plain).not.toContain(maskable[0]?.src);
});

test("the icons are real images at the sizes the manifest claims", async ({ request }) => {
  // A 404 page or an empty file satisfies "the URL resolves" and installs as a blank
  // square, so the bytes are checked rather than the status.
  for (const [path, expected] of [
    ["/icons/icon-192.png", 192],
    ["/icons/icon-512.png", 512],
    ["/icons/icon-maskable-512.png", 512],
    ["/icons/apple-touch-icon.png", 180],
  ] as const) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);

    const body = await response.body();
    // PNG signature, then IHDR carries width and height as big-endian 32-bit ints.
    expect(body.subarray(1, 4).toString(), path).toBe("PNG");
    expect(body.readUInt32BE(16), `${path} width`).toBe(expected);
    expect(body.readUInt32BE(20), `${path} height`).toBe(expected);
  }
});

test("the app still opens with no network at all", async ({ page, context }) => {
  await warmCache(page);

  await context.setOffline(true);
  await page.reload();

  // The shell, the engine and the catalog all came from the cache: no network was
  // available to serve any of them.
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );
  await expect(page.locator("canvas")).toBeVisible({ timeout: 60_000 });
});

test("offline, it says where the positions came from", async ({ page, context }) => {
  await warmCache(page);

  await context.setOffline(true);
  await page.reload();

  const banner = page.getByTestId("offline-banner");
  await expect(banner).toBeVisible({ timeout: 30_000 });

  /*
   * Not asserted as "Offline".
   *
   * Chromium's CDP offline emulation cuts the network but leaves `navigator.onLine`
   * true, so the browser here genuinely believes it is online. That is not a testing
   * artefact to work around -- it is the captive-portal case, and the banner has to
   * appear on the strength of the service worker's own report that the elements came
   * from its cache. If this were keyed on navigator.onLine it would show nothing at
   * all, which is precisely the bug the two-signal design exists to prevent.
   */
  await expect(page.getByTestId("offline-headline")).toContainText(
    /(Offline|Using cached elements)/,
  );

  /*
   * The sentence the milestone turns on.
   *
   * The satellites keep moving while offline, because propagation is local. Motion on
   * a screen that says "offline" reads as a live feed that somehow survived unless
   * something says otherwise in as many words.
   */
  await expect(banner).toContainText("computed from these elements, not received");
  await expect(banner).toContainText("badge");
});

test("the banner goes when the network comes back", async ({ page, context }) => {
  await warmCache(page);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("offline-banner")).toBeVisible({ timeout: 30_000 });

  await context.setOffline(false);
  /*
   * A reload IS required here, and that is the honest behaviour rather than a
   * shortcut. The banner reports where the elements currently on screen came from, and
   * those came from the cache; they do not stop having come from the cache because a
   * network reappeared. It clears when a load actually reaches the network.
   */
  await page.reload();
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("offline-banner")).toHaveCount(0, { timeout: 30_000 });
});

test("offline, space weather is absent rather than reassuring", async ({ page, context }) => {
  /*
   * THE POINT OF THE WHOLE CACHING POLICY
   *
   * Kp 0 means a quiet magnetosphere. A cached Kp 0 served during a storm says the
   * same thing and is a lie, and nothing in the reading itself distinguishes the two —
   * unlike an element set, which carries an epoch and is degraded by age automatically.
   *
   * So the volatile providers are never cached, and this asserts the consequence:
   * offline, the panel reports that it does not know. If someone later adds these to
   * the service worker's cacheable list to make the app "work better offline", this
   * test is what stops it.
   */
  await warmCache(page);
  // Open it online first, so a cache entry would exist if one were ever written.
  await page.getByTestId("panel-toggle-weather").click();
  await expect(page.getByTestId("space-weather-kp")).toBeVisible({ timeout: 30_000 });

  await context.setOffline(true);
  await page.reload();

  // No second click: the panel rail persists what was open, so the panel comes back by
  // itself. Clicking again would close it and assert against an empty stack.
  await expect(page.getByTestId("space-weather-unavailable")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("space-weather-unavailable")).toContainText(
    "not a quiet magnetosphere",
  );
  await expect(page.getByTestId("space-weather-kp")).toHaveCount(0);
});
