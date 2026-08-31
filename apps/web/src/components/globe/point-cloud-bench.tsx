"use client";

import { useEffect, useRef, useState } from "react";

import { loadCesium } from "./cesium-loader";

/**
 * Measures the MAIN-THREAD cost of pushing N satellite positions into Cesium.
 *
 * This is the number that decides the rendering strategy, because it is the work that
 * competes with React and input handling every update. It is GPU-independent, so it
 * is meaningful even in headless Chromium where rasterisation falls back to
 * SwiftShader and observed FPS would say nothing about real hardware.
 *
 * Compares the two candidate approaches at OrbitWatch's scale:
 *   - Entity API      : one Cesium Entity per satellite (the naive approach)
 *   - PointPrimitive  : one batched PointPrimitiveCollection (the intended approach)
 */

interface BenchResult {
  readonly strategy: "entity" | "point-primitive";
  readonly count: number;
  readonly createMs: number;
  readonly updateMedianMs: number;
  readonly updatesPerSecondAt60fps: number;
}

declare global {
  interface Window {
    __benchResults?: BenchResult[];
    __benchDone?: boolean;
  }
}

const COUNTS = [1_000, 5_000, 10_000, 20_000] as const;
const UPDATE_SAMPLES = 30;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

export function PointCloudBench() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("starting");

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    let disposed = false;
    let viewer: { destroy: () => void; isDestroyed: () => boolean } | undefined;

    void (async () => {
      const Cesium = await loadCesium();
      if (disposed) return;

      const instance = new Cesium.Viewer(container, {
        baseLayerPicker: false, geocoder: false, homeButton: false,
        sceneModePicker: false, navigationHelpButton: false, animation: false,
        timeline: false, fullscreenButton: false, infoBox: false,
        selectionIndicator: false,
      });
      viewer = instance;

      const results: BenchResult[] = [];

      // Pre-generate positions so the benchmark measures Cesium, not our maths.
      const makePositions = (count: number) => {
        const positions = new Array<{ lon: number; lat: number; alt: number }>(count);
        for (let i = 0; i < count; i += 1) {
          positions[i] = {
            lon: (i * 137.508) % 360 - 180,
            lat: ((i * 61.803) % 140) - 70,
            alt: 400_000 + (i % 800) * 1_000,
          };
        }
        return positions;
      };

      for (const count of COUNTS) {
        if (disposed) break;
        const positions = makePositions(count);

        // --- Strategy 1: PointPrimitiveCollection (batched) ---
        setStatus(`point-primitive ${count}`);
        const collection = instance.scene.primitives.add(
          new Cesium.PointPrimitiveCollection(),
        );
        let started = performance.now();
        const points = positions.map((p) =>
          collection.add({
            position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt),
            pixelSize: 2,
            color: Cesium.Color.CYAN,
          }),
        );
        const ppCreateMs = performance.now() - started;

        const ppSamples: number[] = [];
        for (let sample = 0; sample < UPDATE_SAMPLES; sample += 1) {
          started = performance.now();
          for (let i = 0; i < points.length; i += 1) {
            const p = positions[i] as { lon: number; lat: number; alt: number };
            // Mutating .position is the batched update path.
            (points[i] as { position: unknown }).position = Cesium.Cartesian3.fromDegrees(
              p.lon + sample * 0.01, p.lat, p.alt,
            );
          }
          ppSamples.push(performance.now() - started);
        }
        const ppUpdate = median(ppSamples);
        results.push({
          strategy: "point-primitive",
          count,
          createMs: ppCreateMs,
          updateMedianMs: ppUpdate,
          updatesPerSecondAt60fps: 16.7 / ppUpdate,
        });
        instance.scene.primitives.remove(collection);

        // --- Strategy 2: Entity API (naive) ---
        // Only up to 5k: beyond that the Entity path is already disqualified and
        // measuring it wastes minutes of benchmark time.
        if (count <= 5_000) {
          setStatus(`entity ${count}`);
          started = performance.now();
          const entities = positions.map((p) =>
            instance.entities.add({
              position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt),
              point: { pixelSize: 2, color: Cesium.Color.CYAN },
            }),
          );
          const enCreateMs = performance.now() - started;

          const enSamples: number[] = [];
          for (let sample = 0; sample < 5; sample += 1) {
            started = performance.now();
            for (let i = 0; i < entities.length; i += 1) {
              const p = positions[i] as { lon: number; lat: number; alt: number };
              (entities[i] as { position: unknown }).position =
                Cesium.Cartesian3.fromDegrees(p.lon + sample * 0.01, p.lat, p.alt);
            }
            enSamples.push(performance.now() - started);
          }
          results.push({
            strategy: "entity",
            count,
            createMs: enCreateMs,
            updateMedianMs: median(enSamples),
            updatesPerSecondAt60fps: 16.7 / median(enSamples),
          });
          instance.entities.removeAll();
        }
      }

      window.__benchResults = results;
      window.__benchDone = true;
      setStatus("done");
    })();

    return () => {
      disposed = true;
      if (viewer !== undefined && !viewer.isDestroyed()) viewer.destroy();
    };
  }, []);

  return (
    <div className="globe-root">
      <div ref={containerRef} className="globe-canvas" />
      <div className="globe-overlay__label" data-testid="bench-status">{status}</div>
    </div>
  );
}
