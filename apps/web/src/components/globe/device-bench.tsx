"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { loadCesium, type CesiumModule } from "./cesium-loader";

/**
 * What a real phone can actually draw — measured on the phone, read on the phone.
 *
 * WHY THE M0 BENCH IS NOT ENOUGH
 * `point-cloud-bench.tsx` measures main-thread cost only, and says so: it is driven by
 * Playwright in headless Chromium where rasterisation falls back to SwiftShader, so
 * observed frame rate there is a property of the CPU renderer and not of any real
 * device. That was the right call for choosing BETWEEN strategies, because the
 * comparison holds whatever the GPU is. It is the wrong instrument for the question
 * here, which is absolute rather than relative: can a phone hold a usable frame rate
 * while drawing the whole catalog? Only a phone can answer that.
 *
 * WHAT IT MEASURES
 * The same shape as the shipped render loop in `satellite-globe.tsx`: dead-reckon N
 * positions from a velocity, write them into a PointPrimitiveCollection, request a
 * render, repeat on an animation frame. Two variants, because one of them is a claim
 * this milestone makes and should therefore have to prove itself:
 *
 *   positions        what ships now — only `position` is written each frame
 *   positions+style  what shipped before — `pixelSize` and `color` restated per point
 *                    per frame, though they change only when the selection does
 *
 * Frame TIME is reported rather than a smoothed FPS. A mean frame rate hides exactly
 * the thing that makes a globe feel broken: it is the 95th percentile frame, the one
 * that arrives late, that reads as a stutter.
 *
 * NOT A PRODUCT SURFACE. Nothing here is reachable from the app, and no result it
 * produces is shown to a user as a fact about their device.
 */

interface Phase {
  readonly count: number;
  readonly style: boolean;
}

export interface DeviceBenchResult {
  readonly count: number;
  /** Whether per-frame `pixelSize`/`color` writes were included. */
  readonly style: boolean;
  readonly frames: number;
  readonly medianFrameMs: number;
  readonly p95FrameMs: number;
  readonly meanFps: number;
  /** Time inside the position-writing loop alone, median across frames. */
  readonly medianUpdateMs: number;
}

declare global {
  interface Window {
    __deviceBench?: DeviceBenchResult[];
    __deviceBenchDone?: boolean;
  }
}

/**
 * Catalog sizes worth knowing about.
 *
 * 157 is CelesTrak's `visual` group — the documented fallback if the full catalog does
 * not hold up. 16,655 is the live catalog as ingested. The two in between exist so a
 * failure has a shape rather than just a verdict.
 */
const COUNTS = [157, 2_000, 8_000, 16_655] as const;

/** Long enough to get past the first-frame costs and into steady state. */
const SECONDS_PER_PHASE = 6;

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] ?? 0;
}

