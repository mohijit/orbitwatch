import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { InMemoryDatabase } from "@orbitwatch/database";
import { GuardedHttpClient, type GuardedFetchResult } from "@orbitwatch/providers";
import { beforeEach, describe, expect, it } from "vitest";

import { ingestTransmitters } from "./ingest-transmitters.js";

/**
 * Transmitter ingestion, replayed through the real pipeline with a real response.
 *
 * THE BYTES ARE REAL
 * `fixtures/satnogs-transmitters-iss.json` is an unmodified capture of a production
 * SatNOGS DB response — 50 transmitters for the ISS, taken during M0 and recorded in
 * `fixtures/manifest.json`. Every assertion below is against values SatNOGS actually
 * published, so a schema that drifts from the real shape fails here rather than on a
 * user's screen.
 *
 * THE PIPELINE IS REAL TOO
 * Only the network call is replaced. Leasing, the durable rate check, JSON parsing,
 * per-record schema validation, normalisation and the upsert all run exactly as they
 * do in production, which is what makes this an ingestion test rather than a mapping
 * test.
 */

const repoRoot = resolve(process.cwd(), "..", "..");
const FIXTURE = readFileSync(
  resolve(repoRoot, "fixtures", "satnogs-transmitters-iss.json"),
  "utf8",
);

const FETCHED_AT = new Date("2026-08-31T12:00:00.000Z");

/** Replays captured bytes. Subclassed so nothing can be handed a lookalike client. */
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

/** Never reaches the network, and reports the guard's own skip outcome. */
class SkippingHttpClient extends GuardedHttpClient {
  override get(): Promise<GuardedFetchResult> {
    return Promise.resolve({
      status: "skipped",
      reason: "within-interval",
      retryAfterMs: 3_600_000,
      lastFetchedAt: undefined,
    });
  }
}

