# OrbitWatch

Real-time satellite tracking for web, PWA, iOS and Android.

> **Current satellite positions are calculated from recently published orbital elements
> using SGP4/SDP4. They are not continuous onboard GPS telemetry, and must not be used
> for safety-critical navigation or conjunction assessment.**

---

## Status

Under active development, built milestone by milestone. The web app is deployed at
**[orbitwatch.mohijitsingh.com](https://orbitwatch.mohijitsingh.com)**, the API runs on
Fly.io, and ingestion runs on a schedule against the hosted database. The native app
installs and runs on Android.

| Milestone | Scope | Status |
|---|---|---|
| M0 | Architecture validation, renderer proofs of concept, benchmarks | ✅ Complete |
| M1 | Shared orbital core | ✅ Complete |
| M2 | Backend: storage, cache, ingestion, API | ✅ Complete |
| M3 | Web MVP: globe, catalog, search, telemetry, timeline | ✅ Complete |
| M4 | Observer system: location, look angles, passes, visibility | ✅ Complete |
| M5 | Native mobile MVP | 🟡 Android build installs and runs. The Cesium runtime is not yet bundled into the app, so the globe tab says so rather than rendering. iOS needs a paid account. |
| M6 | Mobile differentiators | 🟡 Notifications, deep links and sharing done, and the **cross-platform agreement gate is met on a device**. Widgets, Live Activity and haptics are not built. |
| M7 | Data richness: SatNOGS, Launch Library, space weather | 🟡 SOCRATES conjunctions deliberately deferred |
| M8 | PWA: manifest, service worker, offline shell | ✅ Complete |
| M8.5 | The web app in a phone browser | ✅ Complete, measured on a device |
| M9 | AR sky finder, advanced alerts, optional sync | 🟡 Sky finder verified on hardware; watchlist sync storage live |
| M10 | Production: accessibility audit, monitoring, store submission | ⬜ Not started |

What has been confirmed on physical hardware — and, as importantly, what has not — is
recorded in [`docs/device-verification.md`](docs/device-verification.md).

**Verification:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build` across the
workspace — **700 unit tests** and **68 Playwright browser tests**, all passing. Of those
unit tests, **93 are storage-contract tests** exercised against the in-memory
implementation; the same 93 run against **real PostgreSQL** when a throwaway database is
configured (see below), so the two implementations are held to one contract rather than
to two suites that can drift apart.

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
  api       Fastify service: catalog, elements, health, provider status
packages/
  orbit-core   SGP4/SDP4, coordinates, passes, illumination — framework-free
  providers    Guarded HTTP access, provider schemas, verification registry
  contracts    Shared typed contracts: HTTP API + the WebView bridge protocol
  database     Schema, migrations, repositories (Postgres + in-memory)
  cache        Layered L1 + optional shared L2
```

### Two implementations, one contract

`packages/database` ships **two** complete implementations of its repository interfaces:
Postgres and in-memory. Both are run against the same executable specification in
`database-contract.ts`, so the in-memory one is a genuine second implementation rather
than a mock that happens to satisfy the type signature. Business logic is tested at
speed against it with no credentials, and the SQL only has to prove it agrees.

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
| CelesTrak | Primary orbital elements + catalog | ✅ Yes — verified from CI |
| SatNOGS DB | Transmitters | ✅ Yes — verified from CI |

A provider counts as verified only after real production calls, captured fixtures,
schemas validated against those responses, and parsing tests built from them.

Both were unreachable from the local development network (CelesTrak: TCP connect never
completes; SatNOGS: TLS completes, then zero bytes) — solved by verifying from a GitHub
Actions runner instead, which has ordinary internet access. See
[`.github/workflows/verify-providers.yml`](.github/workflows/verify-providers.yml).

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

### Database

```bash
pnpm --filter @orbitwatch/database exec tsx src/cli/check-connection.ts   # diagnose
pnpm --filter @orbitwatch/database migrate                               # apply schema
```

Migrations are checksum-verified: editing an already-applied migration fails loudly
rather than leaving environments with a schema that no longer matches its source. Each
runs in its own transaction, and an advisory lock serialises concurrent deploys.

### Running the storage contract against real Postgres

The Postgres suite **truncates every table**, so it refuses `DATABASE_URL` and requires
a separate variable pointing at a database that exists to be destroyed:

```bash
ORBITWATCH_TEST_DATABASE_URL=postgresql://... pnpm --filter @orbitwatch/database test
```

Without it the suite skips. `pnpm test` must never be able to destroy working data
because the ambient environment happened to be configured.

### API

```bash
pnpm --filter @orbitwatch/api dev       # http://localhost:3333
```

| Route | Purpose |
|---|---|
| `GET /health` | Dependency status. Always 200 — the body carries the truth |
| `GET /health/ready` | Readiness; 503 only when the database is unreachable |
| `GET /satellites` | Search and filter the catalog |
| `GET /satellites/:id` | One catalog record |
| `GET /satellites/:id/elements` | Elements for an instant, with accuracy assessment |
| `GET /satellites/:id/elements/history` | Stored element history |
| `GET /catalog/elements` | Current elements for the whole catalog |
| `GET /providers/status` | Ingestion freshness per provider |
| `GET /providers/verification` | Which provider schemas have met real data |

The API serves **elements, not positions**. Clients propagate locally with the same
`orbit-core` the server uses, which is what makes smooth animation possible without the
server computing positions at frame rate — and what makes web and native agree.

With no `DATABASE_URL` set the API starts against the in-memory database and says so
loudly at boot, so an unexpected ephemeral deployment is noticed immediately.

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

**On an IPv4-only network, use the Session pooler string for both.** Supabase's direct
connection hosts (`db.<ref>.supabase.co`) publish an AAAA record only, so they fail with
`ENOTFOUND` — which looks like a wrong hostname but is an address-family mismatch. The
Session pooler is IPv4 and supports DDL, so migrations work over it.

```bash
pnpm --filter @orbitwatch/database exec tsx src/cli/check-connection.ts
```

reports host, port and DDL support for each configured URL, printing no credentials.

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
