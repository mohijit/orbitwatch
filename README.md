# OrbitWatch

Real-time satellite tracking for web, PWA, iOS and Android.

> **Current satellite positions are calculated from recently published orbital elements
> using SGP4/SDP4. They are not continuous onboard GPS telemetry, and must not be used
> for safety-critical navigation or conjunction assessment.**

---

## Status

Under active development, built milestone by milestone. **M0 and M1 are complete; M2 is
partially complete.** Nothing here is production-deployed.

| Milestone | Scope | Status |
|---|---|---|
| M0 | Architecture validation, renderer proofs of concept, benchmarks | ✅ Complete |
| M1 | Shared orbital core | ✅ Complete |
| M2 | Backend: storage, cache, ingestion, API | 🟡 In progress |
| M3–M10 | Web MVP, observer tools, native apps, data richness, production | ⬜ Not started |

**Verification:** typecheck (13 packages) · lint (13) · **296 unit tests** · build (7) ·
4 Playwright browser tests — all passing.

---

## What "live" means here

For almost all satellites there is no continuous telemetry downlink. OrbitWatch:

1. periodically obtains fresh General Perturbations orbital elements (CCSDS OMM),
2. records the element **epoch** and the **retrieval time** separately,
3. propagates to the requested instant with SGP4/SDP4,
4. animates the calculated position.

The UI distinguishes three different facts that are routinely conflated:

```
LIVE · PROPAGATED
Position       21:42:16 UTC     ← the instant being displayed
Element epoch  1h 14m ago       ← when the elements describe the orbit
Retrieved      21 min ago       ← when we fetched them
Source         CelesTrak
```

Propagation far from the element epoch is classified and labelled — `NOMINAL`,
`DEGRADED`, `EXTRAPOLATED` or `UNRELIABLE` — and beyond a defensible limit the app
**refuses to render a position** rather than showing a confident wrong one. Historical
replay uses the element set that was current at the replayed moment, drawn from stored
history, never today's elements propagated backwards across an unmodelled manoeuvre.

---

## Architecture

```
apps/
  web       Next.js 16 + CesiumJS globe
  mobile    Expo / React Native, Cesium in a WebView (ADR 0003)
  worker    Scheduled provider ingestion
  api       Fastify service                              (M2, in progress)
packages/
  orbit-core   SGP4/SDP4, coordinates, passes, illumination — framework-free
  providers    Guarded HTTP access + provider schemas
  contracts    Shared typed contracts, incl. the WebView bridge protocol
  database     Schema, migrations, repositories
  cache        Layered L1 + optional shared L2
```

`packages/orbit-core` has no React, DOM, Cesium or React Native dependency — enforced by
a lint rule with a test proving it fires. Web, native, worker and server all run the same
propagator, which is what makes cross-platform agreement testable rather than hoped for.

Decisions with measurements behind them are in [`docs/adr/`](docs/adr/).

---

## Accuracy and correctness

`orbit-core` is validated against the **full Vallado SGP4 verification suite**
(AIAA 2006-6753) — 33 published cases covering near-Earth, deep-space, Lyddane-fix,
resonance and decay paths — at the official tolerance of 1e-4 km position and
1e-6 km/s velocity per component. The expected values come from Vallado's public-domain
reference data, so the test cannot pass by agreeing with itself.

### Known limitations

- SGP4 accuracy decays away from the element epoch, fastest in LEO where atmospheric
  drag dominates. This is surfaced, not hidden.
- Manoeuvres are not modelled by SGP4 at all.
- Deep-space (SDP4) propagation cost grows with distance from epoch.
- Visibility predictions are categorical, never a numeric magnitude: public catalogs
  carry no per-object brightness model, so quoting one would invent precision.

---

## Data sources

