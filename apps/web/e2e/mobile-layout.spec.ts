import { expect, test, type Page } from "@playwright/test";

import { FIXTURE_OBJECT_COUNT, PINNED_CLOCK } from "./fixture";

/**
 * The web app on a phone-shaped viewport with touch input.
 *
 * WHY THIS FILE EXISTS AT ALL
 * `globals.css` had exactly one media query — `prefers-reduced-motion` — and every
 * overlay was positioned at a fixed `rem` width chosen for a 1280px window. Measured on
 * a 390px viewport, the panel stack sat at `left: 11rem` with `width: 20rem`, so its
 * right edge landed at 496px: a hundred pixels off screen, on the panel that is open by
 * default. Nothing in the suite could see that, because nothing in the suite had ever
 * been narrower than a laptop.
 *
 * Every assertion here is written to fail against the layout as it was. A test that
 * passes both before and after a responsive pass is measuring nothing.
 *
 * WHAT THIS CANNOT TELL US
 * A Playwright device descriptor is a viewport, a user agent and `hasTouch`. It is not
 * a phone. This is still desktop Chromium rasterising WebGL on SwiftShader at a handful
 * of frames per second, so it verifies geometry and interaction and says nothing about
 * frame rate, memory or thermals. Those are measured on real hardware — see
 * `docs/adr/0006-mobile-web-performance.md`.
 */

/** WCAG 2.5.5 and both platform guidelines converge on this figure. */
const MIN_TOUCH_TARGET_PX = 44;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function openApp(page: Page): Promise<void> {
  await page.clock.setFixedTime(PINNED_CLOCK);
  await page.goto("/");
  await expect(page.getByTestId("catalog-count")).toHaveText(
    `${FIXTURE_OBJECT_COUNT} OBJECTS`,
    { timeout: 30_000 },
  );
}

/** Fully inside the viewport, with a pixel of tolerance for sub-pixel layout. */
async function expectWithinViewport(page: Page, box: Box | null, what: string): Promise<void> {
  expect(box, `${what} is not rendered`).not.toBeNull();
  if (box === null) return;
  const size = page.viewportSize();
  expect(size, "the mobile project must set a viewport").not.toBeNull();
  if (size === null) return;

  expect(box.x, `${what} starts left of the screen`).toBeGreaterThanOrEqual(-1);
  expect(
    box.x + box.width,
    `${what} ends ${String(Math.round(box.x + box.width - size.width))}px past the right edge`,
  ).toBeLessThanOrEqual(size.width + 1);
  expect(box.y + box.height, `${what} ends below the screen`).toBeLessThanOrEqual(size.height + 1);
}

/**
 * Horizontal fit only, for content that lives inside a scroll container.
 *
 * A tall panel inside the sheet is SUPPOSED to run past the bottom of the screen — that
 * is what scrolling it means, and asserting otherwise would forbid a telemetry panel
 * from ever having more than a screenful in it. Sideways is different: there is no
 * horizontal scroll anywhere in this layout, so anything past the right edge is
 * unreachable rather than merely below the fold.
 */
async function expectFitsAcross(page: Page, box: Box | null, what: string): Promise<void> {
  expect(box, `${what} is not rendered`).not.toBeNull();
  const size = page.viewportSize();
  if (box === null || size === null) return;

  expect(box.x, `${what} starts left of the screen`).toBeGreaterThanOrEqual(-1);
  expect(
    box.x + box.width,
    `${what} ends ${String(Math.round(box.x + box.width - size.width))}px past the right edge`,
  ).toBeLessThanOrEqual(size.width + 1);
}

test("@mobile the page never scrolls sideways", async ({ page }) => {
  await openApp(page);

  // The cheapest possible statement of "nothing is off screen", and the one that
  // catches an overflow wherever it comes from. `.shell` clips with `overflow: hidden`,
  // so an element hanging off the right does not always produce a scrollbar — hence the
  // per-element checks below as well as this one.
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
});

test("@mobile every header control is on screen", async ({ page }) => {
  await openApp(page);

  // The header is a non-wrapping flex row of four controls sized for a laptop. On a
  // 412px screen the catalog badge was the one pushed out, and `.shell { overflow:
  // hidden }` clipped it away silently — the status most worth reading, invisible.
  for (const [what, locator] of [
    ["the brand", page.locator(".shell__brand")],
    ["the search trigger", page.getByRole("button", { name: "Search satellites" })],
    ["the observer summary", page.getByTestId("observer-summary")],
    ["the catalog badge", page.getByTestId("catalog-count")],
  ] as const) {
    await expectWithinViewport(page, await locator.boundingBox(), what);
  }
});

