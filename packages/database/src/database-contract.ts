import { beforeEach, describe, expect, it } from "vitest";

import type { Database, OrbitalElementRecord, SatelliteRecord } from "./repositories.js";

/**
 * The storage contract, as an executable specification.
 *
 * Both `InMemoryDatabase` and `PostgresDatabase` are run against this. That is what
 * makes the in-memory implementation trustworthy as a development and test substitute:
 * it is not a mock that happens to satisfy the type signature, it is a second
 * implementation of behaviour that is pinned down here.
 *
 * Written to avoid depending on anything the two implementations legitimately differ
 * on — generated id values, clock source, and physical row ordering beyond what the
 * interface promises.
 */

const HOUR = 3_600_000;

/** A fixed reference instant, so no assertion depends on when the suite runs. */
const T0 = new Date("2026-03-01T00:00:00.000Z");

function at(offsetHours: number): Date {
  return new Date(T0.getTime() + offsetHours * HOUR);
}

export function makeSatellite(
  overrides: Partial<SatelliteRecord> & Pick<SatelliteRecord, "catalogId">,
): SatelliteRecord {
  return {
    name: `OBJECT ${overrides.catalogId}`,
    internationalDesignator: "1998-067A",
    objectType: "PAYLOAD",
    operationalStatus: "OPERATIONAL",
    owner: "CIS",
    launchDate: new Date("1998-11-20T00:00:00.000Z"),
    launchSite: "TTMTR",
    decayDate: undefined,
    periodMinutes: 92.9,
    inclinationDegrees: 51.64,
    apogeeKm: 421,
    perigeeKm: 415,
    rcsSquareMetres: 399.05,
    orbitClass: "LEO",
    metadata: {},
    sourceProvider: "celestrak",
    updatedAt: T0,
    ...overrides,
  };
}

export function makeElement(
  overrides: Partial<Omit<OrbitalElementRecord, "id">> &
    Pick<OrbitalElementRecord, "catalogId" | "epoch">,
): Omit<OrbitalElementRecord, "id"> {
  return {
    provider: "celestrak",
    format: "OMM_JSON",
    retrievedAt: overrides.epoch,
    omm: { OBJECT_NAME: "ISS (ZARYA)" },
    tleLine1: undefined,
    tleLine2: undefined,
    meanMotion: 15.5,
    eccentricity: 0.0006,
    inclination: 51.64,
    bstar: 0.00012,
    ...overrides,
  };
}