| Provider | Use | Verified against live responses |
|---|---|---|
| NOAA SWPC | Space weather (Kp, solar wind, R/S/G scales) | ✅ Yes |
| Launch Library 2 | Launches (list + detailed) | ✅ Yes |
| WhereTheISS.at | Independent ISS cross-check only | ✅ Yes |
| **CelesTrak** | **Primary orbital elements + catalog** | ❌ **No — network-blocked** |
| **SatNOGS DB** | **Transmitters** | ❌ **No — network-blocked** |

A provider counts as verified only after real production calls, captured fixtures,
schemas validated against those responses, and parsing tests built from them.

CelesTrak and SatNOGS are unreachable from the current development network — CelesTrak's
TCP connect never completes, SatNOGS completes TLS then returns no bytes. Their schemas
are written from documentation and **explicitly marked UNVERIFIED** in the source, the
ADRs and [`fixtures/manifest.json`](fixtures/manifest.json). **No fixture has been
fabricated**, and no substitute primary provider has been introduced.

Fixture provenance — endpoint, retrieval timestamp, purpose and known quirks — is
recorded in `fixtures/manifest.json`.

---

## Provider rate policy

CelesTrak tightened its terms in March 2026: GP data updates roughly every two hours and
consumers may download **once per update cycle**. A second request returns HTTP 403, and
repeated violations result in IP-level firewall blocking.

Every outbound provider request therefore goes through a guard that:

- persists to disk, so a dev-server restart loop cannot issue repeat requests,
- checks and reserves atomically, closing the race where two workers both proceed,
- leases reservations, so a process killed mid-request costs minutes rather than a whole
  data cycle,
- applies escalating backoff on 403/429 and then **stops**, per CelesTrak's guidance that
  machine clients halt and alert a human rather than retry,
- fails closed if its own state is unreadable.

Browsers and mobile clients never contact a provider directly.

---

## Getting started

Requires Node 22+ and pnpm.

```bash
pnpm install
cp .env.example .env.local     # then fill in values; .env.local is gitignored
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Run the web app:

```bash
pnpm --filter @orbitwatch/web dev      # http://localhost:3000
```

Cesium's static assets are copied into `public/cesium` automatically before `dev` and
`build`. No Cesium Ion token is needed — the globe uses the offline Natural Earth imagery
bundled with Cesium.

### Benchmarks

```bash
pnpm --filter @orbitwatch/orbit-core bench   # SGP4/SDP4 throughput
pnpm --filter @orbitwatch/contracts bench    # WebView bridge payload cost
pnpm --filter @orbitwatch/web exec playwright test
```

### Provider verification

```bash
pnpm verify:providers            # all providers, one guarded request each
pnpm verify:providers celestrak  # a single provider
```

Rate-guarded. If a provider was fetched recently the run reports `SKIPPED` rather than
issuing a request.

---

## Environment variables

See [`.env.example`](.env.example), which documents every variable and where it belongs.

Variables prefixed `NEXT_PUBLIC_` or `EXPO_PUBLIC_` are embedded in client bundles and
are readable by anyone. **Never put a secret in one.** Everything else is server-only.
`DATABASE_URL` should be Supabase's pooled connection string; `DATABASE_DIRECT_URL` the
direct one, because migrations issue DDL that the transaction pooler does not support.

---

## Attribution

- Orbital data courtesy of [CelesTrak](https://celestrak.org)
- Transmitter data from [SatNOGS DB](https://db.satnogs.org), licensed CC BY-SA 4.0
- Launch data from [Launch Library 2](https://thespacedevs.com) by The Space Devs
- Space weather from [NOAA SWPC](https://www.swpc.noaa.gov)
- 3D globe by [CesiumJS](https://cesium.com/platform/cesiumjs/)
- SGP4/SDP4 via [satellite.js](https://github.com/shashwatak/satellite-js)
- SGP4 verification data from Vallado, *Revisiting Spacetrack Report #3* (AIAA 2006-6753)

Cesium and imagery attribution are a licence requirement and are never removed from the
rendered globe.

This project contains no code from AGPL-licensed satellite trackers.
