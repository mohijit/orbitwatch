import { expect, test } from "@playwright/test";

/**
 * Security response headers.
 *
 * Checked here rather than by reading next.config.ts, because the question is not
 * whether the configuration says the right thing — it is whether the server actually
 * sends it. Next's headers are a build artefact: they live in the routes manifest, so
 * an edit that is never rebuilt, or a host that ignores the manifest, produces exactly
 * this failure with the config file still looking correct.
 *
 * There is no Content-Security-Policy yet, deliberately, and this suite does not
 * pretend otherwise. Cesium needs WASM compilation and blob: workers, so a real policy
 * is a piece of work whose failure mode is a globe that breaks only in production. It
 * belongs in the M10 hardening pass, tested against this suite.
 */

const EXPECTED = {
  // Clickjacking is the concrete risk: observer location is set by clicking the globe,
  // and it is the one piece of personal data this product holds.
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
} as const;

for (const path of ["/", "/methodology", "/agreement"]) {
  test(`${path} is served with its security headers`, async ({ request }) => {
    const response = await request.get(path);
    expect(response.status()).toBe(200);

    const headers = response.headers();
    for (const [name, value] of Object.entries(EXPECTED)) {
      expect(headers[name], `${name} on ${path}`).toBe(value);
    }
  });
}

test("the headers cover asset paths too, not only pages", async ({ request }) => {
  // The Cesium runtime is served from public/, which is a different serving path inside
  // Next than a rendered route. `nosniff` on a directory full of scripts and WASM is
  // the case that matters most, so the source pattern has to reach it.
  const response = await request.get("/cesium/Cesium.js");
  expect(response.status()).toBe(200);
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
});
