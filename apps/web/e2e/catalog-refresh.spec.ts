import { expect, test } from "@playwright/test";

import { FIXTURE_OBJECT_COUNT, PINNED_CLOCK } from "./fixture";

/**
 * A page left open re-fetches the catalog instead of propagating its first download
 * forever.
 *
 * Elements are ingested every three hours. Before this, the catalog was fetched once
 * on mount, so a tab or installed PWA kept on the globe for a day was drawing
 * positions from day-old elements while the API served fresh ones.
 *
 * `clock.install` rather than `setFixedTime`: the refresh compares Date.now() against
 * the last fetch, and a frozen clock would never let an hour pass.
 */

const MINUTE = 60_000;

const catalogRequests = (url: string) => /\/catalog\/elements(\?|$)/.test(new URL(url).pathname);

test("an open page re-fetches the catalog after an hour, and keeps it if that fails", async ({
  context,
  page,
}) => {
  let fetches = 0;
  context.on("request", (request) => {
    // The page's own request only: the service worker's onward fetch is the same load.
    if (catalogRequests(request.url()) && request.serviceWorker() === null) fetches += 1;
  });

  await page.clock.install({ time: PINNED_CLOCK });
  await page.goto("/");
  const count = page.getByTestId("catalog-count");
  await expect(count).toHaveText(`${FIXTURE_OBJECT_COUNT} OBJECTS`, { timeout: 30_000 });
  const afterLoad = fetches;
  expect(afterLoad).toBe(1);

  // Under an hour: nothing.
  await page.clock.fastForward(30 * MINUTE);
  await page.waitForTimeout(500);
  expect(fetches).toBe(afterLoad);

  // Past the hour: one refetch.
  await page.clock.fastForward(31 * MINUTE);
  await expect.poll(() => fetches, { timeout: 15_000 }).toBe(afterLoad + 1);
  await expect(count).toHaveText(`${FIXTURE_OBJECT_COUNT} OBJECTS`);

  // A failed refresh leaves the loaded catalog on screen rather than "unavailable".
  await context.route("**/catalog/elements*", (route) => route.abort("failed"));
  await page.clock.fastForward(61 * MINUTE);
  await expect.poll(() => fetches, { timeout: 15_000 }).toBe(afterLoad + 2);
  await page.waitForTimeout(1_000);
  await expect(count).toHaveText(`${FIXTURE_OBJECT_COUNT} OBJECTS`);
});