test("@mobile the open panel is on screen, not beside it", async ({ page }) => {
  await openApp(page);

  // "Visible tonight" is open by default, so this is the first thing a phone user sees.
  // It used to be rendered at left: 11rem, width: 20rem — a right edge at 496px on a
  // 412px screen. No observer is set here, so the panel shows its prompt rather than a
  // pass list; that is deliberate, because what is under test is the box, and pass
  // content is already covered at length in visible-tonight.spec.ts.
  await expect(page.getByTestId("bottom-sheet")).toBeVisible();
  await expectWithinViewport(page, await page.getByTestId("bottom-sheet").boundingBox(), "the sheet");
  await expect(page.getByTestId("visible-tonight-no-observer")).toBeVisible();

  // Open every other panel in turn and check the same thing. These four carry real
  // content from the seeded API, so they exercise widths the default panel does not:
  // each is a different component with its own tables, lists and long provider strings.
  for (const id of ["weather", "solar", "launches", "imagery"]) {
    await page.getByTestId(`panel-toggle-${id}`).click();
    const body = page.getByTestId("bottom-sheet-body");
    await expect(body).toBeVisible();
    await expectFitsAcross(page, await body.boundingBox(), `the ${id} panel`);

    // The box being on screen is not enough: content can overflow a box that fits.
    const overflows = await body.evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(overflows, `the ${id} panel overflows its own container`).toBe(false);
  }
});

test("@mobile the tab bar is reachable by thumb", async ({ page }) => {
  await openApp(page);

  const rail = page.getByTestId("panel-rail");
  const railBox = await rail.boundingBox();
  await expectWithinViewport(page, railBox, "the tab bar");

  const size = page.viewportSize();
  expect(size).not.toBeNull();
  if (railBox === null || size === null) return;

  // Bottom half of the screen: the whole point of moving the rail is that every control
  // in this app used to live in the top 64px, which is where a thumb cannot go.
  expect(railBox.y).toBeGreaterThan(size.height / 2);

  // Each tab was about 24px tall as a vertical rail — under the WCAG 2.2 minimum and
  // less than half the touch guidance.
  const tabs = rail.getByRole("button");
  const count = await tabs.count();
  expect(count).toBeGreaterThanOrEqual(5);
  for (let index = 0; index < count; index += 1) {
    const box = await tabs.nth(index).boundingBox();
    expect(box).not.toBeNull();
    if (box === null) continue;
    expect(box.height, `tab ${String(index)} is ${String(Math.round(box.height))}px tall`)
      .toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  }
});

test("@mobile the sheet resizes from the keyboard, not only by dragging", async ({ page }) => {
  await openApp(page);

  const sheet = page.getByTestId("bottom-sheet");
  const handle = page.getByTestId("bottom-sheet-handle");
  await expect(sheet).toHaveAttribute("data-detent", "peek");

  /*
   * Polled, not measured once.
   *
   * The sheet animates over 160ms, and the detent attribute flips on the React render
   * that starts the transition — so a single `boundingBox()` straight after it reports
   * the height the sheet is animating FROM. Read once, this asserted 144 > 144 and
   * failed against a change that was working correctly.
   */
  const settledHeight = async (): Promise<number> => {
    let previous = -1;
    await expect
      .poll(
        async () => {
          const box = await sheet.boundingBox();
          const height = Math.round(box?.height ?? 0);
          const stable = height === previous;
          previous = height;
          return stable;
        },
        { timeout: 5_000 },
      )
      .toBe(true);
    return previous;
  };
  const peekHeight = await settledHeight();

  // A drag is invisible, unannounced and unavailable to a keyboard. The handle has to
  // work as an ordinary button or the sheet has exactly one way in.
  await handle.focus();
  await page.keyboard.press("Enter");
  await expect(sheet).toHaveAttribute("data-detent", "half");
  expect(await settledHeight()).toBeGreaterThan(peekHeight);

  await page.keyboard.press("Enter");
  await expect(sheet).toHaveAttribute("data-detent", "full");
  const fullHeight = await settledHeight();
  expect(fullHeight).toBeGreaterThan(peekHeight);

  // It wraps rather than stopping at the top. A control that does nothing at the end of
  // its range reads as broken, and this is the way back to the globe.
  await page.keyboard.press("Enter");
  await expect(sheet).toHaveAttribute("data-detent", "peek");

  // The globe is never entirely covered, even at full.
  const size = page.viewportSize();
  expect(size).not.toBeNull();
  if (size !== null) expect(fullHeight).toBeLessThan(size.height * 0.85);
});

