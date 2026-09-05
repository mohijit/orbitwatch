import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { InMemoryDatabase } from "@orbitwatch/database";
import { GuardedHttpClient, type GuardedFetchResult } from "@orbitwatch/providers";
import { beforeEach, describe, expect, it } from "vitest";

import { ingestSolarEvents } from "./ingest-solar-events.js";
import { ingestStations } from "./ingest-stations.js";

/**
 * Ground station and solar event ingestion, replayed through the real pipelines with
 * real captured responses.
 *
 * Both fixtures were captured through the same FetchGuard production uses, with one
 * request each, and their provenance is in `fixtures/manifest.json`. Only the network
 * call is replaced.
 */

const repoRoot = resolve(process.cwd(), "..", "..");
const read = (name: string): string =>
  readFileSync(resolve(repoRoot, "fixtures", name), "utf8");

const STATIONS = read("satnogs-network-stations.json");
const EVENTS = read("nasa-donki-notifications.json");
const FETCHED_AT = new Date("2026-09-02T00:00:00.000Z");

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

describe("ingestStations", () => {
  let database: InMemoryDatabase;

  beforeEach(() => {
    database = new InMemoryDatabase();
  });

  it("ingests a real station listing", async () => {
    const result = await ingestStations({
      database,
      http: new FixtureHttpClient(STATIONS),
      holder: "test",
    });

    expect(result.status).toBe("success");
    expect(result.fetched).toBeGreaterThan(0);
    expect(result.inserted).toBe(result.fetched);
  });

  it("stores the offline majority rather than filtering it away", async () => {
    // The real listing was 4,119 Offline, 317 Online and 16 Testing. Storing only the
    // working ones would make the data useless the next time a station comes back, and
    // treating the total as receiving capacity would overstate coverage tenfold.
    const result = await ingestStations({
      database,
      http: new FixtureHttpClient(STATIONS),
      holder: "test",
    });

    expect(result.byStatus["Offline"]).toBeGreaterThan(0);
    expect(result.byStatus["Online"]).toBeGreaterThan(0);

    const counts = await database.stations.countByStatus();
    expect(counts["Offline"]).toBe(result.byStatus["Offline"]);
  });

  it("keeps each station's own horizon and its bands", async () => {
    await ingestStations({ database, http: new FixtureHttpClient(STATIONS), holder: "test" });

    const stations = await database.stations.list();
    // Per-station, genuinely: a site in a valley may not observe below 40 degrees.
    expect(new Set(stations.map((one) => one.minHorizonDegrees)).size).toBeGreaterThan(1);

    const withBands = stations.filter((one) => one.bands.length > 0);
    expect(withBands.length).toBeGreaterThan(0);
    for (const station of withBands) {
      // Deduplicated: four UHF antennas are one band, not four.
      expect(new Set(station.bands).size).toBe(station.bands.length);
    }
  });

  it("is idempotent across runs", async () => {
    let now = new Date("2026-09-02T00:00:00Z");
    const clocked = new InMemoryDatabase({ now: () => now });

    const first = await ingestStations({
      database: clocked,
      http: new FixtureHttpClient(STATIONS),
      holder: "test",
      now: () => now,
    });

    // The policy is one hour; a day later is a genuine second run.
    now = new Date("2026-09-03T00:00:00Z");
    const second = await ingestStations({
      database: clocked,
      http: new FixtureHttpClient(STATIONS),
      holder: "test",
      now: () => now,
    });

    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(first.inserted);
  });

  it("fails loudly when the shape changes", async () => {
    const result = await ingestStations({
      database,
      http: new FixtureHttpClient(JSON.stringify([{ id: 1, unexpected: true }])),
      holder: "test",
    });

    expect(result.status).toBe("failed");
    expect(await database.stations.list()).toEqual([]);
    const run = await database.providerRuns.latestAttempt("satnogs-network", "stations");
    expect(run?.status).toBe("failed");
  });
});

