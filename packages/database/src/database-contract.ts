import type { CatalogId } from "@orbitwatch/orbit-core";

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
          (await db.satellites.findMany({ objectTypes: ["DEBRIS"] })).map(
            (r) => r.catalogId,
          ),
        ).toEqual(["00002"]);

        expect(
          (await db.satellites.findMany({ owners: ["ESA"] })).map((r) => r.catalogId),
        ).toEqual(["00003"]);

        expect(
          (await db.satellites.findMany({ orbitClasses: ["GEO"] })).map(
            (r) => r.catalogId,
          ),
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
            tleLine1:
              "1 25544U 98067A   26060.00000000  .00000000  00000-0  00000-0 0  9990",
            tleLine2:
              "2 25544  51.6400   0.0000 0006000   0.0000   0.0000 15.50000000    00",
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
        await db.elements.insertMany([
          makeElement({ catalogId: "25544", epoch: at(10) }),
        ]);

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
        expect(latest.find((row) => row.catalogId === "25544")?.epoch.toISOString()).toBe(
          at(7).toISOString(),
        );
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
        expect(await db.elements.findAllLatest({ excludeDecayed: false })).toHaveLength(
          2,
        );
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

      it("counts a failed run as an upstream attempt", async () => {
        // The distinction that keeps us inside a provider's rate policy: a run that
        // fetched and then failed while storing HAS consumed the once-per-cycle budget.
        // Asking only "when did we last succeed?" would permit an immediate re-fetch.
        const runId = await db.providerRuns.start("celestrak-gp", "group-active");
        await db.providerRuns.finish(runId, { status: "failed" });

        expect((await db.providerRuns.latestAttempt("celestrak-gp", "group-active"))?.id).toBe(
          runId,
        );
        expect(
          await db.providerRuns.latestSuccessfulRun("celestrak-gp", "group-active"),
        ).toBeUndefined();
      });

      it("does not count a skipped run as an upstream attempt", async () => {
        // "skipped" is the only status that guarantees no request left the process, so
        // it must not push the next allowed fetch further out.
        const runId = await db.providerRuns.start("celestrak-gp", "group-active");
        await db.providerRuns.finish(runId, { status: "skipped" });

        expect(
          await db.providerRuns.latestAttempt("celestrak-gp", "group-active"),
        ).toBeUndefined();
      });

      it("counts a still-running run as an attempt", async () => {
        // Either a request is in flight or a worker crashed mid-run. Both must hold the
        // budget: losing one cycle of freshness beats risking an IP-level block.
        const runId = await db.providerRuns.start("celestrak-gp", "group-active");

        expect((await db.providerRuns.latestAttempt("celestrak-gp", "group-active"))?.id).toBe(
          runId,
        );
      });

      it("keeps attempts separate per resource", async () => {
        const runId = await db.providerRuns.start("celestrak-gp", "group-active");
        await db.providerRuns.finish(runId, { status: "success" });

        // Fetching the active group must not consume the budget for another group.
        expect(
          await db.providerRuns.latestAttempt("celestrak-gp", "group-starlink"),
        ).toBeUndefined();
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
        expect(
          await db.leases.acquire("celestrak:active", "worker-b", 60),
        ).toBeUndefined();
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
        expect(
          await db.leases.acquire("celestrak:active", "worker-c", 60),
        ).toBeUndefined();

        await db.leases.release("celestrak:active", "worker-a");
        expect(await db.leases.acquire("celestrak:active", "worker-c", 60)).toBeDefined();
      });

      it("keeps leases for different resources independent", async () => {
        await db.leases.acquire("celestrak:active", "worker-a", 60);
        expect(await db.leases.acquire("celestrak:satcat", "worker-a", 60)).toBeDefined();
      });
    });

    // ── group membership ─────────────────────────────────────────────────────

    describe("satellite groups", () => {
      beforeEach(async () => {
        await db.satellites.upsertMany([
          makeSatellite({ catalogId: "25544" }),
          makeSatellite({ catalogId: "20580" }),
          makeSatellite({ catalogId: "39084" }),
        ]);
      });

      it("records membership and reads it back", async () => {
        const result = await db.groups.record(
          "celestrak-gp",
          "visual",
          ["25544", "20580"],
          at(0),
        );
        expect(result).toEqual({ added: 2, refreshed: 0 });

        const members = await db.groups.members("celestrak-gp", "visual");
        expect(members.map((m) => m.catalogId)).toEqual(["20580", "25544"]);
      });

      it("refreshes lastSeenAt without moving firstSeenAt", async () => {
        await db.groups.record("celestrak-gp", "visual", ["25544"], at(0));
        const second = await db.groups.record("celestrak-gp", "visual", ["25544"], at(3));
        expect(second).toEqual({ added: 0, refreshed: 1 });

        // firstSeenAt is when membership BEGAN. Moving it forward on every run would
        // erase the only record of how long an object has been listed.
        const [member] = await db.groups.members("celestrak-gp", "visual");
        expect(member?.firstSeenAt.toISOString()).toBe(at(0).toISOString());
        expect(member?.lastSeenAt.toISOString()).toBe(at(3).toISOString());
      });

      it("finds objects that have dropped out of the group", async () => {
        await db.groups.record("celestrak-gp", "visual", ["25544", "20580"], at(0));
        // The next run lists only one of them: 20580 has left the group.
        await db.groups.record("celestrak-gp", "visual", ["25544"], at(2));

        // Unfiltered, the departed object is still on record -- that history is the
        // point of storing lastSeenAt rather than deleting rows.
        expect(await db.groups.members("celestrak-gp", "visual")).toHaveLength(2);

        // Filtered to the latest run, it is correctly gone. This is what stops a
        // no-longer-listed object being offered as a naked-eye target.
        const current = await db.groups.members("celestrak-gp", "visual", {
          seenSince: at(2),
        });
        expect(current.map((m) => m.catalogId)).toEqual(["25544"]);
      });

      it("keeps groups and providers separate", async () => {
        await db.groups.record("celestrak-gp", "visual", ["25544"], at(0));
        await db.groups.record("celestrak-gp", "stations", ["20580"], at(0));
        await db.groups.record("other-provider", "visual", ["39084"], at(0));

        expect(
          (await db.groups.members("celestrak-gp", "visual")).map((m) => m.catalogId),
        ).toEqual(["25544"]);
        expect(
          (await db.groups.members("celestrak-gp", "stations")).map((m) => m.catalogId),
        ).toEqual(["20580"]);
        expect(
          (await db.groups.members("other-provider", "visual")).map((m) => m.catalogId),
        ).toEqual(["39084"]);
      });

      it("treats an empty membership list as a no-op", async () => {
        expect(await db.groups.record("celestrak-gp", "visual", [], at(0))).toEqual({
          added: 0,
          refreshed: 0,
        });
      });
    });

