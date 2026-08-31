import {
  POSITION_STRIDE,
  type GlobeToNativeMessage,
} from "@orbitwatch/contracts";

/**
 * The Cesium scene that runs inside the mobile WebView.
 *
 * This is a purpose-built scene, NOT the public website in a frame. It renders points
 * and orbit geometry and nothing else: no navigation, no panels, no application state.
 * All of that is native.
 *
 * The scene is generated as a single HTML string so it can be handed straight to
 * react-native-webview with no bundler step and no network dependency. Cesium itself
 * is served from the app bundle, so the globe works offline from cached elements.
 *
 * SECURITY: the WebView must be configured to load only this local content. It never
 * navigates to a remote origin, so a compromised third-party page cannot reach the
 * bridge.
 */

export interface SceneOptions {
  /** Path the WebView can use to load the Cesium bundle from the app bundle. */
  readonly cesiumBaseUrl: string;
  /** Points are drawn at this size in device-independent pixels. */
  readonly pointSizePx?: number;
}

/**
 * Build the scene HTML.
 *
 * Kept as a pure function of its options so it can be snapshot-tested without a
 * device or a WebView.
 */
export function buildSceneHtml(options: SceneOptions): string {
  const pointSize = options.pointSizePx ?? 3;
  const baseUrl = assertLocalAssetUrl(options.cesiumBaseUrl.replace(/\/$/, ""));
  const baseUrlAttribute = escapeHtmlAttribute(baseUrl);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<link rel="stylesheet" href="${baseUrlAttribute}/Widgets/widgets.css" />
<style>
  html, body, #globe { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #070b14; }
  .cesium-widget-credits { display: none; }
  #attribution { position: absolute; bottom: 4px; left: 6px; font: 10px system-ui; color: #8ba0bd; z-index: 2; }
</style>
</head>
<body>
<div id="globe"></div>
<!-- Cesium attribution is a licence requirement. The default credit container is
     hidden because it is unreadable at phone size; this replaces it. -->
<div id="attribution">Cesium · Natural Earth II</div>
<script>window.CESIUM_BASE_URL = ${JSON.stringify(`${baseUrl}/`)};</script>
<script src="${baseUrlAttribute}/Cesium.js"></script>
<script>
(function () {
  "use strict";

  var STRIDE = ${POSITION_STRIDE};
  var POINT_SIZE = ${pointSize};

  function toNative(message) {
    // react-native-webview injects ReactNativeWebView. Guarding lets the same scene
    // be opened in a desktop browser during development.
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
  }

  function fail(code, message) {
    toNative({ type: "globe-error", code: code, message: String(message) });
  }

  var viewer, points, catalogIds = [], indexById = new Map(), rendering = true;

  try {
    viewer = new Cesium.Viewer("globe", {
      baseLayerPicker: false, geocoder: false, homeButton: false,
      sceneModePicker: false, navigationHelpButton: false, animation: false,
      timeline: false, fullscreenButton: false, infoBox: false,
      selectionIndicator: false,
      // requestRenderMode means the scene only redraws when something changes, which
      // is the single biggest battery saving available on mobile.
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity
    });
    viewer.scene.globe.enableLighting = true;
    if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = true;

    points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());

    // A lost context is common on mobile when the OS reclaims GPU memory. Native has
    // to hear about it so it can offer a reload instead of showing a frozen globe.
    viewer.scene.canvas.addEventListener("webglcontextlost", function (event) {
      event.preventDefault();
      fail("context-lost", "WebGL context lost");
    });

    var handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(function (click) {
      var picked = viewer.scene.pick(click.position);
      if (picked && picked.primitive && typeof picked.primitive.id === "string") {
        toNative({ type: "satellite-tapped", catalogId: picked.primitive.id });
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    viewer.camera.moveEnd.addEventListener(function () {
      var carto = viewer.camera.positionCartographic;
      toNative({
        type: "camera-changed",
        latitude: Cesium.Math.toDegrees(carto.latitude),
        longitude: Cesium.Math.toDegrees(carto.longitude),
        heightMeters: carto.height
      });
    });

    toNative({
      type: "globe-ready",
      cesiumVersion: Cesium.VERSION,
      webglAvailable: true
    });
  } catch (error) {
    fail("webgl-unavailable", error && error.message ? error.message : error);
  }

  function base64ToFloat32(encoded) {
    var binary = atob(encoded);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  }

  function applyPositions(message) {
    if (!points) return;
    var started = performance.now();
    var values = base64ToFloat32(message.positions);
    var count = Math.min(message.catalogIds.length, Math.floor(values.length / STRIDE));

    // Rebuild the collection only when the catalog itself changed. Steady-state
    // updates mutate existing primitives, which is the cheap path measured in ADR 0003.
    if (catalogIds.length !== message.catalogIds.length) {
      points.removeAll();
      indexById.clear();
      for (var n = 0; n < count; n += 1) {
        var created = points.add({
          position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
          pixelSize: POINT_SIZE,
          color: Cesium.Color.CYAN
        });
        created.id = message.catalogIds[n];
        indexById.set(message.catalogIds[n], n);
      }
      catalogIds = message.catalogIds.slice();
    }

    for (var i = 0; i < count; i += 1) {
      var offset = i * STRIDE;
      var point = points.get(i);
      if (!point) continue;
      point.position = Cesium.Cartesian3.fromDegrees(
        values[offset], values[offset + 1], values[offset + 2] * 1000
      );
    }

    if (rendering) viewer.scene.requestRender();

    toNative({
      type: "globe-stats",
      fps: 0,
      renderedObjectCount: count,
      lastUpdateMs: performance.now() - started
    });
  }

  function handle(message) {
    switch (message.type) {
      case "satellite-positions": applyPositions(message); break;
      case "set-rendering":
        rendering = message.enabled;
        // Suspending the render loop is what stops the globe draining battery in
        // the background.
        if (viewer) viewer.useDefaultRenderLoop = message.enabled;
        break;
      case "set-camera":
        if (!viewer) break;
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(
            message.longitude, message.latitude, message.heightMeters
          ),
          duration: message.flyDurationSeconds
        });
        break;
      case "select-satellite": break;
      case "set-layers": break;
      case "set-quality": break;
      default:
        // Never silently ignore: an unknown message means the two sides disagree.
        fail("bad-message", "Unknown message type: " + message.type);
    }
  }

  function onMessage(event) {
    try {
      handle(JSON.parse(event.data));
    } catch (error) {
      fail("bad-message", error && error.message ? error.message : error);
    }
  }

  // iOS delivers to window, Android to document.
  window.addEventListener("message", onMessage);
  document.addEventListener("message", onMessage);
})();
</script>
</body>
</html>`;
}

/**
 * Reject anything that is not a local asset URL.
 *
 * The scene must never load its renderer over the network: it has to work offline
 * from cached elements, and a remote origin inside the WebView would sit on the same
 * side of the bridge as the app. Restricting the scheme here means a
 * misconfiguration fails loudly at construction instead of silently widening the
 * trust boundary.
 */
function assertLocalAssetUrl(value: string): string {
  const allowedPrefixes = ["file://", "asset://", "/", "./"];
  const isLocal = allowedPrefixes.some((prefix) => value.startsWith(prefix));

  if (!isLocal) {
    throw new Error(
      `Cesium base URL must be a local asset path, received "${value}". ` +
        `The globe scene must not load its renderer from a remote origin.`,
    );
  }
  if (value.includes("<") || value.includes(">")) {
    throw new Error(`Cesium base URL contains markup characters: "${value}"`);
  }
  return value;
}

/**
 * Escape a value for interpolation into a double-quoted HTML attribute.
 *
 * The base URL is developer-supplied rather than user input, so this is defence in
 * depth — but the scene is a generated string, and generated markup is exactly where
 * an unescaped interpolation goes unnoticed.
 */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Narrow an unknown parsed payload to a scene-originated message, for the host. */
export type SceneMessage = GlobeToNativeMessage;
