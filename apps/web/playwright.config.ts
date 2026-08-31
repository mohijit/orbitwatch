import { defineConfig, devices } from "@playwright/test";

/**
 * Runtime verification for the web app.
 *
 * Runs against the PRODUCTION build, not the dev server: Turbopack's dev and build
 * pipelines differ, and the Cesium asset path is exactly the kind of thing that can
 * work in dev and break in production.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 120_000,
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          // Headless Chromium has no GPU, so WebGL falls back to SwiftShader. These
          // flags make that fallback available rather than failing outright, which is
          // what lets a globe actually render in CI.
          args: [
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
          ],
        },
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