// ── radio transmitters ───────────────────────────────────────────────────

    describe("radio transmitters", () => {
      const transmitter = (
        uuid: string,
        overrides: Partial<Parameters<typeof db.radio.upsertMany>[0][number]> = {},
      ) => ({
        uuid,
        provider: "satnogs-db",
        catalogId: "25544",
        satId: "XSKZ-5603-1870-9019-3066",
        description: "Mode V APRS",
        type: "Transceiver",
        status: "active",
        alive: true,
        uplinkLowHz: 145_825_000,
        uplinkHighHz: undefined,
        downlinkLowHz: 145_825_000,
        downlinkHighHz: undefined,
        mode: "AFSK",
        uplinkMode: "AFSK",
        baud: 1200,
        inverted: false,
        service: "Amateur",
        citation: "https://example.invalid/citation",
        updatedAt: at(-48),
        retrievedAt: at(-1),
        ...overrides,
      });

      it("stores and returns a transmitter for its satellite", async () => {
        expect(await db.radio.upsertMany([transmitter("a")])).toEqual({
          inserted: 1,
          updated: 0,
        });

        const found = await db.radio.forSatellite("25544" as CatalogId);
        expect(found).toHaveLength(1);
        expect(found[0]?.uuid).toBe("a");
        expect(found[0]?.downlinkLowHz).toBe(145_825_000);
        // Frequencies must come back as numbers. Postgres returns BIGINT as a string,
        // and a string here compares wrongly against every threshold downstream.
        expect(typeof found[0]?.downlinkLowHz).toBe("number");
        expect(found[0]?.baud).toBe(1200);
        expect(found[0]?.inverted).toBe(false);
      });

      it("updates rather than duplicates when the provider republishes one", async () => {
        await db.radio.upsertMany([transmitter("a")]);
        expect(
          await db.radio.upsertMany([transmitter("a", { description: "Mode V APRS (edited)" })]),
        ).toEqual({ inserted: 0, updated: 1 });

        const found = await db.radio.forSatellite("25544" as CatalogId);
        expect(found).toHaveLength(1);
        expect(found[0]?.description).toBe("Mode V APRS (edited)");
      });

      it("hides dead transmitters by default and returns them on request", async () => {
        await db.radio.upsertMany([
          transmitter("alive-one"),
          transmitter("dead-one", { alive: false, status: "inactive" }),
        ]);

        // A ground station wants what works now; the dead entry is history, not the
        // answer — but "this used to transmit on 145.8" is a real question, so it is
        // retained rather than deleted.
        expect((await db.radio.forSatellite("25544" as CatalogId)).map((t) => t.uuid)).toEqual([
          "alive-one",
        ]);
        expect(
          (await db.radio.forSatellite("25544" as CatalogId, { includeDead: true }))
            .map((t) => t.uuid)
            .sort(),
        ).toEqual(["alive-one", "dead-one"]);
      });

      it("orders by downlink frequency, so a band can be scanned for", async () => {
        await db.radio.upsertMany([
          transmitter("high", { downlinkLowHz: 437_550_000 }),
          transmitter("low", { downlinkLowHz: 145_800_000 }),
          transmitter("mid", { downlinkLowHz: 435_000_000 }),
        ]);
        expect((await db.radio.forSatellite("25544" as CatalogId)).map((t) => t.uuid)).toEqual([
          "low",
          "mid",
          "high",
        ]);
      });

      it("keeps a transmitter with no NORAD id rather than rejecting it", async () => {
        // SatNOGS carries pre-launch payloads and objects CelesTrak has dropped. A
        // foreign key would fail ingestion on exactly the records a ground station
        // most wants, so these are stored and simply not joined to a satellite.
        await db.radio.upsertMany([transmitter("orphan", { catalogId: undefined })]);
        expect(await db.radio.count()).toBe(1);
        expect(await db.radio.forSatellite("25544" as CatalogId)).toEqual([]);
      });

      it("separates transmitters belonging to different objects", async () => {
        await db.radio.upsertMany([
          transmitter("iss"),
          transmitter("other", { catalogId: "39084" }),
        ]);
        expect((await db.radio.forSatellite("25544" as CatalogId)).map((t) => t.uuid)).toEqual([
          "iss",
        ]);
        expect((await db.radio.forSatellite("39084" as CatalogId)).map((t) => t.uuid)).toEqual([
          "other",
        ]);
      });

      it("preserves the provider's own updated timestamp, distinct from retrieval", async () => {
        await db.radio.upsertMany([transmitter("a")]);
        const found = await db.radio.forSatellite("25544" as CatalogId);
        // Two different facts, and this product does not conflate them anywhere else
        // either: when SatNOGS last changed the record, versus when we asked.
        expect(found[0]?.updatedAt?.toISOString()).toBe(at(-48).toISOString());
        expect(found[0]?.retrievedAt.toISOString()).toBe(at(-1).toISOString());
      });

      it("treats an empty list as a no-op", async () => {
        expect(await db.radio.upsertMany([])).toEqual({ inserted: 0, updated: 0 });
      });
    });