export function DeviceBench() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("Tap Run to measure this device.");
  const [results, setResults] = useState<DeviceBenchResult[]>([]);
  const [running, setRunning] = useState(false);
  const runRef = useRef(false);

  const run = useCallback(() => {
    const container = containerRef.current;
    if (container === null || runRef.current) return;
    runRef.current = true;
    setRunning(true);
    setResults([]);

    void (async () => {
      const Cesium = await loadCesium();
      const viewer = new Cesium.Viewer(container, {
        baseLayerPicker: false, geocoder: false, homeButton: false,
        sceneModePicker: false, navigationHelpButton: false, animation: false,
        timeline: false, fullscreenButton: false, infoBox: false,
        selectionIndicator: false,
        // Matches the app: the scene is redrawn because something moved, not sixty
        // times a second regardless. Measuring without it would measure a different app.
        requestRenderMode: true,
        maximumRenderTimeChange: Infinity,
      });
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(20, 15, 26_000_000),
      });

      const collected: DeviceBenchResult[] = [];
      const phases: Phase[] = COUNTS.flatMap((count) => [
        { count, style: false },
        { count, style: true },
      ]);

      for (const phase of phases) {
        setStatus(
          `${phase.count.toLocaleString()} objects, ` +
            `${phase.style ? "positions + per-frame style" : "positions only"}…`,
        );
        // Yields to the browser so the status above actually paints before the phase
        // saturates the main thread.
        await new Promise((resolve) => setTimeout(resolve, 120));

        const result = await measure(Cesium, viewer, phase);
        collected.push(result);
        setResults([...collected]);
      }

      window.__deviceBench = collected;
      window.__deviceBenchDone = true;
      setStatus("Done. These numbers describe THIS device, on this run.");
      viewer.destroy();
      runRef.current = false;
      setRunning(false);
    })();
  }, []);

  useEffect(() => {
    return () => {
      runRef.current = false;
    };
  }, []);

  return (
    <div className="device-bench">
      <div ref={containerRef} className="device-bench__globe" />

      <div className="device-bench__panel">
        <h1 className="device-bench__title">Device render benchmark</h1>
        <p className="device-bench__status" data-testid="device-bench-status">
          {status}
        </p>
        <button
          type="button"
          className="device-bench__run"
          onClick={run}
          disabled={running}
          data-testid="device-bench-run"
        >
          {running ? "Measuring…" : "Run"}
        </button>

        {results.length === 0 ? null : (
          <table className="device-bench__table">
            <thead>
              <tr>
                <th scope="col">Objects</th>
                <th scope="col">Writes</th>
                <th scope="col">Median</th>
                <th scope="col">95th</th>
                <th scope="col">FPS</th>
                {/*
                  The column that actually separates the two variants.

                  Frame time saturates at the refresh rate: once the loop fits inside
                  the budget, every frame is 16.7ms whether the work took 2ms or 12ms,
                  and both variants report 60fps. This is the work itself, measured
                  inside the loop, and it keeps going down after frame time has stopped
                  being able to show it.
                */}
                <th scope="col">Loop</th>
              </tr>
            </thead>
            <tbody>
              {results.map((result) => (
                <tr key={`${String(result.count)}-${String(result.style)}`}>
                  <td>{result.count.toLocaleString()}</td>
                  <td>{result.style ? "pos + style" : "pos"}</td>
                  <td>{result.medianFrameMs.toFixed(1)} ms</td>
                  <td>{result.p95FrameMs.toFixed(1)} ms</td>
                  <td>{result.meanFps.toFixed(0)}</td>
                  <td>{result.medianUpdateMs.toFixed(2)} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="device-bench__note">
          Frame time, not smoothed frame rate: a mean hides the late frame that is what a
          stutter actually is. &ldquo;pos + style&rdquo; restates every point&rsquo;s size
          and colour each frame, which is what the app did before this milestone.
          <br />
          <strong>Loop</strong> is the work itself, timed inside the frame. Read that
          column to compare the two variants: once the loop fits inside the refresh
          budget, frame time pins to the display and reports 60&nbsp;fps either way, so
          it can no longer tell them apart.
        </p>
      </div>
    </div>
  );
}

/** One phase: build the collection, drive it for a few seconds, tear it down. */
async function measure(
  Cesium: CesiumModule,
  viewer: InstanceType<CesiumModule["Viewer"]>,
  phase: Phase,
): Promise<DeviceBenchResult> {
  const collection = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
  const normalColor = Cesium.Color.fromCssColorString("#8ecbff").withAlpha(0.85);
  const selectedColor = Cesium.Color.fromCssColorString("#ffcc55");

  /*
   * Synthetic positions and velocities, spread over the shells the real catalog
   * occupies. Not real elements: this measures the cost of MOVING N points, which does
   * not depend on where they came from, and propagating a real catalog here would
   * measure SGP4 instead of the renderer.
   */
  const state = new Float32Array(phase.count * 6);
  for (let index = 0; index < phase.count; index += 1) {
    const offset = index * 6;
    const radius = 6_778_000 + (index % 900) * 1_000;
    const longitude = ((index * 137.508) % 360) - 180;
    const latitude = ((index * 61.803) % 140) - 70;
    const position = Cesium.Cartesian3.fromDegrees(longitude, latitude, radius - 6_378_137);
    state[offset] = position.x;
    state[offset + 1] = position.y;
    state[offset + 2] = position.z;
    // ~7.5 km/s, in metres per second, in an arbitrary but non-degenerate direction.
    state[offset + 3] = -position.y / 1000;
    state[offset + 4] = position.x / 1000;
    state[offset + 5] = 0;
    collection.add({
      id: String(index),
      position,
      pixelSize: 3,
      color: normalColor,
      outlineWidth: 0,
    });
  }

  const frameTimes: number[] = [];
  const updateTimes: number[] = [];
  const scratch = new Cesium.Cartesian3();
  // One arbitrary object is "selected", so the styled variant does the same branch per
  // point that the old render loop did.
  const selectedIndex = Math.floor(phase.count / 2);

  await new Promise<void>((resolve) => {
    const startedAt = performance.now();
    let previous = startedAt;
    let frame = 0;

    const step = (now: number): void => {
      frameTimes.push(now - previous);
      previous = now;

      const updateStarted = performance.now();
      const dt = (now - startedAt) / 1000;
      for (let index = 0; index < phase.count; index += 1) {
        const point = collection.get(index);
        const offset = index * 6;
        scratch.x = (state[offset] as number) + (state[offset + 3] as number) * dt;
        scratch.y = (state[offset + 1] as number) + (state[offset + 4] as number) * dt;
        scratch.z = (state[offset + 2] as number) + (state[offset + 5] as number) * dt;
        point.position = scratch;

        if (phase.style) {
          const isSelected = index === selectedIndex;
          point.pixelSize = isSelected ? 8 : 3;
          point.color = isSelected ? selectedColor : normalColor;
        }
      }
      updateTimes.push(performance.now() - updateStarted);

      viewer.scene.requestRender();

      if (now - startedAt >= SECONDS_PER_PHASE * 1000) {
        cancelAnimationFrame(frame);
        resolve();
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  });

  viewer.scene.primitives.remove(collection);

  // The first frame includes the collection's initial upload to the GPU, which is a
  // one-off cost and not what "can this device sustain the catalog" is asking.
  const sortedFrames = frameTimes.slice(1).sort((a, b) => a - b);
  const sortedUpdates = updateTimes.slice(1).sort((a, b) => a - b);
  const totalMs = sortedFrames.reduce((sum, value) => sum + value, 0);

  return {
    count: phase.count,
    style: phase.style,
    frames: sortedFrames.length,
    medianFrameMs: percentile(sortedFrames, 0.5),
    p95FrameMs: percentile(sortedFrames, 0.95),
    meanFps: totalMs > 0 ? (sortedFrames.length / totalMs) * 1000 : 0,
    medianUpdateMs: percentile(sortedUpdates, 0.5),
  };
}
