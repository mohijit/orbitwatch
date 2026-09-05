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

  /**
   * Response headers.
   *
   * Not bundler configuration, which is what the note above is about -- these are
   * served by `next start` and by any host that honours the headers manifest. A pure
   * static export would drop them, so they would have to be reissued at the CDN.
   *
   * No Content-Security-Policy yet. Cesium needs WASM compilation, blob: workers and
   * blob: URLs for its own assets, so a real policy here is a piece of work with a
   * genuine chance of breaking the globe in production only -- it belongs in the M10
   * hardening pass, with the E2E suite run against it. These three cost nothing and
   * close the gaps that do not need one.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          /*
           * Nothing should ever frame this app.
           *
           * The concrete risk is clickjacking: an attacker frames the globe, overlays
           * their own controls, and a click the user believes sets their observing
           * location does something else entirely. Observer location is the one piece
           * of personal data this product holds, and it is set by clicking the globe.
           *
           * DENY rather than SAMEORIGIN because nothing here frames anything. The
           * mobile app is unaffected: a WebView loading a page at the top level is not
           * framing it.
           */
          { key: "X-Frame-Options", value: "DENY" },

          /*
           * Never let a browser second-guess a Content-Type. The API serves JSON built
           * from third-party provider responses, and MIME sniffing is how a response
           * that was meant as data gets executed as script.
           */
          { key: "X-Content-Type-Options", value: "nosniff" },

          /*
           * Send the full path to ourselves, the origin only to anyone else. The
           * outbound links here are attribution -- Cesium, NASA, CelesTrak, SatNOGS --
           * and they have no business learning which satellite someone was looking at.
           */
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
