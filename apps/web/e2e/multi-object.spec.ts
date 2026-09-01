import { expect, test, type Page } from "@playwright/test";

import {
  EXPECTED_OBJECTS,
  FIXTURE_OBJECT_COUNT,
  FIXTURE_RECORDS,
  PINNED_CLOCK,
  expectedEpochAge,
} from "./fixture";

/**
 * Multi-object verification: the catalog path at corpus scale, not for one object.
 *
 * The M3 gate proved the pipeline worked for the ISS. That could not distinguish "the
 * catalog pipeline works" from "the catalog pipeline works for exactly one item" —
 * a seed of one satisfies a renderer that draws only the first element, a worker that
 * propagates only index 0, and an API that ignores its own count. Everything here is
 * written to fail if the app regresses to handling a single object.
 *
 * The corpus is 32 real CelesTrak GP records, ingested by the real ingestion pipeline
 * (see apps/api/src/seed-dev.ts). Nothing in this file reaches a provider.
 *
 * HOW IT OBSERVES
 * Two pieces of instrumentation are installed before navigation, both of which wrap
 * interfaces the app already uses rather than adding hooks to the app itself:
 *
 *   * `window.Worker` — records every position buffer the propagation worker returns,
 *     which is the propagator's actual output, not a re-implementation of it.
 *   * `PointPrimitiveCollection.prototype.add` — keeps the primitives the globe
 *     creates, so their positions can be read back out of the live scene. That is
 *     what makes "rendered" an observation rather than an inference from the data
 *     having arrived. It caught a real bug on its first run: the globe drew nothing
 *     at all whenever the catalog became ready before Cesium finished loading.
 *
 * Neither exists in the shipped bundle, so what is measured is the shipped code.
 */

const CATALOG_IDS = FIXTURE_RECORDS.map((record) => String(record.NORAD_CAT_ID)).sort();

/** Earth's equatorial radius, for turning an Earth-fixed vector into an altitude. */
const EARTH_RADIUS_KM = 6378.137;

interface RenderedPoint {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface TickSummary {
  readonly slots: number;
  readonly ok: number;
  /** Geocentric radius in km per object, in catalog order. */
  readonly radii: readonly number[];
}

interface PointPrimitive {
  readonly id: string;
  readonly position: { x: number; y: number; z: number };
}

declare global {
  interface Window {
    __e2e: {
      ticks: TickSummary[];
      primitives: PointPrimitive[];
      renderedPoints: () => RenderedPoint[];
    };
  }
}

async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const POSITION_FIELDS = 7;

    const state: Window["__e2e"] = {
      ticks: [],
      primitives: [],
      // Metres in Cesium's fixed frame; kilometres everywhere else in this suite.
      renderedPoints: () =>
        state.primitives.map((primitive) => ({
          id: primitive.id,
          x: primitive.position.x / 1000,
          y: primitive.position.y / 1000,
          z: primitive.position.z / 1000,
        })),
    };
    window.__e2e = state;

    // --- the propagation worker's real output -----------------------------------
    const BaseWorker = window.Worker;
    class InstrumentedWorker extends BaseWorker {
      constructor(scriptUrl: string | URL, options?: WorkerOptions) {
        super(scriptUrl, options);
        this.addEventListener("message", (event: MessageEvent) => {
          const message = event.data as { type?: string; buffer?: ArrayBuffer } | null;
          if (message?.type !== "positions" || message.buffer === undefined) return;

          const positions = new Float32Array(message.buffer);
          const slots = Math.floor(positions.length / POSITION_FIELDS);
          const radii: number[] = [];
          let ok = 0;

          for (let index = 0; index < slots; index += 1) {
            const offset = index * POSITION_FIELDS;
            if (positions[offset + 6] === 1) ok += 1;
            radii.push(
              Math.hypot(
                positions[offset] as number,
                positions[offset + 1] as number,
                positions[offset + 2] as number,
              ),
            );
          }
          state.ticks.push({ slots, ok, radii });
        });
      }
    }
    window.Worker = InstrumentedWorker as unknown as typeof Worker;

