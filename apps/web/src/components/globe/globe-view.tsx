"use client";

import { useEffect, useRef, useState } from "react";

import { CESIUM_WIDGET_CSS_HREF, loadCesium } from "./cesium-loader";

/**
 * Milestone 0 proof of concept for the Cesium globe.
 *
 * Purpose: prove that CesiumJS initialises, renders and disposes correctly inside
 * Next.js 16 with Turbopack and React 19 StrictMode, and that the whole app still
 * production-builds. The real tracking globe is Milestone 3; this deliberately
 * renders no satellites.
 *
 * StrictMode note: React 19 mounts effects twice in development. Without the
 * destroy() in the cleanup, the second mount leaves an orphaned WebGL context and the
 * page slowly leaks GPU memory on every hot reload.
 */

type LoadState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "failed"; message: string };

export function GlobeView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    // Guards against the StrictMode double-mount finishing out of order and against
    // setting state on an unmounted component.
    let disposed = false;
    let viewer: { destroy: () => void; isDestroyed: () => boolean } | undefined;

    void (async () => {
      try {
        const Cesium = await loadCesium();
        if (disposed) return;

        // No Ion token is configured, and none is required: Ion is Cesium's hosted
        // asset service, and defaulting to it would make the app fail without a
        // credential. We use the offline Natural Earth imagery that ships with
        // Cesium, so the globe renders with zero configuration.
        const instance = new Cesium.Viewer(container, {
          baseLayer: Cesium.ImageryLayer.fromProviderAsync(
            Promise.resolve(
              Cesium.TileMapServiceImageryProvider.fromUrl(
                Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII"),
              ),
            ),
            {},
          ),
          // The default widgets are mission-control clutter; the real UI supplies its
          // own controls, and turning them off now keeps the PoC honest about size.
          baseLayerPicker: false,
          geocoder: false,
          homeButton: false,
          sceneModePicker: false,
          navigationHelpButton: false,
          animation: false,
          timeline: false,
          fullscreenButton: false,
          infoBox: false,
          selectionIndicator: false,
        });

        if (disposed) {
          instance.destroy();
          return;
        }

        // Terrain lighting from the Sun gives the day/night terminator for free.
        instance.scene.globe.enableLighting = true;
        // Typed as optional in Cesium 1.144: the scene may be constructed without a
        // sky atmosphere (2D/Columbus view, or a viewer configured without one).
        if (instance.scene.skyAtmosphere !== undefined) {
          instance.scene.skyAtmosphere.show = true;
        }

        // A three-quarter view rather than straight-down: it reads as a planet in
        // space rather than a map, which is the intended first impression.
        instance.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(20, 15, 26_000_000),
        });

        viewer = instance;
        setState({ status: "ready" });
      } catch (error) {
        if (disposed) return;
        setState({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      disposed = true;
      if (viewer !== undefined && !viewer.isDestroyed()) viewer.destroy();
    };
  }, []);

  return (
    <>
      {/* Cesium's widget CSS is served from the copied assets, not the bundler. */}
      <link rel="stylesheet" href={CESIUM_WIDGET_CSS_HREF} />

      <div className="globe-root">
        <div ref={containerRef} className="globe-canvas" />

        {state.status === "loading" ? (
          <div className="globe-overlay" role="status" aria-live="polite">
            <span className="globe-overlay__label">Initialising globe engine…</span>
          </div>
        ) : null}

        {state.status === "failed" ? (
          <div className="globe-overlay globe-overlay--error" role="alert">
            <span className="globe-overlay__label">Globe failed to initialise</span>
            {/* Deliberately a message, never a stack trace. */}
            <span className="globe-overlay__detail">{state.message}</span>
          </div>
        ) : null}
      </div>
    </>
  );
}