test("@mobile selecting an object raises the sheet, and closing it gives the panel back", async ({
  page,
}) => {
  await openApp(page);

  await expect(page.getByTestId("bottom-sheet")).toHaveAttribute("data-detent", "peek");
  await expect(page.getByTestId("visible-tonight-no-observer")).toBeVisible();

  await page.getByRole("button", { name: "Search satellites" }).click();
  await page.getByPlaceholder(/search/i).fill("ISS");
  await page.getByRole("option").first().click();

  // On a wide screen the telemetry panel appears in a corner and nothing else moves. In
  // one column there is nowhere for it to appear, so a selection that left the sheet at
  // peek would answer "which object is this" with a name and nothing else.
  await expect(page.getByTestId("telemetry-panel")).toBeVisible();
  await expect(page.getByTestId("bottom-sheet")).toHaveAttribute("data-detent", "half");
  // The sheet must fit; its contents scroll inside it. The telemetry panel with look
  // angles, radio and passes is comfortably taller than a phone screen, and that is the
  // arrangement working rather than failing.
  await expectWithinViewport(page, await page.getByTestId("bottom-sheet").boundingBox(), "the sheet");
  await expectFitsAcross(
    page,
    await page.getByTestId("telemetry-panel").boundingBox(),
    "the telemetry panel",
  );

  // Closing the selection must not leave an empty sheet: the panel that was there
  // before is still open and comes back.
  await page.getByTestId("telemetry-panel").getByRole("button", { name: /close/i }).click();
  await expect(page.getByTestId("telemetry-panel")).toHaveCount(0);
  await expect(page.getByTestId("visible-tonight-no-observer")).toBeVisible();
});

test("@mobile one panel at a time, so a phone polls one provider", async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId("visible-tonight-no-observer")).toBeVisible();

  // Each panel fetches on mount and refreshes on a timer. In one column only the panel
  // in front is mounted, so opening a second does not leave the first polling behind a
  // sheet nobody can see. `toHaveCount(0)` rather than `not.toBeVisible()`, because the
  // claim is that it is unmounted — hidden with CSS would keep the timer running, which
  // is the whole thing this is checking.
  await page.getByTestId("panel-toggle-weather").click();
  await expect(page.getByTestId("space-weather")).toBeVisible();
  await expect(page.getByTestId("visible-tonight-no-observer")).toHaveCount(0);

  // Both are still OPEN — the tab states say so — which is what makes going back a tap
  // rather than a reconfiguration. Two pressed tabs and one visible panel is precisely
  // why `aria-current` exists here: without it, a reader who cannot see which card is
  // showing has two identical announcements and no way to tell them apart.
  await expect(page.getByTestId("panel-toggle-tonight")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("panel-toggle-tonight")).not.toHaveAttribute("aria-current", /.*/);
  await expect(page.getByTestId("panel-toggle-weather")).toHaveAttribute("aria-current", "true");

  // Tapping a tab that is open but behind must bring it forward, not close it. Routing
  // this through `toggle` made the tab you tap to see something make it disappear.
  await page.getByTestId("panel-toggle-tonight").click();
  await expect(page.getByTestId("visible-tonight-no-observer")).toBeVisible();
  await expect(page.getByTestId("space-weather")).toHaveCount(0);
  await expect(page.getByTestId("panel-toggle-weather")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("panel-toggle-tonight")).toHaveAttribute("aria-current", "true");

  // And tapping the one already in front is the way back to the globe.
  await page.getByTestId("panel-toggle-tonight").click();
  await expect(page.getByTestId("visible-tonight-no-observer")).toHaveCount(0);
  await expect(page.getByTestId("panel-toggle-tonight")).toHaveAttribute("aria-pressed", "false");
});

/**
 * Touch selection: the interaction that did not work at all.
 *
 * Catalog points are drawn at 3-4 pixels and `scene.pick` defaults to a 3x3 pixel
 * rectangle. A fingertip is roughly 44 pixels across, so on a phone essentially every
 * tap missed — and missing reads as a deliberate deselect, so it failed silently and
 * looked like a globe that simply did not respond.
 *
 * The test taps deliberately OFF-CENTRE. Tapping the exact pixel would have passed
 * before this change and proves nothing about a finger.
 */