    // --- the live Cesium scene ---------------------------------------------------
    // Wrap `PointPrimitiveCollection.prototype.add`/`removeAll` and keep the
    // PointPrimitive objects it hands back. Those are the live objects Cesium draws,
    // so reading `.position` off them later reports where the globe is actually
    // putting each satellite — not where the data said it should go.
    //
    // Found by polling rather than by intercepting the assignment to window.Cesium:
    // the bundle is an esbuild IIFE whose namespace properties are getter-only, and an
    // accessor installed on window never fired for it. Polling assumes nothing about
    // how the global appears. Cesium is a 6 MB download that then has to build a viewer
    // before the app adds a single point, so a 10 ms poll wins by a wide margin.
    const poll = setInterval(() => {
      // Cast through unknown: the app declares window.Cesium as the full Cesium
      // namespace, and all this needs is one prototype off it.
      const cesium = (
        window as unknown as {
          Cesium?: { PointPrimitiveCollection?: { prototype: Record<string, unknown> } };
        }
      ).Cesium;
      const prototype = cesium?.PointPrimitiveCollection?.prototype;
      if (prototype === undefined) return;
      clearInterval(poll);

      const originalAdd = prototype["add"] as (...args: unknown[]) => PointPrimitive;
      prototype["add"] = function (this: unknown, ...args: unknown[]): PointPrimitive {
        const primitive = originalAdd.apply(this, args);
        state.primitives.push(primitive);
        return primitive;
      };

      // The globe clears and rebuilds the collection when the catalog size changes.
      // Without mirroring that, a rebuild would leave destroyed primitives in here and
      // the counts would double.
      const originalRemoveAll = prototype["removeAll"] as (...args: unknown[]) => unknown;
      prototype["removeAll"] = function (this: unknown, ...args: unknown[]): unknown {
        state.primitives.length = 0;
        return originalRemoveAll.apply(this, args);
      };
    }, 10);
  });
}

/** Pin the clock, install instrumentation, load the app, wait for the catalog. */
async function openCatalog(page: Page): Promise<void> {
  await page.clock.setFixedTime(PINNED_CLOCK);
  await instrument(page);
  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );
}

test("the whole corpus is ingested, served and counted — not just the first object", async ({
  page,
}) => {
  await openCatalog(page);

  // The badge reads the worker's parse count, which is downstream of ingestion, the
  // API response and the shared schema. A seed of one, a truncated response or a
  // worker that stopped after the first record all fail here.
  expect(FIXTURE_OBJECT_COUNT).toBeGreaterThan(1);

  const served = await page.evaluate(async () => {
    const response = await fetch("http://127.0.0.1:3333/catalog/elements");
    return (await response.json()) as {
      count: number;
      elements: { catalogId: string }[];
    };
  });

  expect(served.count).toBe(FIXTURE_OBJECT_COUNT);
  expect(served.elements.map((element) => element.catalogId).sort()).toEqual(CATALOG_IDS);
});

test("every object is propagated to its own distinct position", async ({ page }) => {
  await openCatalog(page);

  await expect
    .poll(async () => (await page.evaluate(() => window.__e2e.ticks.length)) as number, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);

  const tick = await page.evaluate(() => window.__e2e.ticks.at(-1));
  expect(tick).toBeDefined();

  // One slot per object: the buffer is index-aligned with catalogIds, so a short
  // buffer means objects silently vanished between parsing and propagation.
  expect(tick?.slots).toBe(FIXTURE_OBJECT_COUNT);
  expect(tick?.ok).toBe(FIXTURE_OBJECT_COUNT);

  const radii = tick?.radii ?? [];

  // Distinct positions, not one object repeated. Rounding to a kilometre is far finer
  // than the separation between any two real objects here and far coarser than float32
  // noise, so equality at this precision means genuinely the same place.
  const distinct = new Set(radii.map((radius) => radius.toFixed(0)));
  expect(distinct.size).toBe(FIXTURE_OBJECT_COUNT);

  // The corpus spans LEO through the geosynchronous belt by construction, so the
  // propagated radii must too. A renderer or propagator that collapsed everything onto
  // one orbit would pass a distinctness check but fail this.
  const altitudes = radii.map((radius) => radius - EARTH_RADIUS_KM);
  expect(Math.min(...altitudes)).toBeLessThan(2_000);
  expect(Math.max(...altitudes)).toBeGreaterThan(30_000);
});

