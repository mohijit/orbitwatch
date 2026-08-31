# ADR 0002 — WASM bulk propagation off the render thread, with interpolation

- Status: Accepted
- Date: 2026-08-31
- Milestone: M0

## Context

OrbitWatch must animate up to ~20,000 objects smoothly while remaining responsive.
Positions are computed, never fetched, so propagation cost is a first-order product
constraint.

satellite.js 7.1 offers a pure-JS `propagate` and a WASM `BulkPropagator`. We measured
both rather than assuming. All figures below are medians of 5 runs on the development
machine (Node 24.16.0, win32/x64), from real element sets in the Vallado SGP4
verification suite, replicated to reach each object count.

### Near-Earth (SGP4) — the common case

| objects | JS | WASM | speedup | WASM per object |
|---|---|---|---|---|
| 1,000 | 1.01 ms | 0.63 ms | 1.6x | 0.63 µs |
| 5,000 | 6.25 ms | 1.83 ms | 3.4x | 0.37 µs |
| 10,000 | 10.67 ms | 3.36 ms | 3.2x | 0.34 µs |
| 20,000 | 12.82 ms | 6.25 ms | 2.1x | 0.31 µs |

### Deep-space (SDP4) — GEO, GNSS, Molniya

| objects | JS | WASM | speedup |
|---|---|---|---|
| 1,000 | 274.54 ms | 0.82 ms | **334x** |
| 5,000 | 1,325.34 ms | 5.66 ms | 234x |
| 10,000 | 2,604.82 ms | 10.06 ms | 259x |
| 20,000 | **5,102.01 ms** | 23.25 ms | 219x |

The decisive finding. SGP4 switches to the deep-space SDP4 model for orbits with a
period above 225 minutes — which covers **every GEO, GNSS and Molniya object**, a large
and permanent share of the real catalog. SDP4 runs an iterative secular integrator, and
in pure JS costs roughly 1,000x a near-Earth propagation.

A 20,000-object catalog containing deep-space objects would take **over five seconds
per update** in pure JS. That is not a slow frame; it is a frozen application.

### Cost versus time from epoch

Near-Earth SGP4 is analytic: propagating 26 years past epoch costs the same as 90
minutes past (scenario B matched scenario A). SDP4 integrates forward from epoch, so
its cost grows with distance from epoch — measured at ~344 µs/object near epoch rising
to ~1,112 µs at 10 years, and not strictly monotonic in between.

## Decision

1. **Use the WASM `BulkPropagator` for whole-catalog propagation.** It is not an
   optimisation; it is the difference between a working product and a frozen one.
2. **Run it off the render thread** (a Web Worker on web; see ADR 0003 for mobile).
3. **Decouple propagation rate from frame rate.** Propagate the full catalog at a low
   rate (~1 Hz) and interpolate between batches for the 60 fps loop. At 20k objects a
   WASM batch is 6–23 ms, which is 0.6–2.3% of a 1 Hz budget but would blow a 16.7 ms
   frame.
4. **Tier by interest.** Selected satellite at high frequency, visible objects at
   medium, full background catalog at low.
5. **Always dispose the propagator.** It allocates WASM heap that is not
   garbage-collected; `BulkPropagator.dispose()` is mandatory.
6. **Bound time travel for deep-space objects.** Warn, and consider degrading, when
   propagating far from epoch — this is a real risk in the timeline feature, though the
   live view never reaches it.

## Consequences

- The catalog-wide update rate is a tunable knob backed by measurements, not a guess.
- Quality modes have a concrete lever: reduce object count and update rate.
- The engine is confined to `packages/orbit-core`, so web and native share it exactly.
- Interpolation means displayed positions between batches are interpolated, not
  propagated. At 1 Hz and LEO speeds the error is small and bounded, but the selected
  satellite is propagated at high frequency precisely so the object under scrutiny is
  never interpolated.

## Note on measurement

An earlier version of this benchmark reported ~2,300 ms for 1,000 objects and was
wrong: it mixed deep-space records propagated 26 years past epoch into what was
presented as a general figure. Separating the regimes was what made the numbers
meaningful and surfaced the SDP4 finding.
