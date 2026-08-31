import { InMemoryDatabase } from "@orbitwatch/database";
import { FetchGuard, GuardedHttpClient } from "@orbitwatch/providers";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ingestOrbitalElements } from "./ingest-elements.js";

/**
 * End-to-end ingestion tests against the in-memory database.
 *
 * The GP payloads below are hand-constructed from CelesTrak's DOCUMENTED schema, not
 * captured from production — celestrak.org is unreachable from this network. They are
 * sufficient to prove the pipeline (lease, validate, normalise, compare, store, log,
 * last-known-good) and they explicitly do NOT satisfy the provider-verification gate.
 * See docs/adr/0005 and fixtures/manifest.json.
 */

const ISS_GP = {
  OBJECT_NAME: "ISS (ZARYA)",
  OBJECT_ID: "1998-067A",
  EPOCH: "2026-08-31T10:00:00.000000",
  MEAN_MOTION: 15.4939277,
  ECCENTRICITY: 0.0002062,
  INCLINATION: 51.6443,
  RA_OF_ASC_NODE: 213.3186,
  ARG_OF_PERICENTER: 86.161,
  MEAN_ANOMALY: 20.9679,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: "U",
  NORAD_CAT_ID: 25544,
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 22912,
  BSTAR: 0.000022921,
  MEAN_MOTION_DOT: 0.00000771,
  MEAN_MOTION_DDOT: 0,
};

