# ADR 0005 — Server-side provider access behind a persistent, leased fetch guard

- Status: Accepted
- Date: 2026-08-31
- Milestone: M0/M2

## Context

OrbitWatch depends on third-party data whose terms are strict and, in one case,
enforced by IP blocking.

- **CelesTrak** tightened its usage policy in March 2026: GP data updates roughly every
  two hours and consumers may download once per update cycle. A second request in the
  same cycle returns HTTP 403, and CelesTrak states that continued excessive requests
  result in the offending IP being handed to their firewall. Their guidance is that
  machine-to-machine clients must stop on any non-200 response and alert a human rather
  than retry.
- **Launch Library 2** allows 15 requests per hour unauthenticated.
- **SatNOGS DB** is CC BY-SA and must be attributed.

An in-memory rate limiter is not sufficient protection. During development a server may
restart dozens of times an hour, and each restart would reset an in-memory counter and
issue a fresh upstream request — precisely the access pattern that gets an IP banned.

## Decision

Every outbound request to an external data source goes through `GuardedHttpClient`,
which is governed by a per-provider policy and a persistent `FetchGuard`.

1. **Policy is data, with citations.** `policy.ts` holds the minimum interval, freshness
   thresholds and attribution for each provider, with a comment explaining where each
   number comes from. Changing how hard we hit a third party is a visible edit.
2. **Guard state is persisted to disk**, so it survives process restarts. A dev-server
   restart loop cannot produce repeat upstream requests.
3. **Check-and-reserve is atomic.** `tryAcquire` decides and reserves inside one
   critical section. Checking and recording separately is a time-of-check-to-time-of-use
   race in which two concurrent ingest jobs are both told "allowed" and both fetch.
4. **Reservations are leased, not recorded as fetches.** `reservedAt` is distinct from
   `lastFetchedAt` and expires after 5 minutes. This was added after a real incident:
   the first implementation stamped `lastFetchedAt` before the request, so a process
   killed mid-flight left state indistinguishable from a completed download and blocked
   the resource for the full provider interval although nothing was ever retrieved.
5. **Failure handling distinguishes cause.** 403/429 means we misbehaved: hold the
   reservation and apply escalating backoff (15 min, 1 h, 4 h, 24 h), then stop. A 5xx
   or a network timeout is the provider's problem: roll back, so a transient failure
   never consumes a two-hour data cycle.
6. **Fail closed.** If guard state cannot be read, refuse all upstream requests rather
   than assuming it is safe to proceed.
7. **No browser or mobile client ever calls a provider directly.** All access is
   server-side and cached.

## Verification status

Verified against live production responses, with fixtures and schema tests:

- NOAA SWPC — planetary K index, propagated solar wind, R/S/G scales
- Launch Library 2 — list and detailed launch payloads
- WhereTheISS.at — ISS cross-check

**Blocked, and deliberately not worked around:**

- **CelesTrak** (GP and SATCAT): TCP connect never completes from this network. DNS
  resolves in ~7 ms; the connect phase times out on both IPv4-forced and default
  stacks, and an independent fetch service saw the same. No HTTP response is ever
  received, so this is not rate limiting or credentials.
- **SatNOGS DB**: TLS completes in ~0.6 s, then the server returns no bytes before
  timeout. Reproduced on the cheapest endpoint, so it is not query cost. No credentials
  are required by this API.

Both are treated as **environment/network blockers**. They are recorded in
`fixtures/manifest.json` under `blocked` and remain **unverified**. No fixture has been
fabricated for them, and no substitute primary orbital-element provider has been
introduced: CelesTrak stays the primary source, and its adapter will be verified from an
environment that can reach it.

## Consequences

- The rate policy is an enforced invariant rather than a comment.
- Provider health and data freshness are derivable from guard state, which the
  `/providers/status` endpoint surfaces.
- Development against blocked providers proceeds using clearly-labelled fixtures, and
  those providers are reported as incomplete until real responses are captured.
- A guard that has never fetched blocks nothing, so first runs work; a guard that
  cannot read its state blocks everything, which is the safe direction.
