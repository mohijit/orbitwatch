import { describe, expect, it } from "vitest";

import { buildSceneHtml } from "./scene-html";

/**
 * The scene is a generated string, which makes it easy to get subtly wrong in ways
 * that only appear on a device. These tests pin the properties that would otherwise
 * fail silently in someone's hand.
 */
describe("buildSceneHtml", () => {
  const html = buildSceneHtml({ cesiumBaseUrl: "file:///android_asset/cesium" });

  it("sets CESIUM_BASE_URL before loading the bundle", () => {
    // Ordering is load-bearing: Cesium reads the global during initialisation, so a
    // script tag placed first would look for its workers in the wrong place.
    const baseUrlIndex = html.indexOf("CESIUM_BASE_URL");
    const scriptIndex = html.indexOf("Cesium.js");
    expect(baseUrlIndex).toBeGreaterThan(-1);
    expect(scriptIndex).toBeGreaterThan(baseUrlIndex);
  });

  it("loads Cesium locally, never from a remote origin", () => {
    // The WebView must not reach the network for its renderer: it has to work offline
    // from cached elements, and a remote origin would be an injection surface.
    expect(html).not.toMatch(/https?:\/\/(?!.*w3\.org)/);
    expect(html).toContain("file:///android_asset/cesium/Cesium.js");
  });

  it("normalises a trailing slash in the base URL", () => {
    const withSlash = buildSceneHtml({ cesiumBaseUrl: "file:///assets/cesium/" });
    expect(withSlash).toContain("file:///assets/cesium/Cesium.js");
    expect(withSlash).not.toContain("cesium//Cesium.js");
  });

  it("uses a batched point primitive collection", () => {
    // ADR 0003: the Entity API is 16x more expensive to update at 5,000 objects.
    expect(html).toContain("PointPrimitiveCollection");
    expect(html).not.toContain("viewer.entities.add");
  });

  it("enables request render mode for battery", () => {
    expect(html).toContain("requestRenderMode: true");
  });

  it("reports a lost WebGL context to native", () => {
    expect(html).toContain("webglcontextlost");
    expect(html).toContain("context-lost");
  });

  it("reports unknown messages instead of ignoring them", () => {
    expect(html).toContain("bad-message");
    expect(html).toContain("Unknown message type");
  });

  it("listens on both window and document for the bridge", () => {
    // iOS delivers postMessage to window, Android to document. Missing either breaks
    // exactly one platform, which is easy to ship without noticing.
    expect(html).toContain('window.addEventListener("message"');
    expect(html).toContain('document.addEventListener("message"');
  });

  it("keeps Cesium attribution visible", () => {
    expect(html).toContain("Cesium");
    expect(html).toContain("attribution");
  });

  it("uses the shared position stride", () => {
    // A mismatch with the packer would scatter every satellite.
    expect(html).toContain("var STRIDE = 3;");
  });

  it("converts altitude from kilometres to metres for Cesium", () => {
    // Cesium expects metres; the bridge carries kilometres. Getting this wrong puts
    // every satellite 1000x too low, which looks almost plausible.
    expect(html).toContain("values[offset + 2] * 1000");
  });

  it("rejects a remote base URL", () => {
    // The renderer must come from the app bundle, never the network.
    expect(() => buildSceneHtml({ cesiumBaseUrl: "https://example.com/cesium" })).toThrow(
      /local asset path/,
    );
  });

  it("rejects markup characters in the base URL", () => {
    expect(() =>
      buildSceneHtml({ cesiumBaseUrl: 'file:///a"</script><script>alert(1)//' }),
    ).toThrow(/markup characters/);
  });

  it("escapes quotes when interpolating the base URL into attributes", () => {
    const escaped = buildSceneHtml({ cesiumBaseUrl: 'file:///a"b' });
    expect(escaped).toContain("&quot;");
    expect(escaped).not.toContain('href="file:///a"b');
  });
});
