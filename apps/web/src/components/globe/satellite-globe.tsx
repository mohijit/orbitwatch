"use client";

import { useEffect, useRef } from "react";

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

export interface SatelliteGlobeProps {
  readonly catalogState: CatalogTickState;
  readonly selectedCatalogId: string | undefined;
  readonly onSelect: (catalogId: string | undefined) => void;
  readonly telemetry: SelectedTelemetryState;
}

type CesiumViewer = InstanceType<CesiumModule["Viewer"]>;
type CesiumPoints = InstanceType<CesiumModule["PointPrimitiveCollection"]>;

export function SatelliteGlobe({
  catalogState,
  selectedCatalogId,
  onSelect,
  telemetry,
}: SatelliteGlobeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<CesiumViewer | null>(null);
  const pointsRef = useRef<CesiumPoints | null>(null);
  const catalogIdsRef = useRef<readonly string[]>([]);
  const groundTrackEntityIdsRef = useRef<string[]>([]);
  const cesiumRef = useRef<CesiumModule | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

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

      viewerRef.current = viewer;
    })();

    return () => {
      disposed = true;
      const viewer = viewerRef.current;
      if (viewer !== null && !viewer.isDestroyed()) viewer.destroy();
      viewerRef.current = null;
      pointsRef.current = null;
    };
  }, []);

  // Point cloud: (re)built once when the catalog becomes ready, then mutated in place.
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
    for (let index = 0; index < count; index += 1) {
      const point = points.get(index);
      const offset = index * POSITION_FIELDS;
      const ok = positions[offset + 3] === 1;
      const catalogId = catalogState.catalogIds[index];

      if (!ok) {
        point.position = Cesium.Cartesian3.fromDegrees(0, 0, NOT_RENDERABLE_ALTITUDE);
        continue;
      }

      const longitude = positions[offset] as number;
      const latitude = positions[offset + 1] as number;
      const altitudeKm = positions[offset + 2] as number;
      point.position = Cesium.Cartesian3.fromDegrees(longitude, latitude, altitudeKm * 1000);

      const isSelected = catalogId === selectedCatalogId;
      point.pixelSize = isSelected ? 8 : 3;
      point.color = isSelected
        ? Cesium.Color.fromCssColorString("#ffcc55")
        : Cesium.Color.fromCssColorString("#8ecbff").withAlpha(0.85);
    }

    viewer.scene.requestRender();
  }, [catalogState, selectedCatalogId]);

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
  }, [telemetry]);

  return (
    <>
      <link rel="stylesheet" href={CESIUM_WIDGET_CSS_HREF} />
      <div className="globe-root">
        <div ref={containerRef} className="globe-canvas" />

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
