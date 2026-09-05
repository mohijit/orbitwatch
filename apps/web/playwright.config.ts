import { defineConfig, devices } from "@playwright/test";

/**
 * Runtime verification for the web app.
 *
 * Runs against the PRODUCTION build, not the dev server: Turbopack's dev and build
 * pipelines differ, and the Cesium asset path is exactly the kind of thing that can
 * work in dev and break in production.
 */
/**
 * Headless Chromium has no GPU, so WebGL falls back to SwiftShader. These flags make
 * that fallback available rather than failing outright, which is what lets a globe
 * actually render in CI.
 */
const SWIFTSHADER_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
];

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  /**
   * Generous, because these tests drive a real 3D renderer with no GPU.
   *
   * Headless Chromium falls back to SwiftShader, so every frame of the globe is
   * rasterised on the CPU. Measured here: roughly 4-15 frames per second once the
   * catalog is drawn, against 60 on real hardware. The app requests a render each
   * frame while the timeline is live — that is the dead reckoning that keeps motion
   * smooth — so the main thread stays busy, and Playwright's actionability checks,
   * which wait for an element to hold still across animation frames, are slow in
   * proportion. Individual journeys measured over a minute at 1280x720.
   *
   * This is the cost of testing the renderer rather than mocking it. Do not reach for
   * `force: true` to make it faster: that skips exactly the visibility and hit-target
   * checks that catch a globe rendering over the top of the UI.
   */
  timeout: 300_000,
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      /*
       * Everything EXCEPT the mobile specs.
       *
       * Without this the desktop project also picks up `mobile-layout.spec.ts` and runs
       * it at 1280x720 with a mouse, where a tab bar is a vertical rail and the sheet
       * does not exist — so all eight fail, describing a layout they were never about.
       * The two projects partition the suite: `grep` on one, `grepInvert` on the other.
       */
      grepInvert: /@mobile/,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: SWIFTSHADER_ARGS },
      },
    },
    /**
     * The same build, on a phone-shaped viewport with touch input.
     *
     * A SUBSET, NOT THE WHOLE SUITE
     * The desktop project takes about seven minutes at `workers: 1`, and running all of
     * it twice would not fit the CI budget. This project runs only what is tagged
     * `@mobile`: the layout and touch behaviour that genuinely differs. Everything else
     * — orbital maths, provider handling, offline behaviour — is viewport-independent
     * and is already covered once.
     *
     * WHAT IT CANNOT TELL US
     * A device descriptor sets a viewport, a user agent and `hasTouch`. It does not give
     * us a phone: this is still desktop Chromium on SwiftShader, so it verifies that the
     * layout fits and that a tap selects the right object, and says nothing at all about
     * frame rate or thermals. Those are measured on real hardware and recorded in
     * `docs/adr/0006-mobile-web-performance.md`.
     */
    {
      name: "mobile-chromium",
      grep: /@mobile/,
      use: {
        // Pixel 7: 412x915 at DPR 2.625, `hasTouch` and `isMobile` — and `isMobile`
        // is Chromium-only, which is the browser this suite runs.
        ...devices["Pixel 7"],
        launchOptions: { args: SWIFTSHADER_ARGS },
      },
    },
  ],
  webServer: [
    {
      // Seeded in-memory API: no DATABASE_URL, so this runs unmodified on a fork's
      // pull request. Seeded from real captured CelesTrak fixtures, not invented data.
      command: "pnpm --filter @orbitwatch/api exec tsx src/seed-dev.ts",
      url: "http://127.0.0.1:3333/health/live",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "pnpm exec next start --port 3100",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