describe("ingestTransmitters", () => {
  let database: InMemoryDatabase;

  beforeEach(() => {
    database = new InMemoryDatabase();
  });

  it("ingests every transmitter in a real SatNOGS response", async () => {
    const result = await ingestTransmitters({
      database,
      http: new FixtureHttpClient(FIXTURE),
      catalogId: "25544",
      holder: "test",
    });

    expect(result.status).toBe("success");
    expect(result.fetched).toBe(50);
    expect(result.inserted).toBe(50);
    expect(result.rejected).toBe(0);
  });

  it("stores frequencies in hertz, exactly as published", async () => {
    await ingestTransmitters({
      database,
      http: new FixtureHttpClient(FIXTURE),
      catalogId: "25544",
      holder: "test",
    });

    const transmitters = await database.radio.forSatellite("25544");
    const aprs = transmitters.find((one) => one.description === "Mode V APRS");

    // 145.825 MHz, the ISS APRS digipeater — a real, checkable frequency, and the
    // canonical place for a factor of a thousand to hide.
    expect(aprs?.downlinkLowHz).toBe(145_825_000);
    expect(aprs?.uplinkLowHz).toBe(145_825_000);
    expect(aprs?.mode).toBe("AFSK");
    expect(aprs?.baud).toBe(1200);
  });

  it("keeps the provider's update time separate from the retrieval time", async () => {
    await ingestTransmitters({
      database,
      http: new FixtureHttpClient(FIXTURE),
      catalogId: "25544",
      holder: "test",
    });

    const [first] = await database.radio.forSatellite("25544");
    // Two different facts, and this product does not conflate them anywhere. SatNOGS
    // publishes `updated` with no zone designator; it is UTC, and parsing it with a
    // bare `new Date()` would silently apply the host's offset.
    expect(first?.updatedAt).toBeDefined();
    expect(first?.retrievedAt.toISOString()).toBe(FETCHED_AT.toISOString());
    expect(first?.updatedAt?.getTime()).toBeLessThan(FETCHED_AT.getTime());
  });

  it("is idempotent: replaying the same response updates rather than duplicates", async () => {
    // One clock, shared by the store and the ingestion. The database stamps
    // provider_runs with its OWN clock, so injecting a time into the ingestion alone
    // compares an invented instant against a real one and the rate guard refuses a run
    // that should be allowed — which is a bug in the test, not in the guard.
    let now = new Date("2026-08-31T12:00:00Z");
    const clocked = new InMemoryDatabase({ now: () => now });

    const first = await ingestTransmitters({
      database: clocked,
      http: new FixtureHttpClient(FIXTURE),
      catalogId: "25544",
      holder: "test",
      now: () => now,
    });

    // A day later: well past SatNOGS's six-hour policy, so this is a real second run
    // through the same path rather than the guard being weakened for the test.
    now = new Date("2026-09-01T12:00:00Z");
    const second = await ingestTransmitters({
      database: clocked,
      http: new FixtureHttpClient(FIXTURE),
      catalogId: "25544",
      holder: "test",
      now: () => now,
    });

    database = clocked;

    expect(first.inserted).toBe(50);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(50);
    expect(await database.radio.count()).toBe(50);
  });

  it("reports partial success rather than losing the whole batch to one bad record", async () => {
    // A community database contains odd entries. Discarding forty-nine good records
    // because of one malformed one would make the newest and most unusual objects —
    // exactly the interesting ones — reliably break ingestion.
    const records = JSON.parse(FIXTURE) as unknown[];
    const corrupted = [...records];
    corrupted[0] = { uuid: "broken", description: "missing everything else" };

    const result = await ingestTransmitters({
      database,
      http: new FixtureHttpClient(JSON.stringify(corrupted)),
      catalogId: "25544",
      holder: "test",
    });

    expect(result.status).toBe("partial");
    expect(result.rejected).toBe(1);
    expect(result.inserted).toBe(49);
    expect(result.errorSummary).toContain("1 transmitter record(s) failed validation");
  });

  it("records a provider run whatever the outcome", async () => {
    await ingestTransmitters({
      database,
      http: new FixtureHttpClient(FIXTURE),
      catalogId: "25544",
      holder: "test",
    });

    const run = await database.providerRuns.latestAttempt("satnogs-db", "transmitters-25544");
    expect(run?.status).toBe("success");
    expect(run?.recordsFetched).toBe(50);
    expect(run?.recordsInserted).toBe(50);
  });

  it("separates per-object and whole-database runs so one cannot starve the other", async () => {
    // A user opening a satellite triggers the per-object fetch. If that shared a rate
    // budget with the scheduled full refresh, browsing would silently disable ingestion.
    await ingestTransmitters({
      database,
      http: new FixtureHttpClient(FIXTURE),
      catalogId: "25544",
      holder: "test",
    });

    const scoped = await database.providerRuns.latestAttempt("satnogs-db", "transmitters-25544");
    const all = await database.providerRuns.latestAttempt("satnogs-db", "transmitters-all");
    expect(scoped).toBeDefined();
    expect(all).toBeUndefined();
  });

  it("honours the durable rate policy on a second attempt", async () => {
    let at = new Date("2026-08-31T12:00:00Z");
    const clocked = new InMemoryDatabase({ now: () => at });
    database = clocked;

    await ingestTransmitters({
      database: clocked,
      http: new FixtureHttpClient(FIXTURE),
      catalogId: "25544",
      holder: "test",
      now: () => at,
    });

    // SatNOGS's policy is six hours; one minute later must be refused. The guard is
    // durable — a provider_runs row — so an ephemeral CI runner with an empty disk
    // cannot bypass it by starting fresh.
    const oneMinuteLater = new Date(at.getTime() + 60_000);
    at = oneMinuteLater;
    const second = await ingestTransmitters({
      database: clocked,
      http: new FixtureHttpClient(FIXTURE),
      catalogId: "25544",
      holder: "test",
      now: () => oneMinuteLater,
    });

    expect(second.status).toBe("skipped");
    expect(second.errorSummary).toContain("provider rate policy");
    expect(await database.radio.count()).toBe(50);
  });

  it("treats a guard-skipped fetch as a skip, not a failure", async () => {
    const result = await ingestTransmitters({
      database,
      http: new SkippingHttpClient(),
      catalogId: "25544",
      holder: "test",
    });

    expect(result.status).toBe("skipped");
    expect(result.errorSummary).toContain("fetch guard");
    expect(await database.radio.count()).toBe(0);
  });

  it("fails loudly and records the run when the response is not JSON", async () => {
    const result = await ingestTransmitters({
      database,
      http: new FixtureHttpClient("<html>502 Bad Gateway</html>"),
      catalogId: "25544",
      holder: "test",
    });

    expect(result.status).toBe("failed");
    expect(result.errorSummary).toContain("not valid JSON");

    // A failed run is still a run. Silence is what makes a broken provider invisible.
    const run = await database.providerRuns.latestAttempt("satnogs-db", "transmitters-25544");
    expect(run?.status).toBe("failed");
  });

  it("releases the lease so a later run is not blocked by a failure", async () => {
    let now = new Date("2026-08-31T12:00:00Z");
    const clocked = new InMemoryDatabase({ now: () => now });

    await ingestTransmitters({
      database: clocked,
      http: new FixtureHttpClient("not json"),
      catalogId: "25544",
      holder: "test",
      now: () => now,
    });

    now = new Date("2026-09-01T12:00:00Z");
    const result = await ingestTransmitters({
      database: clocked,
      http: new FixtureHttpClient(FIXTURE),
      catalogId: "25544",
      holder: "test",
      now: () => now,
    });

    // A crashed run must not wedge the resource. The lease is released in a finally,
    // so the next attempt proceeds normally.
    expect(result.status).toBe("success");
  });
});
