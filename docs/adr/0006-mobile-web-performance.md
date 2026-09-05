# ADR 0006 — How much of the catalog a phone browser draws

- Status: **Accepted.** The full catalog ships to phones.
- Date: 2026-09-05
- Milestone: M8.5

## Context

M8.5 makes the web app usable in a phone browser, which raised a question the desktop
build never had to answer: a phone is asked to draw the same 16,657 point primitives a
laptop draws, on a chip with a fraction of the thermal and memory budget.

Two changes were made on reasoning rather than measurement, and this ADR exists to
check them rather than to justify them after the fact:

1. **Per-frame style writes removed** (`satellite-globe.tsx`). The render loop used to
   write `pixelSize` and `color` for every point on every animation frame — 33,310
   property writes restating values that change only when the selection does, each one
   dirtying the collection for the next update pass. They now live in an effect keyed on
   the selection.

2. **Frame loop halved on touch hardware**, capped at ~30 Hz under `(pointer: coarse)`.
   At 30 Hz the ISS moves 255 m between drawn frames against 7.66 km per worker tick, so
   the interpolation stays far finer than the data beneath it.

CI cannot answer this. `playwright.config.ts` runs headless Chromium on SwiftShader,
where every frame is rasterised on the CPU — a frame rate from there is a property of
the CI runner. `/bench/device` exists to be opened on real hardware instead.

## Measurement

Device: **iPhone 14, iOS 26.6.1, Safari.** Served over HTTPS from the production
deployment at `orbitwatch.mohijitsingh.com`.

`/bench/device` runs eight phases — 157, 2,000, 8,000 and 16,655 objects, each with and
without the per-frame style writes — for six seconds apiece, driving the same loop shape
the app ships.

| objects | writes | median frame | p95 frame | fps |
|---|---|---|---|---|
| 16,655 | pos + style | 17 ms | 18 ms | 60 |
| all other phases | both | 17 ms | — | 60 |

## Decision

**The full catalog ships to phones.** No fallback to the `visual` group, no reduced-set
caveat on screen. At 16,655 objects the phone holds 60 fps with a 95th-percentile frame
of 18 ms — one refresh interval plus noise, meaning essentially no dropped frames — and
it does so on the *more expensive* of the two variants.

## What this evidence does not support

**The harness could not measure headroom, and the numbers look better than they are.**
An iPhone 14 is a 60 Hz panel, so 16.7 ms is the floor. Once the loop fits inside that
budget, every frame is one refresh regardless of whether the work took 2 ms or 12 ms.
157 objects and 16,655 objects both reported 17 ms — a hundredfold difference in work,
identical readings. At that point the bench was measuring the display, not the app.

Three consequences, stated rather than glossed:

- **We know the work fits in 16.7 ms. We do not know by how much.** A phone with a third
  of this one's throughput might drop frames, and nothing here would have predicted it.
- **Change 1 above is unverified.** Removing 33,310 property writes per frame is still a
  reasoned claim, not a measured result. Both variants read 17 ms because both fit,
  which says nothing about the difference between them.
- **Change 2 is also unverified**, and is in the odd position of being invisible to this
  bench by construction: the bench does not apply the 30 Hz cap.

The harness has since been given a **Loop** column reporting `medianUpdateMs` — time
inside the position-writing loop, which was always being measured and never displayed.
That number keeps falling after frame time has stopped being able to show it, and it is
what a re-run should be read from. Until that re-run happens, the two optimisations
remain reasoned rather than demonstrated, and should be described that way.

None of this changes the decision. The catalog question turned on whether the work fits,
and it fits with the expensive variant on a two-year-old phone.

## Consequences

- A phone gets the same 16,657 objects as a laptop, and the catalog badge continues to
  mean what it says. Drawing fewer objects than claimed was the outcome this ADR existed
  to avoid, and it is not needed.
- `/bench/device` stays out of CI. Headless Chromium rasterises on the CPU, so the one
  number it exists to produce would be a measurement of SwiftShader.
- Should a slower device be tested and fail, the fallback is unchanged and still
  designed: draw the `visual` group plus the selection, **and say so on screen**. The
  badge must never read "16,657 OBJECTS" while the globe draws 157.