// ── space weather ────────────────────────────────────────────────────────

    describe("space weather", () => {
      const kpAt = (hours: number, kp: number) => ({
        source: "planetary-k-index" as const,
        observedAt: at(hours),
        kp,
        aRunning: 9,
        solarWindSpeedKmS: undefined,
        solarWindDensity: undefined,
        bzNt: undefined,
        radioBlackoutScale: undefined,
        solarRadiationScale: undefined,
        geomagneticScale: undefined,
        retrievedAt: at(0),
      });

      it("stores an observation and reads back the latest", async () => {
        expect(await db.spaceWeather.record([kpAt(-6, 2.33), kpAt(-3, 4.67)])).toEqual({
          inserted: 2,
          updated: 0,
        });

        const latest = await db.spaceWeather.latest("planetary-k-index");
        expect(latest?.kp).toBe(4.67);
        expect(latest?.observedAt.toISOString()).toBe(at(-3).toISOString());
      });

      it("refreshes rather than duplicating a republished instant", async () => {
        // NOAA republishes overlapping windows on every poll, so the same instant
        // arriving twice is the normal case and not a conflict.
        await db.spaceWeather.record([kpAt(-3, 4.67)]);
        expect(await db.spaceWeather.record([kpAt(-3, 5.0)])).toEqual({
          inserted: 0,
          updated: 1,
        });
        expect((await db.spaceWeather.latest("planetary-k-index"))?.kp).toBe(5.0);
      });

      it("keeps sources apart", async () => {
        await db.spaceWeather.record([
          kpAt(-3, 4.67),
          {
            ...kpAt(-1, 0),
            source: "solar-wind" as const,
            kp: undefined,
            aRunning: undefined,
            solarWindSpeedKmS: 428.1,
            bzNt: -3.4,
          },
        ]);

        expect((await db.spaceWeather.latest("planetary-k-index"))?.kp).toBe(4.67);
        expect((await db.spaceWeather.latest("solar-wind"))?.solarWindSpeedKmS).toBe(428.1);
        // A source that reports no Kp stores no Kp, rather than a zero that would
        // average into a quiet reading.
        expect((await db.spaceWeather.latest("solar-wind"))?.kp).toBeUndefined();
      });

      it("returns a window oldest first, which is how it is plotted", async () => {
        await db.spaceWeather.record([kpAt(-12, 1), kpAt(-9, 2), kpAt(-6, 3), kpAt(-3, 4)]);

        const window = await db.spaceWeather.since("planetary-k-index", at(-9));
        expect(window.map((observation) => observation.kp)).toEqual([2, 3, 4]);
      });

      it("distinguishes the observed instant from the retrieval time", async () => {
        // Solar wind is additionally propagated from the spacecraft to Earth, so what a
        // sample DESCRIBES and when it was taken differ by about an hour.
        await db.spaceWeather.record([kpAt(-3, 4.67)]);
        const latest = await db.spaceWeather.latest("planetary-k-index");
        expect(latest?.observedAt.toISOString()).toBe(at(-3).toISOString());
        expect(latest?.retrievedAt.toISOString()).toBe(at(0).toISOString());
      });

      it("reports nothing stored rather than inventing quiet conditions", async () => {
        // A tracker that showed Kp 0 when it had no data would be claiming calm
        // conditions during a storm it simply had not fetched.
        expect(await db.spaceWeather.latest("scales")).toBeUndefined();
        expect(await db.spaceWeather.since("scales", at(-24))).toEqual([]);
      });

      it("treats an empty batch as a no-op", async () => {
        expect(await db.spaceWeather.record([])).toEqual({ inserted: 0, updated: 0 });
      });
    });

    // ── launches ─────────────────────────────────────────────────────────────

    describe("launches", () => {
      const launch = (id: string, hoursFromNow: number, overrides: Record<string, unknown> = {}) => ({
        id,
        provider: "launch-library",
        name: "Electron | Owl Around The World",
        net: at(hoursFromNow),
        netPrecision: "Minute",
        windowStart: at(hoursFromNow),
        windowEnd: at(hoursFromNow + 2),
        statusName: "Go for Launch",
        statusAbbrev: "Go",
        serviceProvider: "Rocket Lab",
        rocketName: "Electron",
        missionName: "StriX Launch 11",
        missionOrbit: "Low Earth Orbit",
        padName: "Launch Complex 1",
        padLocation: "Mahia Peninsula, New Zealand",
        padLatitude: -39.2611,
        padLongitude: 177.8649,
        webcastLive: false,
        retrievedAt: at(0),
        ...overrides,
      });

      it("stores a launch and returns it as upcoming", async () => {
        expect(await db.launches.upsertMany([launch("a", 6)])).toEqual({
          inserted: 1,
          updated: 0,
        });

        const upcoming = await db.launches.upcoming(at(0), 10);
        expect(upcoming).toHaveLength(1);
        expect(upcoming[0]?.name).toBe("Electron | Owl Around The World");
        expect(upcoming[0]?.rocketName).toBe("Electron");
        expect(upcoming[0]?.padLatitude).toBeCloseTo(-39.2611, 4);
      });

      it("keeps how precise the launch time actually is", async () => {
        // Launch Library sends a full ISO timestamp even for a launch known only to
        // the month. Without the precision beside it, the UI would render a
        // to-the-minute T-0 for something that might slip four weeks.
        await db.launches.upsertMany([
          launch("precise", 6),
          launch("vague", 800, { netPrecision: "Month" }),
          launch("unstated", 900, { netPrecision: undefined }),
        ]);

        const upcoming = await db.launches.upcoming(at(0), 10);
        const byId = new Map(upcoming.map((one) => [one.id, one]));
        expect(byId.get("precise")?.netPrecision).toBe("Minute");
        expect(byId.get("vague")?.netPrecision).toBe("Month");
        // Not stated is not the same as precise, and must not default to one.
        expect(byId.get("unstated")?.netPrecision).toBeUndefined();
      });

      it("treats a slipped launch as an update, not a new row", async () => {
        // Launches slip constantly and are republished under the same id.
        await db.launches.upsertMany([launch("a", 6)]);
        expect(
          await db.launches.upsertMany([
            launch("a", 30, { statusName: "To Be Determined", statusAbbrev: "TBD" }),
          ]),
        ).toEqual({ inserted: 0, updated: 1 });

        const upcoming = await db.launches.upcoming(at(0), 10);
        expect(upcoming).toHaveLength(1);
        expect(upcoming[0]?.net.toISOString()).toBe(at(30).toISOString());
        expect(upcoming[0]?.statusName).toBe("To Be Determined");
      });

      it("excludes launches whose time has passed", async () => {
        // Filtered on time rather than status: a launch that slipped into the past
        // without its status being updated is stale, and showing it is worse than
        // showing nothing.
        await db.launches.upsertMany([launch("past", -3), launch("future", 3)]);
        expect((await db.launches.upcoming(at(0), 10)).map((one) => one.id)).toEqual([
          "future",
        ]);
      });

      it("returns the soonest first and honours the limit", async () => {
        await db.launches.upsertMany([
          launch("third", 72),
          launch("first", 2),
          launch("second", 24),
        ]);

        expect((await db.launches.upcoming(at(0), 2)).map((one) => one.id)).toEqual([
          "first",
          "second",
        ]);
      });

      it("stores a pad with no coordinates rather than dropping the launch", async () => {
        // Plenty of pads have no usable position. The launch is still real.
        await db.launches.upsertMany([
          launch("a", 6, { padLatitude: undefined, padLongitude: undefined }),
        ]);
        const [stored] = await db.launches.upcoming(at(0), 10);
        expect(stored?.padLatitude).toBeUndefined();
        expect(stored?.padName).toBe("Launch Complex 1");
      });

      it("treats an empty batch as a no-op", async () => {
        expect(await db.launches.upsertMany([])).toEqual({ inserted: 0, updated: 0 });
      });
    });

    // ── ground stations ──────────────────────────────────────────────────────

    describe("ground stations", () => {
      const station = (id: string, overrides: Record<string, unknown> = {}) => ({
        id,
        provider: "satnogs-network",
        name: "Hackerspace.gr 1",
        latitude: 38.01697,
        longitude: 23.7314,
        altitudeM: 104,
        minHorizonDegrees: 40,
        status: "Online",
        bands: ["UHF"],
        observations: 10624,
        lastSeen: at(-2),
        retrievedAt: at(0),
        ...overrides,
      });

      it("stores a station and reads it back", async () => {
        expect(await db.stations.upsertMany([station("1")])).toEqual({
          inserted: 1,
          updated: 0,
        });

        const [stored] = await db.stations.list();
        expect(stored?.name).toBe("Hackerspace.gr 1");
        expect(stored?.latitude).toBeCloseTo(38.01697, 5);
        // The station's OWN horizon, not a global default: a site in a valley may not
        // observe below 40 degrees, so "above 10" is not the same question everywhere.
        expect(stored?.minHorizonDegrees).toBe(40);
      });

      it("round-trips the band array", async () => {
        // Postgres arrays are the part of this most likely to come back as a string.
        await db.stations.upsertMany([station("1", { bands: ["UHF", "VHF", "L"] })]);
        const [stored] = await db.stations.list();
        expect(Array.isArray(stored?.bands)).toBe(true);
        expect([...(stored?.bands ?? [])].sort()).toEqual(["L", "UHF", "VHF"]);
      });

      it("keeps a station with no bands rather than rejecting it", async () => {
        // A registered site not yet equipped is real.
        await db.stations.upsertMany([station("1", { bands: [] })]);
        const [stored] = await db.stations.list();
        expect(stored?.bands).toEqual([]);
      });

      it("stores offline stations too, and can count by status", async () => {
        // 4,119 of 4,452 in the real listing were Offline. Storing only the online ones
        // would make the data useless the next time a station comes back, and treating
        // the total as capacity would overstate coverage tenfold.
        await db.stations.upsertMany([
          station("1", { status: "Online" }),
          station("2", { status: "Offline" }),
          station("3", { status: "Offline" }),
          station("4", { status: "Testing" }),
        ]);

        expect(await db.stations.countByStatus()).toEqual({
          Online: 1,
          Offline: 2,
          Testing: 1,
        });
        expect((await db.stations.list({ status: "Online" })).map((one) => one.id)).toEqual([
          "1",
        ]);
      });

      it("orders by most recently heard from", async () => {
        await db.stations.upsertMany([
          station("stale", { lastSeen: at(-1000) }),
          station("fresh", { lastSeen: at(-1) }),
          station("never", { lastSeen: undefined }),
        ]);

        const ids = (await db.stations.list()).map((one) => one.id);
        expect(ids[0]).toBe("fresh");
        expect(ids[1]).toBe("stale");
        // A station that has never checked in sorts last rather than being dropped.
        expect(ids[2]).toBe("never");
      });

      it("updates a republished station rather than duplicating it", async () => {
        await db.stations.upsertMany([station("1")]);
        expect(
          await db.stations.upsertMany([station("1", { status: "Offline" })]),
        ).toEqual({ inserted: 0, updated: 1 });
        expect((await db.stations.list())[0]?.status).toBe("Offline");
      });

      it("treats an empty batch as a no-op", async () => {
        expect(await db.stations.upsertMany([])).toEqual({ inserted: 0, updated: 0 });
      });
    });

    // ── solar events ─────────────────────────────────────────────────────────

    describe("solar events", () => {
      const event = (id: string, hours: number, overrides: Record<string, unknown> = {}) => ({
        id,
        provider: "nasa-donki",
        type: "GST",
        knownType: true,
        issuedAt: at(hours),
        url: "https://example.invalid/donki/1",
        summary: "A geomagnetic storm was observed.",
        body: "## Message Type: Space Weather Notification - GST\n\nDetail.",
        retrievedAt: at(0),
        ...overrides,
      });

      it("stores an event and reads it back newest first", async () => {
        await db.solarEvents.upsertMany([
          event("old", -48),
          event("newest", -1),
          event("middle", -12),
        ]);

        expect((await db.solarEvents.recent()).map((one) => one.id)).toEqual([
          "newest",
          "middle",
          "old",
        ]);
      });

      it("keeps the narrative body verbatim", async () => {
        // DONKI bodies are prose whose layout varies by message type. Parsing them into
        // columns would be inventing structure NASA did not publish.
        await db.solarEvents.upsertMany([event("1", -1)]);
        const [stored] = await db.solarEvents.recent();
        expect(stored?.body).toContain("## Message Type");
        expect(stored?.summary).toBe("A geomagnetic storm was observed.");
      });

      it("stores a type it cannot explain rather than rejecting it", async () => {
        // NASA adds message types. A new one is a row this product cannot yet explain,
        // not an ingestion failure.
        await db.solarEvents.upsertMany([
          event("1", -1, { type: "XYZ", knownType: false }),
        ]);
        const [stored] = await db.solarEvents.recent();
        expect(stored?.type).toBe("XYZ");
        expect(stored?.knownType).toBe(false);
      });

      it("filters by type and by time", async () => {
        await db.solarEvents.upsertMany([
          event("storm", -2, { type: "GST" }),
          event("flare", -3, { type: "FLR" }),
          event("ancient", -500, { type: "GST" }),
        ]);

        expect((await db.solarEvents.recent({ types: ["GST"] })).map((one) => one.id)).toEqual([
          "storm",
          "ancient",
        ]);
        expect((await db.solarEvents.recent({ since: at(-24) })).map((one) => one.id)).toEqual([
          "storm",
          "flare",
        ]);
      });

      it("honours a limit", async () => {
        await db.solarEvents.upsertMany([event("a", -1), event("b", -2), event("c", -3)]);
        expect(await db.solarEvents.recent({ limit: 2 })).toHaveLength(2);
      });

      it("updates a republished event rather than duplicating it", async () => {
        await db.solarEvents.upsertMany([event("1", -1)]);
        expect(
          await db.solarEvents.upsertMany([event("1", -1, { summary: "Revised." })]),
        ).toEqual({ inserted: 0, updated: 1 });
        expect((await db.solarEvents.recent())[0]?.summary).toBe("Revised.");
      });

      it("treats an empty batch as a no-op", async () => {
        expect(await db.solarEvents.upsertMany([])).toEqual({ inserted: 0, updated: 0 });
      });
    });

    // ── liveness ─────────────────────────────────────────────────────────────

    it("reports a non-negative ping latency", async () => {
      expect(await db.ping()).toBeGreaterThanOrEqual(0);
    });
  });
}