test("the globe renders one primitive per object, all at distinct positions", async ({
  page,
}) => {
  await openCatalog(page);

  // Positions are written on an animation frame after the first tick, so poll for the
  // scene to be populated rather than assuming a paint has happened.
  await expect
    .poll(async () => (await page.evaluate(() => window.__e2e.renderedPoints().length)) as number, {
      timeout: 30_000,
    })
    .toBe(FIXTURE_OBJECT_COUNT);

  const points = (await page.evaluate(() => window.__e2e.renderedPoints())) as RenderedPoint[];

  // Read back from the live scene graph: these are the primitives Cesium is drawing.
  expect(points.map((point) => point.id).sort()).toEqual(CATALOG_IDS);

  const places = new Set(
    points.map((point) => `${point.x.toFixed(0)},${point.y.toFixed(0)},${point.z.toFixed(0)}`),
  );
  expect(places.size).toBe(FIXTURE_OBJECT_COUNT);

  // Nothing is parked at the unrenderable sentinel below the ellipsoid, and nothing is
  // still sitting at the origin it was created at before the first tick arrived.
  for (const point of points) {
    const radius = Math.hypot(point.x, point.y, point.z);
    expect(radius, `${point.id} is not above the surface`).toBeGreaterThan(EARTH_RADIUS_KM);
  }
});

/**
 * One test per object, rather than one test walking six of them.
 *
 * Not cosmetic. Six selections in a single page each rebuild the ground-track and
 * footprint geometry, and under software rasterisation that accumulates until the page
 * stops settling between animation frames — Playwright then waits forever for an
 * element to be stable, and the run hangs rather than reporting anything useful. A
 * page per object keeps every case independent, and a failure names the object.
 */
for (const expected of EXPECTED_OBJECTS) {
  test(`${expected.name} reports its own elements, epoch and orbit class`, async ({ page }) => {
    await openCatalog(page);

    await page.getByRole("button", { name: /search satellites/i }).click();
    await page.getByPlaceholder(/search by name/i).fill(expected.name);
    await page.getByText(expected.name, { exact: true }).click();

    const panel = page.getByTestId("telemetry-panel");
    await expect(panel).toContainText(`#${expected.catalogId}`);

    // The orbit class is derived per object from its own elements. If the app fell
    // back to a single class — or to the UNKNOWN default that is byte-identical to
    // LEO — this is where a GEO, GSO or HEO object gives it away.
    await expect(page.getByTestId("orbit-class")).toHaveText(expected.orbitClass, {
      timeout: 30_000,
    });

    // The age is this object's OWN element epoch measured against the pinned clock,
    // computed in fixture.ts from the fixture rather than read back from the app. Every
    // object in the corpus has a different epoch, so serving one object's elements for
    // all of them — the failure a single-object suite cannot see — fails here.
    await expect(page.getByTestId("element-epoch")).toContainText(
      expectedEpochAge(expected.catalogId),
    );

    await page.getByRole("button", { name: /close/i }).click();
    await expect(panel).toBeHidden();
  });
}

test("search filters the corpus instead of returning everything", async ({ page }) => {
  await openCatalog(page);

  await page.getByRole("button", { name: /search satellites/i }).click();
  const input = page.getByPlaceholder(/search by name/i);

  // Three real NAVSTAR objects are in the corpus and 29 other objects are not, so a
  // search that ignored its term, or one that only ever considered a single object,
  // both fail this.
  await input.fill("NAVSTAR");
  await expect(page.getByText("NAVSTAR 43 (USA 132)", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("NAVSTAR 48 (USA 151)", { exact: true })).toBeVisible();
  await expect(page.getByText("NAVSTAR 49 (USA 154)", { exact: true })).toBeVisible();
  await expect(page.getByText("ISS (ZARYA)", { exact: true })).toBeHidden();

  await input.fill("ISS");
  await expect(page.getByText("ISS (ZARYA)", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("NAVSTAR 43 (USA 132)", { exact: true })).toBeHidden();
});