describe("ingestSolarEvents", () => {
  let database: InMemoryDatabase;

  beforeEach(() => {
    database = new InMemoryDatabase();
  });

  it("ingests a real DONKI window", async () => {
    const result = await ingestSolarEvents({
      database,
      http: new FixtureHttpClient(EVENTS),
      holder: "test",
      apiKey: "TEST_KEY",
    });

    expect(result.status).toBe("success");
    expect(result.fetched).toBeGreaterThan(0);
    // The captured August 2026 window carried coronal mass ejections and geomagnetic
    // storms; the storms are the ones that raise drag and degrade propagation.
    expect(result.byType["CME"]).toBeGreaterThan(0);
    expect(result.byType["GST"]).toBeGreaterThan(0);
  });

  it("keeps the narrative and derives a summary past the boilerplate", async () => {
    await ingestSolarEvents({
      database,
      http: new FixtureHttpClient(EVENTS),
      holder: "test",
      apiKey: "TEST_KEY",
    });

    const events = await database.solarEvents.recent({ limit: 5 });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.body.length).toBeGreaterThan(50);
      // Every DONKI body opens with ## header lines; a summary of those would be
      // identical for every event.
      expect(event.summary.startsWith("##")).toBe(false);
    }
  });

  it("returns events newest first", async () => {
    await ingestSolarEvents({
      database,
      http: new FixtureHttpClient(EVENTS),
      holder: "test",
      apiKey: "TEST_KEY",
    });

    const events = await database.solarEvents.recent();
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]!.issuedAt.getTime()).toBeLessThanOrEqual(
        events[index - 1]!.issuedAt.getTime(),
      );
    }
  });

  it("fails rather than storing a partially parsed window", async () => {
    // DONKI is one curated NASA service. An event list quietly missing a geomagnetic
    // storm is worse than an ingestion that failed and said so.
    const records = JSON.parse(EVENTS) as Record<string, unknown>[];
    const corrupted = [...records];
    corrupted[0] = { ...corrupted[0], messageIssueTime: "not a date" };

    const result = await ingestSolarEvents({
      database,
      http: new FixtureHttpClient(JSON.stringify(corrupted)),
      holder: "test",
      apiKey: "TEST_KEY",
    });

    expect(result.status).toBe("failed");
    expect(await database.solarEvents.recent()).toEqual([]);
  });

  it("is idempotent across runs", async () => {
    let now = new Date("2026-09-02T00:00:00Z");
    const clocked = new InMemoryDatabase({ now: () => now });

    const first = await ingestSolarEvents({
      database: clocked,
      http: new FixtureHttpClient(EVENTS),
      holder: "test",
      apiKey: "TEST_KEY",
      now: () => now,
    });

    now = new Date("2026-09-02T02:00:00Z");
    const second = await ingestSolarEvents({
      database: clocked,
      http: new FixtureHttpClient(EVENTS),
      holder: "test",
      apiKey: "TEST_KEY",
      now: () => now,
    });

    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(first.inserted);
  });

  it("honours the durable rate policy", async () => {
    let now = new Date("2026-09-02T00:00:00Z");
    const clocked = new InMemoryDatabase({ now: () => now });

    await ingestSolarEvents({
      database: clocked,
      http: new FixtureHttpClient(EVENTS),
      holder: "test",
      apiKey: "TEST_KEY",
      now: () => now,
    });

    // DEMO_KEY is throttled to roughly thirty requests an hour per IP, so the durable
    // guard matters more here than the on-disk one.
    now = new Date("2026-09-02T00:01:00Z");
    const second = await ingestSolarEvents({
      database: clocked,
      http: new FixtureHttpClient(EVENTS),
      holder: "test",
      apiKey: "TEST_KEY",
      now: () => now,
    });

    expect(second.status).toBe("skipped");
    expect(second.errorSummary).toContain("provider rate policy");
  });
});
