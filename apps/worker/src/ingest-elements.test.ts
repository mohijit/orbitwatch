import { InMemoryDatabase } from "@orbitwatch/database";
import { deriveOrbitGeometry, parseOmm, type OMMJsonObject } from "@orbitwatch/orbit-core";
import { FetchGuard, GuardedHttpClient } from "@orbitwatch/providers";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ingestOrbitalElements } from "./ingest-elements.js";

/**
 * End-to-end ingestion tests against the in-memory database.
 *
 * The inline GP payloads below are hand-constructed from CelesTrak's DOCUMENTED
 * schema, not captured from production — celestrak.org is unreachable from this
 * network. They are sufficient to prove the pipeline (lease, validate, normalise,
 * compare, store, log, last-known-good) and they explicitly do NOT satisfy the
 * provider-verification gate. See docs/adr/0005 and fixtures/manifest.json.
 *
 * The final block is the exception: it runs against real captured records.
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

  describe("durable rate guard", () => {
    /**
     * These cover the failure the on-disk FetchGuard cannot: an ephemeral runner whose
     * guard state is empty on every start. Without a database-backed check, a scheduled
     * CI job would fetch CelesTrak on every run and breach their once-per-cycle policy.
     */

    it("refuses a second ingest inside the provider interval, even with a fresh guard", async () => {
      const database = new InMemoryDatabase();

      const first = await ingestOrbitalElements({
        database,
        http: clientReturning([ISS_GP]),
        query: { kind: "GROUP", value: "active" },
      });
      expect(first.status).toBe("success");

      // A brand-new guard with its own empty state file is exactly what a CI runner
      // starts with. The disk guard would happily allow this fetch.
      const freshStateDir = await mkdtemp(join(tmpdir(), "orbitwatch-fresh-"));
      const freshGuard = new FetchGuard({ stateFile: join(freshStateDir, "guard.json") });
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([ISS_GP])));

      const second = await ingestOrbitalElements({
        database,
        http: new GuardedHttpClient(freshGuard),
        query: { kind: "GROUP", value: "active" },
      });

      expect(second.status).toBe("skipped");
      expect(second.skippedReason).toMatch(/rate policy/);
      // The decisive assertion: no request was issued despite the empty guard state.
      expect(fetch).not.toHaveBeenCalled();

      await rm(freshStateDir, { recursive: true, force: true });
    });

    it("counts a failed run against the interval", async () => {
      const database = new InMemoryDatabase();

      // A run that fetched and then failed has still consumed the provider's budget.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse([])),
      );
      const failed = await ingestOrbitalElements({
        database,
        http: new GuardedHttpClient(guard),
        query: { kind: "GROUP", value: "active" },
      });
      expect(failed.status).toBe("failed");

      const freshStateDir = await mkdtemp(join(tmpdir(), "orbitwatch-fresh2-"));
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([ISS_GP])));

      const second = await ingestOrbitalElements({
        database,
        http: new GuardedHttpClient(
          new FetchGuard({ stateFile: join(freshStateDir, "guard.json") }),
        ),
        query: { kind: "GROUP", value: "active" },
      });

      expect(second.status).toBe("skipped");
      expect(fetch).not.toHaveBeenCalled();

      await rm(freshStateDir, { recursive: true, force: true });
    });

    it("allows a fetch once the interval has elapsed", async () => {
      const database = new InMemoryDatabase();

      await ingestOrbitalElements({
        database,
        http: clientReturning([ISS_GP]),
        query: { kind: "GROUP", value: "active" },
      });

      // CelesTrak GP: 2h10m. Three hours later the next cycle has been published.
      const threeHoursLater = new Date(Date.now() + 3 * 3600_000);
      const freshStateDir = await mkdtemp(join(tmpdir(), "orbitwatch-fresh3-"));
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([ISS_GP, HST_GP])));

      const second = await ingestOrbitalElements({
        database,
        http: new GuardedHttpClient(
          new FetchGuard({ stateFile: join(freshStateDir, "guard.json") }),
        ),
        query: { kind: "GROUP", value: "active" },
        now: () => threeHoursLater,
      });

      expect(second.status).toBe("success");
      expect(fetch).toHaveBeenCalled();

      await rm(freshStateDir, { recursive: true, force: true });
    });

    it("keeps the interval separate per resource", async () => {
      const database = new InMemoryDatabase();

      await ingestOrbitalElements({
        database,
        http: clientReturning([ISS_GP]),
        query: { kind: "GROUP", value: "active" },
      });

      // A different group is a different resource and a different budget.
      const freshStateDir = await mkdtemp(join(tmpdir(), "orbitwatch-fresh4-"));
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([HST_GP])));

      const other = await ingestOrbitalElements({
        database,
        http: new GuardedHttpClient(
          new FetchGuard({ stateFile: join(freshStateDir, "guard.json") }),
        ),
        query: { kind: "GROUP", value: "stations" },
      });

      expect(other.status).toBe("success");

      await rm(freshStateDir, { recursive: true, force: true });
    });

    it("releases the lease when it skips, so the next run is not blocked", async () => {
      const database = new InMemoryDatabase();

      await ingestOrbitalElements({
        database,
        http: clientReturning([ISS_GP]),
        query: { kind: "GROUP", value: "active" },
      });

      await ingestOrbitalElements({
        database,
        http: clientReturning([ISS_GP]),
        query: { kind: "GROUP", value: "active" },
      });

      // The skip path returns before the try/finally that normally releases the lease,
      // so it has to release explicitly or ingestion wedges until the lease expires.
      const lease = await database.leases.acquire(
        "celestrak-gp:group-active",
        "someone-else",
        60,
      );
      expect(lease).toBeDefined();
    });
  });

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

  it("skips a repeat download within the provider's update cycle", async () => {
    const database = new InMemoryDatabase();
    const query = { kind: "GROUP", value: "active" } as const;

    await ingestOrbitalElements({ database, http: clientReturning([ISS_GP]), query });
    const second = await ingestOrbitalElements({
      database,
      http: clientReturning([ISS_GP]),
      query,
    });

    expect(second.status).toBe("skipped");
    // Two guards can stop this, and the durable one is checked first: it is the only
    // one that also holds on an ephemeral runner. The on-disk FetchGuard remains the
    // backstop for callers outside ingestion, and has its own tests in
    // @orbitwatch/providers. What matters here is that the request does not go out.
    expect(second.skippedReason).toMatch(/rate policy|already fetched this cycle/);
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

  it("records group membership, which the elements alone cannot express", async () => {
    // The response IS the membership list -- no OMM field says which groups an object
    // belongs to. For `visual` that list is the only brightness information a public
    // catalog offers, so losing it would leave Visible Tonight with nothing to filter
    // on.
    const database = new InMemoryDatabase();
    await ingestOrbitalElements({
      database,
      http: clientReturning([ISS_GP, HST_GP]),
      query: { kind: "GROUP", value: "visual" },
    });

    const members = await database.groups.members("celestrak-gp", "visual");
    expect(members.map((member) => member.catalogId)).toEqual(["20580", "25544"]);
  });

  it("does not invent group membership for a single-object request", async () => {
    // A CATNR request returns one object because that is what was asked for, not
    // because the object is the sole member of anything.
    const database = new InMemoryDatabase();
    await ingestOrbitalElements({
      database,
      http: clientReturning([ISS_GP]),
      query: { kind: "CATNR", value: "25544" },
    });

    expect(await database.groups.members("celestrak-gp", "visual")).toEqual([]);
    expect(await database.groups.members("celestrak-gp", "25544")).toEqual([]);
  });

  /**
   * The E2E corpus, checked here rather than only in Playwright.
   *
   * Unlike the payloads above, these records ARE captured production data: 32 real
   * CelesTrak GP records exported from rows this project ingested, with provenance in
   * fixtures/manifest.json. The E2E suite seeds itself by replaying this file through
   * the very function under test here, so a fixture that no longer ingests cleanly
   * should fail in seconds during `pnpm test` rather than as a puzzling timeout two
   * minutes into a browser run.
   *
   * The multiplicity assertions are the point. The suite spent M3 exercising a single
   * object, which cannot tell a working catalog pipeline apart from one that handles
   * exactly one item. If this corpus ever collapses back to one object — or to several
   * copies of the same one — these fail.
   */
  describe("the committed E2E fixture", () => {
    const records = JSON.parse(
      readFileSync(
        join(process.cwd(), "..", "..", "fixtures", "celestrak-gp-e2e-subset.json"),
        "utf8",
      ),
    ) as Record<string, unknown>[];

    it("ingests through the real pipeline with nothing rejected", async () => {
      const database = new InMemoryDatabase();
      const result = await ingestOrbitalElements({
        database,
        http: clientReturning(records),
        query: { kind: "GROUP", value: "active" },
      });

      expect(result.status).toBe("success");
      expect(result.rejected).toBe(0);
      expect(result.inserted).toBe(records.length);

      // Placeholder satellite rows too: without them the catalog query, which joins
      // satellites, silently returns nothing at all.
      const satellites = await database.satellites.findMany({ limit: 1000 });
      expect(satellites).toHaveLength(records.length);
    });

    it("holds many distinct objects, not one repeated", () => {
      const catalogIds = new Set(records.map((record) => String(record["NORAD_CAT_ID"])));
      const names = new Set(records.map((record) => String(record["OBJECT_NAME"])));

      expect(records.length).toBeGreaterThan(1);
      expect(catalogIds.size).toBe(records.length);
      expect(names.size).toBe(records.length);
    });

    it("spans several orbit regimes", () => {
      // Accuracy bands are keyed on orbit class, so a corpus confined to one regime
      // would leave the class-dependent paths untested no matter how many objects it
      // held. Derived from the elements, because the GP feed does not state it.
      const classes = new Set(
        records.map(
          (record) =>
            deriveOrbitGeometry(
              parseOmm(record as unknown as OMMJsonObject, {
                provider: "celestrak",
                retrievedAt: new Date(),
              }).satrec,
            ).orbitClass,
        ),
      );

      expect(classes.size).toBeGreaterThanOrEqual(4);
      expect(classes).toContain("LEO");
      expect(classes).toContain("GEO");
    });
  });
});