test("@mobile a tap near a satellite selects it, not nothing", async ({ page }) => {
  const OFFSET_PX = 12;

  await page.addInitScript(() => {
    interface Captured {
      scene: unknown;
      points: { id: string; position: { x: number; y: number; z: number } }[];
    }
    const captured: Captured = { scene: null, points: [] };
    (window as unknown as { __touch: Captured }).__touch = captured;

    /*
     * Two prototype patches, installed the moment the Cesium bundle loads.
     *
     * The namespace object is an esbuild IIFE whose exports are non-configurable
     * getters, so `Cesium.Viewer` cannot be replaced — but prototypes are ordinary
     * objects. `Scene.prototype.render` runs every frame and is how the live scene is
     * captured; `PointPrimitiveCollection.prototype.add` is how the drawn points are.
     * Both wrap interfaces the app already uses, so what is measured is shipped code.
     */
    const patch = (): boolean => {
      const cesium = (
        window as unknown as {
          Cesium?: {
            Scene?: { prototype: Record<string, unknown> };
            PointPrimitiveCollection?: { prototype: Record<string, unknown> };
          };
        }
      ).Cesium;
      const scenePrototype = cesium?.Scene?.prototype;
      const pointsPrototype = cesium?.PointPrimitiveCollection?.prototype;
      if (scenePrototype === undefined || pointsPrototype === undefined) return false;
      if (captured.scene !== null || captured.points.length > 0) return true;

      const originalRender = scenePrototype["render"] as (...args: unknown[]) => unknown;
      scenePrototype["render"] = function (this: unknown, ...args: unknown[]): unknown {
        captured.scene = this;
        return originalRender.apply(this, args);
      };

      const originalAdd = pointsPrototype["add"] as (
        ...args: unknown[]
      ) => { id: string; position: { x: number; y: number; z: number } };
      pointsPrototype["add"] = function (this: unknown, ...args: unknown[]) {
        const primitive = originalAdd.apply(this, args);
        captured.points.push(primitive);
        return primitive;
      };
      const originalRemoveAll = pointsPrototype["removeAll"] as (...args: unknown[]) => unknown;
      pointsPrototype["removeAll"] = function (this: unknown, ...args: unknown[]): unknown {
        captured.points.length = 0;
        return originalRemoveAll.apply(this, args);
      };
      return true;
    };

    // `document`, not `document.documentElement`: an init script runs before the
    // document is parsed, so documentElement is null and observe() would throw, taking
    // the interval backstop below down with it.
    const observer = new MutationObserver(() => {
      for (const script of document.querySelectorAll("script[src*='/cesium/']")) {
        script.addEventListener("load", () => {
          patch();
        });
      }
      if (patch()) observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });

    const poll = setInterval(() => {
      if (patch()) {
        clearInterval(poll);
        observer.disconnect();
      }
    }, 10);
  });

  await openApp(page);

  // Find a point the globe is actually drawing on the near side of the Earth, and ask
  // Cesium itself where on screen it is. Its own projection, not our arithmetic.
  const target = await page.waitForFunction(
    () => {
      const captured = (
        window as unknown as {
          __touch: { scene: unknown; points: { id: string; position: unknown }[] };
          Cesium?: {
            SceneTransforms: {
              worldToWindowCoordinates: (
                scene: unknown,
                position: unknown,
              ) => { x: number; y: number } | undefined;
            };
          };
        }
      ).__touch;
      const cesium = (window as unknown as { Cesium?: unknown }).Cesium as
        | {
            SceneTransforms: {
              worldToWindowCoordinates: (
                scene: unknown,
                position: unknown,
              ) => { x: number; y: number } | undefined;
            };
          }
        | undefined;
      if (captured.scene === null || cesium === undefined) return null;

      for (const point of captured.points) {
        const window2d = cesium.SceneTransforms.worldToWindowCoordinates(
          captured.scene,
          point.position,
        );
        if (window2d === undefined) continue;
        // Comfortably inside the viewport, so a 12px offset cannot land off screen or
        // underneath the header or the sheet.
        if (
          window2d.x > 80 &&
          window2d.x < globalThis.innerWidth - 80 &&
          window2d.y > 140 &&
          window2d.y < globalThis.innerHeight * 0.45
        ) {
          return { id: point.id, x: window2d.x, y: window2d.y };
        }
      }
      return null;
    },
    undefined,
    { timeout: 60_000 },
  );

  const { id, x, y } = (await target.jsonValue()) as { id: string; x: number; y: number };

  // Off-centre by 12 pixels, which is well inside a fingertip and well outside the
  // default 3x3 pick box. This is the line that fails against the old code.
  await page.touchscreen.tap(x + OFFSET_PX, y);

  await expect(page.getByTestId("telemetry-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("selection-status")).toContainText(`catalog number ${id}`, {
    timeout: 30_000,
  });
});
