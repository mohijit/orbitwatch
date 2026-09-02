"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ObserverLocation } from "@orbitwatch/orbit-core";

import type { CatalogTickState } from "../../hooks/use-catalog-positions";
import { POSITION_FIELDS } from "../../hooks/use-catalog-positions";
import type { SelectedTelemetryState } from "../../hooks/use-selected-satellite";
import { CESIUM_WIDGET_CSS_HREF, loadCesium, type CesiumModule } from "./cesium-loader";
import type * as CesiumNamespace from "cesium";

/**
 * The live globe: the full catalog as batched point primitives, plus the selected
 * object's ground track and footprint.
 *
 * ARCHITECTURE (ADR 0002, benchmarked in M0)
 * One `PointPrimitiveCollection`, sized once when the catalog first becomes ready and
 * mutated in place on every tick. Never rebuilt, never one Entity per satellite: the
 * M0 benchmark showed the Entity API costing orders of magnitude more per update at
 * this scale, which is what makes 16,000+ objects at interactive frame rates possible
 * on ordinary hardware.
 */

const NOT_RENDERABLE_ALTITUDE = -1; // pushes an unusable position below the ellipsoid, out of view

/**
 * How far the renderer will dead-reckon past the last propagation before freezing.
 *
 * Ticks are ~1 s apart, so a few seconds of slack covers a late worker. Beyond that
 * something has actually stopped, and a straight line extended indefinitely from one
 * propagation stops resembling an orbit. Freezing is the honest failure.
 */
const MAX_EXTRAPOLATION_SECONDS = 5;

/** Stable id so the observer marker can be replaced without touching other entities. */
const OBSERVER_ENTITY_ID = "observer-location";

export interface SatelliteGlobeProps {
  readonly catalogState: CatalogTickState;
  readonly selectedCatalogId: string | undefined;
  readonly onSelect: (catalogId: string | undefined) => void;
  readonly telemetry: SelectedTelemetryState;
  /**
   * Whether the timeline is running in real time. False while scrubbing, where the
   * instant is fixed and positions must hold still.
   */
  readonly live: boolean;
  /** The observing location to mark, if one is set. */
  readonly observer: ObserverLocation | undefined;
  /**
   * While true, a click on the globe sets the observing location instead of selecting
   * a satellite. Modal, and the UI says so — a click that silently means two different
   * things depending on hidden state is how people lose their selection.
   */
  readonly pickingLocation: boolean;
  readonly onPickLocation: (latitude: number, longitude: number) => void;
}

type CesiumViewer = InstanceType<CesiumModule["Viewer"]>;
type CesiumPoints = InstanceType<CesiumModule["PointPrimitiveCollection"]>;

