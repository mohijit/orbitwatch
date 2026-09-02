import { defineConfig } from "vitest/config";

/**
 * Unit tests for the web app's pure logic.
 *
 * Deliberately narrow: this covers modules with no DOM and no React — date arithmetic,
 * URL construction, the spoken-text helpers. Component and integration behaviour is
 * tested through Playwright against the production build, where it can be exercised in
 * a real browser rather than a simulated one.
 *
 * `e2e/**` is excluded because those files are Playwright specs; running them under
 * vitest would fail on the first `test.use`.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
