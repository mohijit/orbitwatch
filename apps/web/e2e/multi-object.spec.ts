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
 * The corpus is real CelesTrak GP records, ingested by the real ingestion pipeline
 * (see apps/api/src/seed-dev.ts); its size is read from the fixture, never restated.
 * Nothing in this file reaches a provider.
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
  /** Earth-fixed position in km per object, rounded, as "x,y,z". */
  readonly places: readonly string[];
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
          const places: string[] = [];
          let ok = 0;

          for (let index = 0; index < slots; index += 1) {
            const offset = index * POSITION_FIELDS;
            if (positions[offset + 6] === 1) ok += 1;
            const x = positions[offset] as number;
            const y = positions[offset + 1] as number;
            const z = positions[offset + 2] as number;
            radii.push(Math.hypot(x, y, z));
            places.push(`${x.toFixed(0)},${y.toFixed(0)},${z.toFixed(0)}`);
          }
          state.ticks.push({ slots, ok, radii, places });
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

  // Distinct POSITIONS, not one object repeated. Rounding to a kilometre is far finer
  // than the separation between any two real objects here and far coarser than float32
  // noise, so equality at this precision means genuinely the same place.
  //
  // Compared in three dimensions, not by geocentric radius. Radius is a one-dimensional
  // projection and objects genuinely share it: MMS 1, 2 and 3 fly in formation on the
  // same orbit, so they sit at the same distance from Earth's centre while being in
  // quite different places. Asserting on radius counted that as a duplicate.
  const distinct = new Set(tick?.places ?? []);
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

  // Expected matches are derived from the corpus rather than named, so a re-export
  // cannot leave this asserting objects that are no longer there. The term still has
  // to do real work: several objects match and the rest of the corpus must not.
  const navstars = FIXTURE_RECORDS.map((record) => record.OBJECT_NAME).filter((name) =>
    name.includes("NAVSTAR"),
  );
  expect(navstars.length).toBeGreaterThan(1);
  expect(navstars.length).toBeLessThan(FIXTURE_OBJECT_COUNT);

  await input.fill("NAVSTAR");
  await expect(page.getByText(navstars[0] as string, { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  for (const name of navstars.slice(1)) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("ISS (ZARYA)", { exact: true })).toBeHidden();

  await input.fill("ISS");
  await expect(page.getByText("ISS (ZARYA)", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(navstars[0] as string, { exact: true })).toBeHidden();
});
