import type { NextConfig } from "next";

/**
 * Next.js 16 defaults to Turbopack, which does NOT support webpack plugins. The
 * conventional CesiumJS setup (copy-webpack-plugin plus DefinePlugin for
 * CESIUM_BASE_URL) therefore does not apply here.
 *
 * Instead:
 *   - Cesium's static assets are copied into public/cesium by the cesium:copy script,
 *     which runs automatically before dev and build.
 *   - window.CESIUM_BASE_URL is set at runtime in the globe component, before Cesium
 *     is imported.
 *
 * The result is that this file stays free of bundler configuration entirely.
 *
 * Note: satellite.js needs one build-time accommodation to be bundleable for a
 * browser, but it cannot be expressed here — see patches/README.md.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Cesium ships very large prebuilt assets; tracing them into the server bundle is
  // wasted work because they are served statically from public/.
  outputFileTracingExcludes: {
    "*": ["./public/cesium/**/*"],
  },
};

export default nextConfig;
