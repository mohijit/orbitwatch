# ADR 0003 — Mobile 3D globe: bundled CesiumJS in a WebView, native UI around it

- Status: Accepted, with one gate outstanding
- Date: 2026-08-31
- Milestone: M0

## Context

The native apps must show orbital objects at their real altitudes above Earth. The
product brief is explicit that altitude must not be flattened onto the surface.

Three architectures were considered.

**A. Native map/globe library.** `react-native-maps` renders a flat map and has no
globe mode. Its camera accepts an altitude, but that positions the *camera*, not scene
objects; there is no way to place a marker 400 km above the surface. Choosing it would
mean drawing satellites at their sub-satellite point — exactly the flattening the brief
forbids.

**B. Bundled CesiumJS in a WebView, native UI outside it.** CesiumJS is a browser
library with no React Native binding. A WebView runs it unmodified.

**C. Custom Three.js / expo-gl globe.** Full native GL, but we would be reimplementing
WGS84 geodesy, imagery tiling, atmosphere, lighting and camera control — the parts of
Cesium that are hardest to get right and most valuable here.

### Measurements

The binding constraint for B is bridge cost, since native and WebView communicate over
a serialised string channel. Measured with the real implementation
(`packages/contracts/bench/bridge.bench.ts`):

| objects | packed (base64 Float32) | naive JSON of objects | ratio | pack | unpack |
|---|---|---|---|---|---|
| 1,000 | 16 KB | 61 KB | 3.9x | 0.02 ms | 0.06 ms |
| 5,000 | 78 KB | 305 KB | 3.9x | 0.20 ms | 0.48 ms |
| 10,000 | 156 KB | 611 KB | 3.9x | 0.35 ms | 0.75 ms |
| 20,000 | **313 KB** | 1,223 KB | 3.9x | 0.59 ms | 1.48 ms |

A full 20k catalog costs ~313 KB and ~2 ms of encode/decode per update. At the ~1 Hz
whole-catalog rate from ADR 0002 that is entirely affordable. The naive
one-message-per-object or JSON-of-objects encoding would be several megabytes and is
not viable, so the packed encoding is load-bearing rather than a micro-optimisation.

Rendering cost was measured on the same Cesium engine the WebView will run
(`apps/web/e2e/renderer-bench.spec.ts`), main-thread cost only:

| strategy | objects | create | update |
|---|---|---|---|
| PointPrimitiveCollection | 20,000 | 10.9 ms | 6.65 ms |
| PointPrimitiveCollection | 5,000 | 4.0 ms | 1.50 ms |
| Entity API | 5,000 | 117.2 ms | 24.00 ms |

At 5,000 objects batched point primitives are **16x cheaper to update and 29x cheaper
to create** than the Entity API, which already exceeds a 16.7 ms frame budget at that
size. This settles the rendering strategy for web and mobile alike.

## Decision

**Architecture B.** A dedicated, locally bundled Cesium scene inside a WebView renders
the 3D globe. Everything else — navigation, search, settings, watchlist, passes,
notifications, observing and compass modes — is native React Native.

Specifically:

- The WebView loads a **purpose-built local scene**, never the public website.
- All communication uses the typed, Zod-validated protocol in
  `packages/contracts/src/globe-bridge.ts`. Unknown messages are reported, never
  silently ignored: a silently-ignored renamed message is close to undebuggable on
  someone else's phone.
- Positions cross as a **single message** carrying a base64 Float32Array of
  `[lon, lat, altKm]` triples, index-aligned with a catalog-id array.
- Propagation runs in native JS via the shared `orbit-core`, not inside the WebView, so
  web and native produce identical numbers (asserted by the M6 agreement tests).
- The scene reports `globe-error` with `context-lost` so native can recover: mobile GPUs
  reclaim WebGL contexts under memory pressure, and a frozen globe is a bug report.
- Rendering is suspended when the app backgrounds (`set-rendering`).
- 2D map and Sky View modes are native, so the WebView is needed only for 3D.

## Outstanding gate

**On-device FPS and thermal behaviour have NOT been measured.** They cannot be from
this environment: a Windows machine with no attached device, and iOS builds require
macOS or EAS. The decision above rests on bridge cost, rendering cost and architectural
fit — all measured — but the device-level acceptance criteria from the brief (1,000+
objects, smooth animation, acceptable thermals) remain unverified.

This gate is scheduled for **M5**, when EAS produces installable builds. If the WebView
fails it, the fallback is Architecture C for the 3D mode only; the bridge protocol,
propagation engine and all native UI are unaffected by that switch, which is a
deliberate property of this design.

Until that gate passes, no claim is made that the mobile 3D globe performs adequately
on real hardware.

## Consequences

- Cesium geodesy, imagery, atmosphere and camera come for free and behave identically
  to web.
- One renderer to maintain across platforms.
- A WebView boundary exists and must be treated as a real interface: versioned,
  validated, and defensive on both sides.
- Bundle size grows by the Cesium assets shipped with the app.
- The WebView is a native-module dependency, so Expo Go is insufficient and development
  builds are required — which the brief already anticipates.
