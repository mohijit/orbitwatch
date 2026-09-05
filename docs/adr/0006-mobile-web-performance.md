# ADR 0006 — How much of the catalog a phone browser draws

- Status: **Proposed — awaiting the device measurement.** Nothing has been changed on
  the basis of this document yet; the app still ships the full catalog to every client.
- Date: 2026-09-03
- Milestone: M8.5

## Context

M8.5 makes the web app usable in a phone browser. That raised a question the desktop
build never had to answer: a phone is asked to draw the same 16,655 point primitives a
laptop draws, on a chip with a fraction of the thermal and memory budget, over a
connection that may be metered.

The honest position is that **we do not know yet**, and this project does not ship
capacity claims it has not tested. Two changes were made on reasoning rather than
measurement, and both are recorded here as claims to be checked rather than results:

1. **Per-frame style writes removed** (`satellite-globe.tsx`). The render loop used to
   write `pixelSize` and `color` for every point on every animation frame — 33,310
   property writes restating values that change only when the selection does, each one
   dirtying the collection for the next update pass. They now live in an effect keyed on
   the selection. The claim is that this is a large fraction of per-frame cost at
   catalog scale. It has not been measured on a phone.

2. **Frame loop halved on touch hardware.** Dead reckoning between 1 Hz worker ticks is
   capped at ~30 Hz under `(pointer: coarse)`. At 30 Hz the ISS moves 255 m between
   drawn frames against 7.66 km per worker tick, so the interpolation is still far
   finer than the data beneath it. The claim is that this is invisible and halves the
   main-thread cost. Only the first half is arguable from arithmetic.

### Why CI cannot answer this

`playwright.config.ts` runs headless Chromium with `--use-angle=swiftshader`: every
frame is rasterised on the CPU, measured at roughly 4–15 fps once the catalog is drawn.
A frame rate from that environment is a property of SwiftShader and of the CI runner,
not of any phone. The `mobile-chromium` project verifies that the layout fits and that a
tap selects the right object — both of which are geometry, and both of which emulation
can answer honestly. Frame rate and thermals are not among them.

This mirrors ADR 0003, which measured bridge cost — the part that is
hardware-independent — and left the device FPS/thermal gate explicitly outstanding
rather than inferring it.

## The measurement

`/bench/device` (`src/components/globe/device-bench.tsx`) drives the same loop shape the
app ships: dead-reckon N positions from a velocity, write them into a
`PointPrimitiveCollection`, `requestRender`, repeat on an animation frame. It runs eight
phases — 157, 2,000, 8,000 and 16,655 objects, each with and without the per-frame style
writes — for six seconds apiece, and reports median and 95th-percentile **frame time**
rather than a smoothed frame rate. A mean hides the late frame, and the late frame is
what a stutter actually is.

157 is not an arbitrary small number: it is CelesTrak's `visual` group, which is the
documented fallback below.

### Procedure

```bash
pnpm build
pnpm --filter @orbitwatch/web exec next start --port 3100 --hostname 0.0.0.0
# then, on the phone, on the same network:
#   http://<machine-ip>:3100/bench/device   → tap Run
#   http://<machine-ip>:3100/               → the app itself
```

Record, from the phone:

| Reading | Where from |
|---|---|
| Median and p95 frame time, 16,655 objects, positions only | `/bench/device` |
| The same, with per-frame style writes | `/bench/device` — the value of change 1 |
| Frame time at 157 / 2,000 / 8,000 | `/bench/device` — gives a failure a shape |
| Cold load over cellular, not Wi-Fi | the app, first visit, ~14 MB of Cesium |
| Sustained behaviour over ~10 minutes | the app — does it throttle, does the phone get hot |
| Whether a satellite can be tapped | the app — the fix `mobile-layout.spec.ts` asserts |

### Results

**Not yet taken.** This table is deliberately empty rather than estimated.

| objects | writes | median frame | p95 frame | fps |
|---|---|---|---|---|
| | | | | |

Device, OS and browser version to be recorded alongside, because a single phone is a
sample of one and the numbers are worth nothing without knowing which one.

## Decision

Deferred until the table above is filled in. The two candidate outcomes, decided in
advance so the result is read rather than rationalised:

**If the full catalog holds up** — p95 frame time comfortably inside the budget and no
thermal throttling over ten minutes — nothing changes. A phone draws what a laptop
draws, and this ADR records that it was checked.

**If it does not**, the phone draws a reduced set: the `visual` group plus whatever is
selected, and **the interface says so on screen**. The catalog badge must never read
"16,655 OBJECTS" while the globe is drawing 157. Quietly drawing fewer objects than
claimed is precisely the class of dishonesty this product exists to avoid, and a
performance problem is not a licence for it.

There is no third option where the app draws fewer objects and stays quiet about it.

## Consequences

- Until this is measured, the app ships the full catalog to phones. That is a known
  unverified position, stated here rather than assumed away.
- `/bench/device` is not linked from the app and is not run in CI, for the reason above.
  It is a harness, not a feature, and its output is never shown to a user as a fact
  about their device.
- If the fallback is taken, it needs its own on-screen wording and its own test. That
  work is not in M8.5.