export interface ContractHarness {
  readonly database: Database;
  /** Return the database to an empty state between tests. */
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Run the storage contract against one implementation.
 *
 * `createHarness` is called once; `reset` is called before every test.
 */
export function runDatabaseContractTests(
  implementationName: string,
  createHarness: () => Promise<ContractHarness>,
): void {
  describe(`storage contract: ${implementationName}`, () => {
    let harness: ContractHarness;
    let db: Database;

    beforeEach(async () => {
      harness ??= await createHarness();
      // Reset first, then read: an implementation may reset by replacing the instance.
      await harness.reset();
      db = harness.database;
    });

    // ── satellites ───────────────────────────────────────────────────────────

    describe("satellites", () => {
      it("round-trips every modelled field", async () => {
        const record = makeSatellite({
          catalogId: "25544",
          name: "ISS (ZARYA)",
          metadata: { RCS_SIZE: "LARGE", nested: { a: 1 } },
        });
        await db.satellites.upsertMany([record]);

        const found = await db.satellites.findByCatalogId("25544");
        expect(found).toBeDefined();
        expect(found?.name).toBe("ISS (ZARYA)");
        expect(found?.internationalDesignator).toBe("1998-067A");
        expect(found?.objectType).toBe("PAYLOAD");
        expect(found?.operationalStatus).toBe("OPERATIONAL");
        expect(found?.owner).toBe("CIS");
        expect(found?.launchSite).toBe("TTMTR");
        expect(found?.periodMinutes).toBeCloseTo(92.9, 6);
        expect(found?.inclinationDegrees).toBeCloseTo(51.64, 6);
        expect(found?.apogeeKm).toBeCloseTo(421, 6);
        expect(found?.perigeeKm).toBeCloseTo(415, 6);
        expect(found?.rcsSquareMetres).toBeCloseTo(399.05, 6);
        expect(found?.orbitClass).toBe("LEO");
        expect(found?.sourceProvider).toBe("celestrak");
        expect(found?.metadata).toEqual({ RCS_SIZE: "LARGE", nested: { a: 1 } });
        // Calendar dates must not drift by a day through a timezone conversion.
        expect(found?.launchDate?.toISOString().slice(0, 10)).toBe("1998-11-20");
      });

      it("represents absent optional fields as undefined, never null", async () => {
        await db.satellites.upsertMany([
          makeSatellite({
            catalogId: "00001",
            internationalDesignator: undefined,
            operationalStatus: undefined,
            owner: undefined,
            launchDate: undefined,
            launchSite: undefined,
            rcsSquareMetres: undefined,
            orbitClass: undefined,
          }),
        ]);

        const found = await db.satellites.findByCatalogId("00001");
        expect(found?.internationalDesignator).toBeUndefined();
        expect(found?.operationalStatus).toBeUndefined();
        expect(found?.owner).toBeUndefined();
        expect(found?.launchDate).toBeUndefined();
        expect(found?.launchSite).toBeUndefined();
        expect(found?.rcsSquareMetres).toBeUndefined();
        expect(found?.orbitClass).toBeUndefined();
      });

      it("returns undefined for an unknown catalog id", async () => {
        expect(await db.satellites.findByCatalogId("99999")).toBeUndefined();
      });

      it("preserves Alpha-5 catalog ids as text", async () => {
        // "A0001" denotes 100001. An integer column would corrupt it silently.
        await db.satellites.upsertMany([makeSatellite({ catalogId: "A0001" })]);
        expect((await db.satellites.findByCatalogId("A0001"))?.catalogId).toBe("A0001");
      });

      it("counts only genuine changes on re-upsert", async () => {
        const original = makeSatellite({ catalogId: "25544", name: "ISS (ZARYA)" });
        expect(await db.satellites.upsertMany([original])).toBe(1);

        // Identical payload: nothing meaningful changed, so nothing is reported.
        expect(await db.satellites.upsertMany([original])).toBe(0);

        // A renamed object IS a change.
        expect(
          await db.satellites.upsertMany([{ ...original, name: "ISS (RENAMED)" }]),
        ).toBe(1);
      });

      it("treats a newly recorded decay as a change", async () => {
        const original = makeSatellite({ catalogId: "25544" });
        await db.satellites.upsertMany([original]);
        expect(
          await db.satellites.upsertMany([
            { ...original, decayDate: new Date("2026-01-02T00:00:00.000Z") },
          ]),
        ).toBe(1);
      });

      it("excludes decayed objects by default and includes them on request", async () => {
        await db.satellites.upsertMany([
          makeSatellite({ catalogId: "00001" }),
          makeSatellite({
            catalogId: "00002",
            decayDate: new Date("2020-05-01T00:00:00.000Z"),
          }),
        ]);

        const live = await db.satellites.findMany({});
        expect(live.map((row) => row.catalogId)).toEqual(["00001"]);

        const all = await db.satellites.findMany({ excludeDecayed: false });
        expect(all.map((row) => row.catalogId)).toEqual(["00001", "00002"]);

        expect(await db.satellites.count({})).toBe(1);
        expect(await db.satellites.count({ excludeDecayed: false })).toBe(2);
      });

      it("filters by object type, orbit class and owner", async () => {
        await db.satellites.upsertMany([
          makeSatellite({ catalogId: "00001", objectType: "PAYLOAD", owner: "US" }),
          makeSatellite({ catalogId: "00002", objectType: "DEBRIS", owner: "US" }),
          makeSatellite({
            catalogId: "00003",
            objectType: "PAYLOAD",
            owner: "ESA",
            orbitClass: "GEO",
          }),
        ]);

        expect(
          (await db.satellites.findMany({ objectTypes: ["DEBRIS"] })).map((r) => r.catalogId),
        ).toEqual(["00002"]);

        expect(
          (await db.satellites.findMany({ owners: ["ESA"] })).map((r) => r.catalogId),
        ).toEqual(["00003"]);

        expect(
          (await db.satellites.findMany({ orbitClasses: ["GEO"] })).map((r) => r.catalogId),
        ).toEqual(["00003"]);
      });

      it("searches name, catalog id, designator and owner case-insensitively", async () => {
        await db.satellites.upsertMany([
          makeSatellite({
            catalogId: "44713",
            name: "STARLINK-1007",
            owner: "US",
            internationalDesignator: "2019-074A",
          }),
          makeSatellite({ catalogId: "25544", name: "ISS (ZARYA)", owner: "CIS" }),
        ]);

        const byName = await db.satellites.findMany({ search: "starlink" });
        expect(byName.map((row) => row.catalogId)).toEqual(["44713"]);

        // Substring, not whole-word: "star" must find "STARLINK-1007".
        expect((await db.satellites.findMany({ search: "star" })).length).toBe(1);

        expect(
          (await db.satellites.findMany({ search: "25544" })).map((r) => r.catalogId),
        ).toEqual(["25544"]);

        expect(
          (await db.satellites.findMany({ search: "2019-074" })).map((r) => r.catalogId),
        ).toEqual(["44713"]);

        expect((await db.satellites.findMany({ search: "cis" })).length).toBe(1);
      });

      it("treats search wildcards as literal characters", async () => {
        await db.satellites.upsertMany([
          makeSatellite({ catalogId: "00001", name: "NOAA 19" }),
          makeSatellite({ catalogId: "00002", name: "100% COVERAGE" }),
        ]);

        // A stray wildcard must match nothing, not everything.
        expect(await db.satellites.findMany({ search: "_" })).toHaveLength(0);
        // ...but a literal percent sign must still find the row containing one.
        expect(
          (await db.satellites.findMany({ search: "100%" })).map((r) => r.catalogId),
        ).toEqual(["00002"]);
      });

      it("paginates in a stable order", async () => {
        await db.satellites.upsertMany(
          ["00001", "00002", "00003", "00004", "00005"].map((catalogId) =>
            makeSatellite({ catalogId }),
          ),
        );

        const first = await db.satellites.findMany({ limit: 2 });
        const second = await db.satellites.findMany({ limit: 2, offset: 2 });
        const third = await db.satellites.findMany({ limit: 2, offset: 4 });

        expect(first.map((r) => r.catalogId)).toEqual(["00001", "00002"]);
        expect(second.map((r) => r.catalogId)).toEqual(["00003", "00004"]);
        expect(third.map((r) => r.catalogId)).toEqual(["00005"]);
      });

      it("accepts an empty batch", async () => {
        expect(await db.satellites.upsertMany([])).toBe(0);
      });
    });

    // ── orbital elements ─────────────────────────────────────────────────────

    describe("orbital elements", () => {
      beforeEach(async () => {
        // Elements reference a satellite, so the catalog is populated first. This
        // mirrors the ingestion order the worker uses.
        await db.satellites.upsertMany([
          makeSatellite({ catalogId: "25544" }),
          makeSatellite({ catalogId: "44713" }),
        ]);
      });

      it("round-trips an element set including its OMM payload", async () => {
        await db.elements.insertMany([
          makeElement({
            catalogId: "25544",
            epoch: at(0),
            retrievedAt: at(1),
            omm: { OBJECT_NAME: "ISS (ZARYA)", MEAN_MOTION: 15.5 },
            tleLine1: "1 25544U 98067A   26060.00000000  .00000000  00000-0  00000-0 0  9990",
            tleLine2: "2 25544  51.6400   0.0000 0006000   0.0000   0.0000 15.50000000    00",
          }),
        ]);

        const found = await db.elements.findLatest("25544");
        expect(found?.epoch.toISOString()).toBe(at(0).toISOString());
        // Epoch and retrieval time are distinct facts and must stay distinct.
        expect(found?.retrievedAt.toISOString()).toBe(at(1).toISOString());
        expect(found?.omm).toEqual({ OBJECT_NAME: "ISS (ZARYA)", MEAN_MOTION: 15.5 });
        expect(found?.tleLine1).toContain("1 25544U");
        expect(found?.meanMotion).toBeCloseTo(15.5, 9);
        expect(found?.eccentricity).toBeCloseTo(0.0006, 9);
        expect(found?.bstar).toBeCloseTo(0.00012, 9);
        expect(found?.format).toBe("OMM_JSON");
      });

      it("ignores a re-ingested element set with the same epoch", async () => {
        const record = makeElement({ catalogId: "25544", epoch: at(0) });

        expect(await db.elements.insertMany([record])).toEqual({
          inserted: 1,
          unchanged: 0,
        });
        // The normal outcome two hours later: upstream republished the same epoch.
        expect(await db.elements.insertMany([record])).toEqual({
          inserted: 0,
          unchanged: 1,
        });
        expect(await db.elements.findHistory("25544")).toHaveLength(1);
      });

      it("separates inserted from unchanged in a mixed batch", async () => {
        await db.elements.insertMany([makeElement({ catalogId: "25544", epoch: at(0) })]);

        expect(
          await db.elements.insertMany([
            makeElement({ catalogId: "25544", epoch: at(0) }),
            makeElement({ catalogId: "25544", epoch: at(2) }),
          ]),
        ).toEqual({ inserted: 1, unchanged: 1 });
      });

      it("keeps element sets from different providers for the same epoch", async () => {
        // The uniqueness rule is per provider: two sources describing the same epoch is
        // provenance, not duplication.
        expect(
          await db.elements.insertMany([
            makeElement({ catalogId: "25544", epoch: at(0), provider: "celestrak" }),
            makeElement({ catalogId: "25544", epoch: at(0), provider: "spacetrack" }),
          ]),
        ).toEqual({ inserted: 2, unchanged: 0 });
      });

      it("returns the newest element set from findLatest", async () => {
        await db.elements.insertMany([
          makeElement({ catalogId: "25544", epoch: at(0) }),
          makeElement({ catalogId: "25544", epoch: at(6) }),
          makeElement({ catalogId: "25544", epoch: at(3) }),
        ]);

        expect((await db.elements.findLatest("25544"))?.epoch.toISOString()).toBe(
          at(6).toISOString(),
        );
      });

      it("returns undefined from findLatest when nothing is stored", async () => {
        expect(await db.elements.findLatest("25544")).toBeUndefined();
      });

      it("batches the newest set per object in findLatestForMany", async () => {
        await db.elements.insertMany([
          makeElement({ catalogId: "25544", epoch: at(0) }),
          makeElement({ catalogId: "25544", epoch: at(4) }),
          makeElement({ catalogId: "44713", epoch: at(1) }),
        ]);

        const found = await db.elements.findLatestForMany(["25544", "44713", "00000"]);
        expect(found.size).toBe(2);
        expect(found.get("25544")?.epoch.toISOString()).toBe(at(4).toISOString());
        expect(found.get("44713")?.epoch.toISOString()).toBe(at(1).toISOString());
        expect(found.has("00000")).toBe(false);
      });

      it("returns an empty map for an empty id list", async () => {
        expect((await db.elements.findLatestForMany([])).size).toBe(0);
      });

      it("uses the set that was current at the replayed time, not a later one", async () => {
        // The heart of correct historical replay: propagating today's elements backwards
        // across an unmodelled manoeuvre produces an orbit the spacecraft was never in.
        await db.elements.insertMany([
          makeElement({ catalogId: "25544", epoch: at(0) }),
          makeElement({ catalogId: "25544", epoch: at(10) }),
          makeElement({ catalogId: "25544", epoch: at(20) }),
        ]);

        const replay = await db.elements.findForTime({
          catalogId: "25544",
          atOrBefore: at(15),
        });
        expect(replay?.epoch.toISOString()).toBe(at(10).toISOString());
      });

      it("returns undefined when no element set predates the replayed time", async () => {
        await db.elements.insertMany([makeElement({ catalogId: "25544", epoch: at(10) })]);

        // Deliberately no fallback to a later set. The caller decides whether backwards
        // propagation is acceptable; storage does not silently substitute.
        expect(
          await db.elements.findForTime({ catalogId: "25544", atOrBefore: at(5) }),
        ).toBeUndefined();
      });

      it("falls back to the newest set when findForTime is given no time", async () => {
        await db.elements.insertMany([
          makeElement({ catalogId: "25544", epoch: at(0) }),
          makeElement({ catalogId: "25544", epoch: at(9) }),
        ]);

        expect(
          (await db.elements.findForTime({ catalogId: "25544" }))?.epoch.toISOString(),
        ).toBe(at(9).toISOString());
      });

      it("returns history newest first, honouring since and limit", async () => {
        await db.elements.insertMany([
          makeElement({ catalogId: "25544", epoch: at(0) }),
          makeElement({ catalogId: "25544", epoch: at(5) }),
          makeElement({ catalogId: "25544", epoch: at(10) }),
        ]);

        const all = await db.elements.findHistory("25544");
        expect(all.map((row) => row.epoch.toISOString())).toEqual([
          at(10).toISOString(),
          at(5).toISOString(),
          at(0).toISOString(),
        ]);

        expect(await db.elements.findHistory("25544", { limit: 2 })).toHaveLength(2);

        const since = await db.elements.findHistory("25544", { since: at(5) });
        expect(since.map((row) => row.epoch.toISOString())).toEqual([
          at(10).toISOString(),
          at(5).toISOString(),
        ]);
      });

      it("returns one current set per object from findAllLatest", async () => {
        await db.elements.insertMany([
          makeElement({ catalogId: "25544", epoch: at(0) }),
          makeElement({ catalogId: "25544", epoch: at(7) }),
          makeElement({ catalogId: "44713", epoch: at(2) }),
        ]);

        const latest = await db.elements.findAllLatest();
        expect(latest).toHaveLength(2);
        expect(
          latest.find((row) => row.catalogId === "25544")?.epoch.toISOString(),
        ).toBe(at(7).toISOString());
      });

      it("omits decayed objects from findAllLatest by default", async () => {
        await db.satellites.upsertMany([
          makeSatellite({
            catalogId: "44713",
            decayDate: new Date("2025-01-01T00:00:00.000Z"),
          }),
        ]);
        await db.elements.insertMany([
          makeElement({ catalogId: "25544", epoch: at(0) }),
          makeElement({ catalogId: "44713", epoch: at(0) }),
        ]);

        expect((await db.elements.findAllLatest()).map((r) => r.catalogId)).toEqual([
          "25544",
        ]);
        expect(await db.elements.findAllLatest({ excludeDecayed: false })).toHaveLength(2);
      });

      it("applies satellite filters to findAllLatest", async () => {
        await db.satellites.upsertMany([
          makeSatellite({ catalogId: "44713", objectType: "DEBRIS" }),
        ]);
        await db.elements.insertMany([
          makeElement({ catalogId: "25544", epoch: at(0) }),
          makeElement({ catalogId: "44713", epoch: at(0) }),
        ]);

        expect(
          (await db.elements.findAllLatest({ objectTypes: ["DEBRIS"] })).map(
            (r) => r.catalogId,
          ),
        ).toEqual(["44713"]);
      });

      it("accepts an empty batch", async () => {
        expect(await db.elements.insertMany([])).toEqual({ inserted: 0, unchanged: 0 });
      });
    });

    // ── provider runs ────────────────────────────────────────────────────────

    describe("provider runs", () => {
      it("records a run as running, then records its outcome", async () => {
        const runId = await db.providerRuns.start("celestrak", "group-active");

        const running = (await db.providerRuns.latestRuns()).find((r) => r.id === runId);
        expect(running?.status).toBe("running");
        expect(running?.completedAt).toBeUndefined();

        await db.providerRuns.finish(runId, {
          status: "success",
          recordsFetched: 20_000,
          recordsInserted: 4,
          recordsUnchanged: 19_996,
          recordsRejected: 0,
        });

        const finished = (await db.providerRuns.latestRuns()).find((r) => r.id === runId);
        expect(finished?.status).toBe("success");
        expect(finished?.completedAt).toBeInstanceOf(Date);
        expect(finished?.recordsFetched).toBe(20_000);
        expect(finished?.recordsInserted).toBe(4);
        expect(finished?.recordsUnchanged).toBe(19_996);
      });

      it("preserves counts the outcome does not mention", async () => {
        const runId = await db.providerRuns.start("celestrak", "group-active");
        await db.providerRuns.finish(runId, { status: "partial", recordsFetched: 100 });
        await db.providerRuns.finish(runId, {
          status: "failed",
          errorSummary: "connection reset",
        });

        const run = (await db.providerRuns.latestRuns()).find((r) => r.id === runId);
        expect(run?.status).toBe("failed");
        // A later partial report must not zero out what an earlier one established.
        expect(run?.recordsFetched).toBe(100);
        expect(run?.errorSummary).toBe("connection reset");
      });

      it("reports one latest run per provider and resource", async () => {
        const first = await db.providerRuns.start("celestrak", "group-active");
        await db.providerRuns.finish(first, { status: "success" });
        const second = await db.providerRuns.start("celestrak", "group-active");
        await db.providerRuns.finish(second, { status: "failed" });
        const other = await db.providerRuns.start("celestrak", "satcat");
        await db.providerRuns.finish(other, { status: "success" });

        const latest = await db.providerRuns.latestRuns();
        expect(latest).toHaveLength(2);
        expect(latest.find((r) => r.resource === "group-active")?.id).toBe(second);
        expect(latest.find((r) => r.resource === "satcat")?.id).toBe(other);
      });

      it("reports the last successful run separately from the last run", async () => {
        const good = await db.providerRuns.start("celestrak", "group-active");
        await db.providerRuns.finish(good, { status: "success" });
        const bad = await db.providerRuns.start("celestrak", "group-active");
        await db.providerRuns.finish(bad, { status: "failed" });

        // The distinction that makes last-known-good auditable: the provider is failing
        // now, but there IS a good state and we can say when it was.
        expect(
          (await db.providerRuns.latestSuccessfulRun("celestrak", "group-active"))?.id,
        ).toBe(good);
      });

      it("counts a partial run as a last known good state", async () => {
        const partial = await db.providerRuns.start("celestrak", "group-active");
        await db.providerRuns.finish(partial, { status: "partial" });

        expect(
          (await db.providerRuns.latestSuccessfulRun("celestrak", "group-active"))?.id,
        ).toBe(partial);
      });

      it("returns undefined when a provider has never succeeded", async () => {
        const runId = await db.providerRuns.start("satnogs", "transmitters");
        await db.providerRuns.finish(runId, { status: "failed" });

        expect(
          await db.providerRuns.latestSuccessfulRun("satnogs", "transmitters"),
        ).toBeUndefined();
      });
    });

    // ── ingestion leases ─────────────────────────────────────────────────────

    describe("ingestion leases", () => {
      it("grants a lease to one holder and refuses the second", async () => {
        expect(await db.leases.acquire("celestrak:active", "worker-a", 60)).toBeDefined();
        expect(await db.leases.acquire("celestrak:active", "worker-b", 60)).toBeUndefined();
      });

      it("lets an expired lease be taken over", async () => {
        // A zero TTL expires immediately: a crashed worker must not block ingestion
        // forever, which is worse than a rare double run.
        await db.leases.acquire("celestrak:active", "worker-a", 0);
        expect(await db.leases.acquire("celestrak:active", "worker-b", 60)).toBeDefined();
      });

      it("renews only for the current holder", async () => {
        await db.leases.acquire("celestrak:active", "worker-a", 60);
        expect(await db.leases.renew("celestrak:active", "worker-a", 120)).toBe(true);
        // A worker that lost its lease must not be able to steal it back mid-ingest.
        expect(await db.leases.renew("celestrak:active", "worker-b", 120)).toBe(false);
      });

      it("does not renew a lease that was never held", async () => {
        expect(await db.leases.renew("celestrak:active", "worker-a", 60)).toBe(false);
      });

      it("releases only for the current holder", async () => {
        await db.leases.acquire("celestrak:active", "worker-a", 60);

        // A late worker must not be able to free somebody else's lease.
        await db.leases.release("celestrak:active", "worker-b");
        expect(await db.leases.acquire("celestrak:active", "worker-c", 60)).toBeUndefined();

        await db.leases.release("celestrak:active", "worker-a");
        expect(await db.leases.acquire("celestrak:active", "worker-c", 60)).toBeDefined();
      });

      it("keeps leases for different resources independent", async () => {
        await db.leases.acquire("celestrak:active", "worker-a", 60);
        expect(await db.leases.acquire("celestrak:satcat", "worker-a", 60)).toBeDefined();
      });
    });

    // ── liveness ─────────────────────────────────────────────────────────────

    it("reports a non-negative ping latency", async () => {
      expect(await db.ping()).toBeGreaterThanOrEqual(0);
    });
  });
}