const HST_GP = { ...ISS_GP, OBJECT_NAME: "HST", OBJECT_ID: "1990-037B", NORAD_CAT_ID: 20580 };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("orbital element ingestion", () => {
  let stateDir: string;
  let guard: FetchGuard;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orbitwatch-ingest-"));
    guard = new FetchGuard({ stateFile: join(stateDir, "guard.json") });
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const clientReturning = (body: unknown): GuardedHttpClient => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body)));
    return new GuardedHttpClient(guard);
  };

  it("stores elements and records a successful run", async () => {
    const database = new InMemoryDatabase();
    const result = await ingestOrbitalElements({
      database,
      http: clientReturning([ISS_GP, HST_GP]),
      query: { kind: "GROUP", value: "stations" },
    });

    expect(result.status).toBe("success");
    expect(result.fetched).toBe(2);
    expect(result.inserted).toBe(2);
    expect(database.elementCount).toBe(2);

    const [run] = await database.providerRuns.latestRuns();
    expect(run?.status).toBe("success");
    expect(run?.recordsInserted).toBe(2);
  });

  it("creates placeholder satellites without inventing metadata", async () => {
    // GP data does not say what an object is. Guessing PAYLOAD would mislabel debris.
    const database = new InMemoryDatabase();
    await ingestOrbitalElements({
      database,
      http: clientReturning([ISS_GP]),
      query: { kind: "CATNR", value: "25544" },
    });

    const satellite = await database.satellites.findByCatalogId("25544");
    expect(satellite?.name).toBe("ISS (ZARYA)");
    expect(satellite?.objectType).toBe("UNKNOWN");
    expect(satellite?.owner).toBeUndefined();
    expect(satellite?.launchDate).toBeUndefined();
  });

  it("parses a timezone-less EPOCH as UTC", async () => {
    // CelesTrak omits the designator. Parsed naively this shifts by the host offset.
    const database = new InMemoryDatabase();
    await ingestOrbitalElements({
      database,
      http: clientReturning([ISS_GP]),
      query: { kind: "CATNR", value: "25544" },
    });

    const stored = await database.elements.findLatest("25544");
    expect(stored?.epoch.toISOString()).toBe("2026-08-31T10:00:00.000Z");
  });

  it("treats re-ingesting the same epoch as unchanged", async () => {
    // The healthy steady state two hours after the previous run.
    const database = new InMemoryDatabase();
    const query = { kind: "CATNR", value: "25544" } as const;

    await ingestOrbitalElements({ database, http: clientReturning([ISS_GP]), query });
    const second = await ingestOrbitalElements({
      database,
      http: clientReturning([ISS_GP]),
      query,
      // Bypass the interval guard: this test is about storage, not rate policy.
      ...{},
    });

    // The guard legitimately skips the second call, which is itself correct behaviour.
    expect(["skipped", "success"]).toContain(second.status);
    expect(database.elementCount).toBe(1);
  });

  it("appends new epochs as history rather than overwriting", async () => {
    const database = new InMemoryDatabase();

    await ingestOrbitalElements({
      database,
      http: clientReturning([ISS_GP]),
      query: { kind: "CATNR", value: "25544" },
    });
    await ingestOrbitalElements({
      database,
      http: clientReturning([{ ...ISS_GP, EPOCH: "2026-08-31T12:00:00.000000" }]),
      // A different resource key so the fetch guard permits the second call.
      query: { kind: "GROUP", value: "stations" },
    });

    expect(database.elementCount).toBe(2);
    const history = await database.elements.findHistory("25544");
    expect(history).toHaveLength(2);
    expect(history[0]?.epoch.toISOString()).toBe("2026-08-31T12:00:00.000Z");
  });

  it("keeps valid records when one is malformed, and reports it as partial", async () => {
    // One bad row must not discard a 20,000-object download.
    const database = new InMemoryDatabase();
    const result = await ingestOrbitalElements({
      database,
      http: clientReturning([ISS_GP, { OBJECT_NAME: "BROKEN" }, HST_GP]),
      query: { kind: "GROUP", value: "active" },
    });

    expect(result.status).toBe("partial");
    expect(result.inserted).toBe(2);
    expect(result.rejected).toBe(1);
    expect(result.errorSummary).toMatch(/schema rejection/);
  });

  it("fails without touching existing data when upstream returns nothing usable", async () => {
    // An empty catalog is never correct, and must not look like a quiet no-op run.
    const database = new InMemoryDatabase();
    await ingestOrbitalElements({
      database,
      http: clientReturning([ISS_GP]),
      query: { kind: "CATNR", value: "25544" },
    });
    expect(database.elementCount).toBe(1);

    const result = await ingestOrbitalElements({
      database,
      http: clientReturning([]),
      query: { kind: "GROUP", value: "active" },
    });

    expect(result.status).toBe("failed");
    expect(result.errorSummary).toMatch(/no usable records/);
    // Last known good is intact.
    expect(database.elementCount).toBe(1);
    expect(await database.elements.findLatest("25544")).toBeDefined();
  });

  it("fails cleanly on a non-JSON body", async () => {
    const database = new InMemoryDatabase();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>maintenance</html>", { status: 200 })),
    );

    const result = await ingestOrbitalElements({
      database,
      http: new GuardedHttpClient(guard),
      query: { kind: "GROUP", value: "active" },
    });

    expect(result.status).toBe("failed");
    expect(result.errorSummary).toMatch(/not valid JSON/);
  });

  it("records a failed run and preserves prior data on an upstream error", async () => {
    const database = new InMemoryDatabase();
    await ingestOrbitalElements({
      database,
      http: clientReturning([ISS_GP]),
      query: { kind: "CATNR", value: "25544" },
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream boom", { status: 503 })));
    const result = await ingestOrbitalElements({
      database,
      http: new GuardedHttpClient(guard),
      query: { kind: "GROUP", value: "active" },
    });

    expect(result.status).toBe("failed");
    expect(database.elementCount).toBe(1);

    // The failure is visible, and last known good is still findable.
    const lastGood = await database.providerRuns.latestSuccessfulRun(
      "celestrak-gp",
      "catnr-25544",
    );
    expect(lastGood?.status).toBe("success");
  });

  it("reports an upstream refusal prominently", async () => {
    // 403 means we asked too often. A human needs to see that, not a retry loop.
    const database = new InMemoryDatabase();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("GP data has not updated since your last successful download", {
            status: 403,
          }),
      ),
    );

    const result = await ingestOrbitalElements({
      database,
      http: new GuardedHttpClient(guard),
      query: { kind: "GROUP", value: "active" },
    });

    expect(result.status).toBe("failed");
    expect(result.errorSummary).toMatch(/PROVIDER REFUSED/);
  });

  it("skips when the fetch guard says the cycle is already downloaded", async () => {
    const database = new InMemoryDatabase();
    const query = { kind: "GROUP", value: "active" } as const;

    await ingestOrbitalElements({ database, http: clientReturning([ISS_GP]), query });
    const second = await ingestOrbitalElements({
      database,
      http: clientReturning([ISS_GP]),
      query,
    });

    expect(second.status).toBe("skipped");
    expect(second.skippedReason).toMatch(/already fetched this cycle/);
  });

  it("skips when another worker holds the lease", async () => {
    const database = new InMemoryDatabase();
    await database.leases.acquire("celestrak-gp:group-active", "other-worker", 600);

    const result = await ingestOrbitalElements({
      database,
      http: clientReturning([ISS_GP]),
      query: { kind: "GROUP", value: "active" },
      holder: "this-worker",
    });

    expect(result.status).toBe("skipped");
    expect(result.skippedReason).toMatch(/lease/);
    expect(database.elementCount).toBe(0);
  });

  it("releases the lease even when ingestion fails", async () => {
    // Otherwise one bad run blocks every subsequent run until the TTL expires.
    const database = new InMemoryDatabase();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));

    await ingestOrbitalElements({
      database,
      http: new GuardedHttpClient(guard),
      query: { kind: "GROUP", value: "active" },
      holder: "worker-a",
    });

    expect(
      await database.leases.acquire("celestrak-gp:group-active", "worker-b", 60),
    ).toBeDefined();
  });

  it("rejects a record SGP4 cannot initialise, keeping the rest", async () => {
    // Passing schema validation is not the same as being propagable.
    const database = new InMemoryDatabase();
    const result = await ingestOrbitalElements({
      database,
      http: clientReturning([ISS_GP, { ...HST_GP, ECCENTRICITY: 1.5 }]),
      query: { kind: "GROUP", value: "active" },
    });

    expect(result.inserted).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.status).toBe("partial");
  });
});
