import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { InMemoryDatabase } from "@orbitwatch/database";
import { GuardedHttpClient, type GuardedFetchResult } from "@orbitwatch/providers";
import { beforeEach, describe, expect, it } from "vitest";

import { ingestLaunches } from "./ingest-launches.js";

/**
 * Launch ingestion, replayed through the real pipeline with a real response.
 *
 * `fixtures/launch-library-upcoming-detailed.json` is an unmodified capture of a
 * production LL2 `mode=detailed` response, taken during M0 and recorded in
 * `fixtures/manifest.json`. Only the network call is replaced.
 */

const repoRoot = resolve(process.cwd(), "..", "..");
const FIXTURE = readFileSync(
  resolve(repoRoot, "fixtures", "launch-library-upcoming-detailed.json"),
  "utf8",
);

const FETCHED_AT = new Date("2026-08-31T12:28:05.841Z");

class FixtureHttpClient extends GuardedHttpClient {
  constructor(private readonly body: string) {
    super();
  }
  override get(): Promise<GuardedFetchResult> {
    return Promise.resolve({
      status: "fetched",
      body: this.body,
      contentType: "application/json",
      fetchedAt: FETCHED_AT,
    });
  }
}

describe("ingestLaunches", () => {
  let database: InMemoryDatabase;

  beforeEach(() => {
    database = new InMemoryDatabase();
  });

  it("ingests a real detailed response", async () => {
    const result = await ingestLaunches({
      database,
      http: new FixtureHttpClient(FIXTURE),
      holder: "test",
    });

    expect(result.status).toBe("success");
    expect(result.fetched).toBeGreaterThan(0);
    expect(result.inserted).toBe(result.fetched);
  });

  it("keeps the rocket, pad and mission that list mode omits", async () => {
    await ingestLaunches({ database, http: new FixtureHttpClient(FIXTURE), holder: "test" });

    const upcoming = await database.launches.upcoming(new Date("2026-09-01T00:00:00Z"), 10);
    const electron = upcoming.find((launch) => launch.rocketName === "Electron");

    // Real published values from the captured response — the fields that make a launch
    // legible and that `mode=list` does not return.
    expect(electron).toBeDefined();
    expect(electron?.serviceProvider).toBe("Rocket Lab");
    expect(electron?.missionOrbit).toBe("Low Earth Orbit");
    expect(electron?.padLocation).toContain("New Zealand");
  });

  it("records how precise each launch time actually is", async () => {
    await ingestLaunches({ database, http: new FixtureHttpClient(FIXTURE), holder: "test" });

    const upcoming = await database.launches.upcoming(new Date("2026-09-01T00:00:00Z"), 10);
    const precisions = upcoming.map((launch) => launch.netPrecision);

    // The captured page carries one launch accurate to the Minute and one only to the
    // Hour. Storing the timestamp without that distinction would let the UI render a
    // to-the-second countdown for something known to within an hour.
    expect(precisions).toContain("Minute");
    expect(precisions).toContain("Hour");
  });

  it("keeps pad coordinates where the provider has them", async () => {
    await ingestLaunches({ database, http: new FixtureHttpClient(FIXTURE), holder: "test" });

    const upcoming = await database.launches.upcoming(new Date("2026-09-01T00:00:00Z"), 10);
    const located = upcoming.filter((launch) => launch.padLatitude !== undefined);

    expect(located.length).toBeGreaterThan(0);
    for (const launch of located) {
      expect(Math.abs(launch.padLatitude as number)).toBeLessThanOrEqual(90);
      expect(Math.abs(launch.padLongitude as number)).toBeLessThanOrEqual(180);
    }
  });

  it("is idempotent: the same page updates rather than duplicates", async () => {
    let now = new Date("2026-08-31T12:28:05Z");
    const clocked = new InMemoryDatabase({ now: () => now });

    const first = await ingestLaunches({
      database: clocked,
      http: new FixtureHttpClient(FIXTURE),
      holder: "test",
      now: () => now,
    });

    // A day later, well past the provider's interval.
    now = new Date("2026-09-01T12:28:05Z");
    const second = await ingestLaunches({
      database: clocked,
      http: new FixtureHttpClient(FIXTURE),
      holder: "test",
      now: () => now,
    });

    expect(first.inserted).toBeGreaterThan(0);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(first.inserted);
  });

  it("honours the durable rate policy", async () => {
    // LL2 allows fifteen unauthenticated requests an hour across the whole IP, so this
    // guard is the real protection — the on-disk one cannot help an ephemeral runner.
    let now = new Date("2026-08-31T12:28:05Z");
    const clocked = new InMemoryDatabase({ now: () => now });

    await ingestLaunches({
      database: clocked,
      http: new FixtureHttpClient(FIXTURE),
      holder: "test",
      now: () => now,
    });

    now = new Date("2026-08-31T12:29:05Z");
    const second = await ingestLaunches({
      database: clocked,
      http: new FixtureHttpClient(FIXTURE),
      holder: "test",
      now: () => now,
    });

    expect(second.status).toBe("skipped");
    expect(second.errorSummary).toContain("provider rate policy");
  });

  it("fails loudly and records the run when the shape changes", async () => {
    // LL2 is a single curated API, not a community database: a record that fails the
    // schema means the shape changed, and guessing at the rest would be worse than
    // failing with the last known good data retained.
    const result = await ingestLaunches({
      database,
      http: new FixtureHttpClient(JSON.stringify({ results: [{ unexpected: true }] })),
      holder: "test",
    });

    expect(result.status).toBe("failed");
    const run = await database.providerRuns.latestAttempt("launch-library", "upcoming");
    expect(run?.status).toBe("failed");
    expect(await database.launches.upcoming(new Date(0), 10)).toEqual([]);
  });

  it("treats a guard-skipped fetch as a skip, not a failure", async () => {
    class SkippingClient extends GuardedHttpClient {
      override get(): Promise<GuardedFetchResult> {
        return Promise.resolve({
          status: "skipped",
          reason: "within-interval",
          retryAfterMs: 3_600_000,
          lastFetchedAt: undefined,
        });
      }
    }

    const result = await ingestLaunches({
      database,
      http: new SkippingClient(),
      holder: "test",
    });

    expect(result.status).toBe("skipped");
    expect(result.errorSummary).toContain("fetch guard");
  });
});