export function SatelliteGlobe({
  catalogState,
  selectedCatalogId,
  onSelect,
  telemetry,
  live,
  observer,
  pickingLocation,
  onPickLocation,
}: SatelliteGlobeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<CesiumViewer | null>(null);
  const pointsRef = useRef<CesiumPoints | null>(null);
  const catalogIdsRef = useRef<readonly string[]>([]);
  const groundTrackEntityIdsRef = useRef<string[]>([]);
  const cesiumRef = useRef<CesiumModule | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  /**
   * Camera control without a pointer.
   *
   * Cesium ships mouse and touch handlers and no keyboard ones, so a globe is
   * ordinarily unreachable for anyone who cannot drag it. These are the same three
   * gestures — rotate, zoom, reset — bound to the keys people already expect.
   *
   * `preventDefault` matters more than it looks: arrow keys scroll the document by
   * default, so without it a focused globe would scroll the page out from under
   * itself while appearing to ignore the key. That is worse than no handler at all.
   *
   * Amounts are proportional to the camera's height above the ellipsoid, so one press
   * moves a sensible fraction of what is on screen whether the view is the whole Earth
   * or one city.
   */
  const handleGlobeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (viewer === null || Cesium === null) return;

    const camera = viewer.camera;
    const height = camera.positionCartographic.height;
    const moveRate = height / 20;
    const rotateRadians = Cesium.Math.toRadians(3);

    switch (event.key) {
      case "ArrowLeft":
        camera.rotateRight(rotateRadians);
        break;
      case "ArrowRight":
        camera.rotateLeft(rotateRadians);
        break;
      case "ArrowUp":
        camera.rotateDown(rotateRadians);
        break;
      case "ArrowDown":
        camera.rotateUp(rotateRadians);
        break;
      case "+":
      case "=":
        camera.moveForward(moveRate);
        break;
      case "-":
      case "_":
        camera.moveBackward(moveRate);
        break;
      case "Home":
        camera.flyHome(0.5);
        break;
      default:
        // Every other key — Tab included — must keep its normal behaviour, or the
        // globe becomes a place focus goes into and cannot leave.
        return;
    }

    event.preventDefault();
    viewer.scene.requestRender();
  }, []);
  // The Cesium input handler is installed once, so it must read these through refs
  // rather than closing over the values that existed when the viewer was built.
  const pickingRef = useRef(pickingLocation);
  pickingRef.current = pickingLocation;
  const onPickLocationRef = useRef(onPickLocation);
  onPickLocationRef.current = onPickLocation;

  /**
   * Whether the viewer exists yet. State, not a ref, and that is the whole point.
   *
   * Cesium arrives asynchronously — a 6 MB engine fetched and evaluated after mount —
   * so the effects below routinely run before there is anything to draw into. Held in
   * a ref, the viewer becoming available re-renders nothing, so those effects would
   * never run again on their own: they only re-run when `catalogState`, the selection
   * or the timeline mode changes. In LIVE mode a propagation tick arrives every second
   * and hides that, which is why this survived M3. It is not hidden when the clock is
   * not advancing — SIMULATION, a backgrounded tab, or the pinned clock the E2E suite
   * uses — and there the catalog can become ready first and the globe then stays empty
   * permanently, with no error anywhere. Found by multi-object.spec.ts, which read the
   * point collection back out of the live scene and saw zero primitives in it.
   */
  const [globeReady, setGlobeReady] = useState(false);

  // Viewer: created once.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    let disposed = false;

    void (async () => {
      const Cesium = await loadCesium();
      if (disposed) return;
      cesiumRef.current = Cesium;

      const viewer = new Cesium.Viewer(container, {
        baseLayer: Cesium.ImageryLayer.fromProviderAsync(
          Promise.resolve(
            Cesium.TileMapServiceImageryProvider.fromUrl(
              Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII"),
            ),
          ),
          {},
        ),
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
        // requestRenderMode: propagation ticks and camera moves drive rendering
        // explicitly, so the GPU is not asked to redraw an unchanging scene 60x/sec.
        requestRenderMode: true,
        maximumRenderTimeChange: Infinity,
      });

      if (disposed) {
        viewer.destroy();
        return;
      }

      viewer.scene.globe.enableLighting = true;
      if (viewer.scene.skyAtmosphere !== undefined) viewer.scene.skyAtmosphere.show = true;
      viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(20, 15, 26_000_000) });

      const points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
      pointsRef.current = points;

      // Picking. Each PointPrimitive's `id` is set to its catalog id when created, so
      // a hit needs no lookup — the picked object already carries the answer.
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((click: { position: CesiumNamespace.Cartesian2 }) => {
        if (pickingRef.current) {
          // pickEllipsoid, not scene.pick: the user is choosing a place on Earth, and
          // scene.pick would return whichever satellite primitive happened to be under
          // the cursor. Returns undefined when the click misses the globe entirely —
          // space, off the limb — which must not be read as a coordinate of zero.
          const ground = viewer.camera.pickEllipsoid(
            click.position,
            viewer.scene.globe.ellipsoid,
          );
          if (ground !== undefined) {
            const carto = Cesium.Cartographic.fromCartesian(ground);
            onPickLocationRef.current(
              Cesium.Math.toDegrees(carto.latitude),
              Cesium.Math.toDegrees(carto.longitude),
            );
          }
          return;
        }

        const picked: unknown = viewer.scene.pick(click.position);
        if (
          picked !== undefined &&
          typeof picked === "object" &&
          picked !== null &&
          "id" in picked &&
          typeof (picked as { id: unknown }).id === "string"
        ) {
          onSelectRef.current((picked as { id: string }).id);
        } else {
          onSelectRef.current(undefined);
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      /*
       * One tab stop for the globe, not two.
       *
       * Cesium gives its canvas `tabindex="0"` and focuses it during initialisation.
       * That produced two problems at once: a second, unlabelled tab stop for the same
       * widget, and — because it happens on load — focus sitting in the middle of the
       * page before the user has pressed anything, so their first Tab moved on from
       * the globe instead of reaching the skip link.
       *
       * The container above is the accessible interface: it is labelled, it carries
       * the key handlers, and it is where focus should land. The canvas is taken out
       * of the tab order and blurred, which leaves exactly one way in.
       */
      viewer.canvas.setAttribute("tabindex", "-1");
      if (document.activeElement === viewer.canvas) viewer.canvas.blur();

      viewerRef.current = viewer;
      // Last, and only after every ref above is populated: this is what re-runs the
      // effects that draw into the viewer.
      setGlobeReady(true);
    })();

    return () => {
      disposed = true;
      const viewer = viewerRef.current;
      if (viewer !== null && !viewer.isDestroyed()) viewer.destroy();
      viewerRef.current = null;
      pointsRef.current = null;
      // Cleared as well as set, so StrictMode's double mount does not leave this true
      // while pointing at a destroyed viewer — the drawing effects would then run once
      // against nothing and never be re-triggered.
      setGlobeReady(false);
    };
  }, []);

  // Point cloud: built once when the catalog arrives, then advanced every frame.
  //
  // The worker propagates the whole catalogue at ~1 Hz, which is all that 16,000 SGP4
  // solutions per tick allows. Drawing at that rate is what made satellites visibly
  // jump and pause. So each frame this dead-reckons from the last propagated state
  // using the velocity the worker sends alongside it: position + velocity * dt. Over a
  // single tick that is straight-line motion along a very slightly curved arc, worth
  // under 20 m for the ISS against 7.66 km travelled, and it is a real physical
  // extrapolation rather than a visual smoothing of stale data.
  useEffect(() => {
    const Cesium = cesiumRef.current;
    const points = pointsRef.current;
    const viewer = viewerRef.current;
    if (Cesium === null || points === null || viewer === null) return;
    if (catalogState.status !== "ready") return;

    const alreadyBuilt = catalogIdsRef.current.length === catalogState.catalogIds.length;
    if (!alreadyBuilt) {
      points.removeAll();
      catalogIdsRef.current = catalogState.catalogIds;
      for (const catalogId of catalogState.catalogIds) {
        points.add({
          id: catalogId,
          position: Cesium.Cartesian3.ZERO,
          pixelSize: 3,
          color: Cesium.Color.fromCssColorString("#8ecbff").withAlpha(0.85),
          outlineWidth: 0,
        });
      }
    }

    const positions = catalogState.positions;
    const count = catalogState.catalogIds.length;
    const tickTime = catalogState.tickTime;

    const selectedColor = Cesium.Color.fromCssColorString("#ffcc55");
    const normalColor = Cesium.Color.fromCssColorString("#8ecbff").withAlpha(0.85);
    const hidden = Cesium.Cartesian3.fromDegrees(0, 0, NOT_RENDERABLE_ALTITUDE);

    let frame = 0;
    const scratch = new Cesium.Cartesian3();

    const render = (): void => {
      // Only extrapolate while the timeline is actually running forward in real time.
      // In SIMULATION the instant is frozen, so wall-clock elapsed time has no bearing
      // on where these objects are and advancing them would be invention.
      let dtSeconds = 0;
      if (live) {
        dtSeconds = (Date.now() - tickTime) / 1000;
        // If ticks stop arriving - a backgrounded tab, a stalled worker - freeze rather
        // than extrapolate ever further from a single propagation.
        if (dtSeconds < 0) dtSeconds = 0;
        if (dtSeconds > MAX_EXTRAPOLATION_SECONDS) dtSeconds = MAX_EXTRAPOLATION_SECONDS;
      }

      for (let index = 0; index < count; index += 1) {
        const point = points.get(index);
        const offset = index * POSITION_FIELDS;

        if (positions[offset + 6] !== 1) {
          point.position = hidden;
          continue;
        }

        // Kilometres from the propagator, metres for Cesium's fixed frame.
        scratch.x = ((positions[offset] as number) + (positions[offset + 3] as number) * dtSeconds) * 1000;
        scratch.y = ((positions[offset + 1] as number) + (positions[offset + 4] as number) * dtSeconds) * 1000;
        scratch.z = ((positions[offset + 2] as number) + (positions[offset + 5] as number) * dtSeconds) * 1000;
        point.position = scratch;

        const isSelected = catalogState.catalogIds[index] === selectedCatalogId;
        point.pixelSize = isSelected ? 8 : 3;
        point.color = isSelected ? selectedColor : normalColor;
      }

      viewer.scene.requestRender();
      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [globeReady, catalogState, selectedCatalogId, live]);

  // Ground track + footprint for the selected object.
  useEffect(() => {
    const Cesium = cesiumRef.current;
    const viewer = viewerRef.current;
    if (Cesium === null || viewer === null) return;

    for (const id of groundTrackEntityIdsRef.current) {
      const entity = viewer.entities.getById(id);
      if (entity !== undefined) viewer.entities.remove(entity);
    }
    groundTrackEntityIdsRef.current = [];

    if (telemetry.status !== "ready") {
      viewer.scene.requestRender();
      return;
    }

    telemetry.groundTrackSegments.forEach((segment, segmentIndex) => {
      if (segment.length < 2) return;
      const id = `ground-track-${segmentIndex}`;
      viewer.entities.add({
        id,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(
            segment.flatMap((point) => [point.longitude, point.latitude]),
          ),
          width: 2,
          material: Cesium.Color.fromCssColorString("#ffcc55").withAlpha(0.7),
          clampToGround: false,
        },
      });
      groundTrackEntityIdsRef.current.push(id);
    });

    if (telemetry.footprint.length >= 3) {
      const id = "footprint";
      viewer.entities.add({
        id,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray([
            ...telemetry.footprint.flatMap((point) => [point.longitude, point.latitude]),
            telemetry.footprint[0]?.longitude ?? 0,
            telemetry.footprint[0]?.latitude ?? 0,
          ]),
          width: 1,
          material: Cesium.Color.fromCssColorString("#ffcc55").withAlpha(0.35),
        },
      });
      groundTrackEntityIdsRef.current.push(id);
    }

    viewer.scene.requestRender();
  }, [globeReady, telemetry]);

  // Observer marker.
  //
  // Its own effect and its own entity id, so it survives selection changes and is not
  // swept away with the ground track. Seeing where the app thinks you are is the
  // fastest way to catch a wrong location, which otherwise only shows up as pass times
  // that are quietly hours out.
  useEffect(() => {
    const Cesium = cesiumRef.current;
    const viewer = viewerRef.current;
    if (Cesium === null || viewer === null) return;

    const existing = viewer.entities.getById(OBSERVER_ENTITY_ID);
    if (existing !== undefined) viewer.entities.remove(existing);

    if (observer !== undefined) {
      viewer.entities.add({
        id: OBSERVER_ENTITY_ID,
        position: Cesium.Cartesian3.fromDegrees(
          observer.longitude,
          observer.latitude,
          // Metres for Cesium, kilometres in the model.
          observer.altitude * 1000,
        ),
        point: {
          pixelSize: 10,
          color: Cesium.Color.fromCssColorString("#5ef2a0"),
          outlineColor: Cesium.Color.fromCssColorString("#06210f"),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: observer.label ?? "You",
          font: "12px system-ui, sans-serif",
          fillColor: Cesium.Color.fromCssColorString("#5ef2a0"),
          pixelOffset: new Cesium.Cartesian2(0, -18),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }

    viewer.scene.requestRender();
  }, [globeReady, observer]);

  return (
    <>
      <link rel="stylesheet" href={CESIUM_WIDGET_CSS_HREF} />
      <div className="globe-root">
        {/*
          role="application" is correct here and almost nowhere else.
          A WebGL canvas exposes no accessible structure — there is no tree to publish.
          What it can do is accept keys, and this role is what stops a screen reader
          intercepting them so the camera controls below actually reach the globe. The
          app uses it exactly once, for the one element where there is nothing to
          describe and something to operate.
        */}
        <div
          ref={containerRef}
          id="globe"
          className="globe-canvas"
          role="application"
          tabIndex={0}
          aria-label={
            "Interactive 3-D globe showing satellite positions. " +
            "Use the arrow keys to rotate, plus and minus to zoom, and Home to reset the view. " +
            "Satellites are three pixels wide and cannot reliably be selected here: " +
            "use the search button, or Control-K, to choose one by name."
          }
          onKeyDown={handleGlobeKeyDown}
        />

        {catalogState.status === "loading" ? (
          <div className="globe-overlay" role="status" aria-live="polite">
            <span className="globe-overlay__label">Loading catalog…</span>
          </div>
        ) : null}

        {catalogState.status === "failed" ? (
          <div className="globe-overlay globe-overlay--error" role="alert">
            <span className="globe-overlay__label">Failed to load catalog</span>
            <span className="globe-overlay__detail">{catalogState.message}</span>
          </div>
        ) : null}
      </div>
    </>
  );
}
