import { describe, expect, it } from "vitest";

import { InMemoryDatabase } from "./in-memory.js";
import type { OrbitalElementRecord, SatelliteRecord } from "./repositories.js";

const satellite = (over: Partial<SatelliteRecord> = {}): SatelliteRecord => ({
  catalogId: "25544",
  name: "ISS (ZARYA)",
  internationalDesignator: "1998-067A",
  objectType: "PAYLOAD",
  operationalStatus: "OPERATIONAL",
  owner: "ISS",
  launchDate: new Date("1998-11-20"),
  launchSite: "TTMTR",
  decayDate: undefined,
  periodMinutes: 92.9,
  inclinationDegrees: 51.64,
  apogeeKm: 420,
  perigeeKm: 415,
  rcsSquareMetres: 399.05,
  orbitClass: "LEO",
  metadata: {},
  sourceProvider: "celestrak",
  updatedAt: new Date("2026-08-31T12:00:00Z"),
  ...over,
});

const element = (
  epoch: string,
  over: Partial<Omit<OrbitalElementRecord, "id">> = {},
): Omit<OrbitalElementRecord, "id"> => ({
  catalogId: "25544",
  provider: "celestrak",
  format: "OMM_JSON",
  epoch: new Date(epoch),
  retrievedAt: new Date(epoch),
  omm: { OBJECT_NAME: "ISS (ZARYA)" },
  tleLine1: undefined,
  tleLine2: undefined,
  meanMotion: 15.49,
  eccentricity: 0.0002,
  inclination: 51.64,
  bstar: 0.000022,
  ...over,
});

describe("satellite repository", () => {
  it("upserts and reads back", async () => {
    const db = new InMemoryDatabase();
    expect(await db.satellites.upsertMany([satellite()])).toBe(1);
    expect((await db.satellites.findByCatalogId("25544"))?.name).toBe("ISS (ZARYA)");
  });

  it("reports only genuine changes on re-upsert", async () => {
    // Two hours after the last run almost nothing has changed. Reporting 20,000
    // updates every cycle would hide a stalled feed.
    const db = new InMemoryDatabase();
    await db.satellites.upsertMany([satellite()]);
    expect(await db.satellites.upsertMany([satellite()])).toBe(0);
    expect(await db.satellites.upsertMany([satellite({ name: "ISS (RENAMED)" })])).toBe(1);
  });

  it("excludes decayed objects by default", async () => {
    // A re-entered object must not appear on the live globe.
    const db = new InMemoryDatabase();
    await db.satellites.upsertMany([
      satellite(),
      satellite({ catalogId: "1", name: "SPUTNIK", decayDate: new Date("1958-01-04") }),
    ]);

    expect(await db.satellites.findMany({})).toHaveLength(1);
    expect(await db.satellites.findMany({ excludeDecayed: false })).toHaveLength(2);
  });

  it("filters by object type and orbit class", async () => {
    const db = new InMemoryDatabase();
    await db.satellites.upsertMany([
      satellite(),
      satellite({ catalogId: "99", objectType: "DEBRIS", orbitClass: "GEO" }),
    ]);

    expect(await db.satellites.findMany({ objectTypes: ["DEBRIS"] })).toHaveLength(1);
    expect(await db.satellites.findMany({ orbitClasses: ["LEO"] })).toHaveLength(1);
  });

  it("searches name, catalog id and designator", async () => {
    const db = new InMemoryDatabase();
    await db.satellites.upsertMany([satellite()]);

    expect(await db.satellites.findMany({ search: "zarya" })).toHaveLength(1);
    expect(await db.satellites.findMany({ search: "25544" })).toHaveLength(1);
    expect(await db.satellites.findMany({ search: "1998-067A" })).toHaveLength(1);
    expect(await db.satellites.findMany({ search: "hubble" })).toHaveLength(0);
  });

  it("paginates with a stable order", async () => {
    const db = new InMemoryDatabase();
    await db.satellites.upsertMany(
      Array.from({ length: 10 }, (_, i) => satellite({ catalogId: `1000${i}` })),
    );

    const first = await db.satellites.findMany({ limit: 4 });
    const second = await db.satellites.findMany({ limit: 4, offset: 4 });
    expect(first).toHaveLength(4);
    // Without a stable sort, pagination silently repeats or skips rows.
    expect(new Set([...first, ...second].map((r) => r.catalogId)).size).toBe(8);
  });
});

describe("orbital element repository", () => {
  it("appends history rather than overwriting", async () => {
    const db = new InMemoryDatabase();
    await db.satellites.upsertMany([satellite()]);
    await db.elements.insertMany([element("2026-08-29T00:00:00Z")]);
    await db.elements.insertMany([element("2026-08-30T00:00:00Z")]);

    expect(db.elementCount).toBe(2);
    expect((await db.elements.findLatest("25544"))?.epoch.toISOString()).toBe(
      "2026-08-30T00:00:00.000Z",
    );
  });

  it("treats a re-ingested element set as unchanged", async () => {
    // Mirrors the UNIQUE (catalog_id, provider, epoch) constraint.
    const db = new InMemoryDatabase();
    await db.elements.insertMany([element("2026-08-30T00:00:00Z")]);
    const second = await db.elements.insertMany([element("2026-08-30T00:00:00Z")]);

    expect(second).toEqual({ inserted: 0, unchanged: 1 });
    expect(db.elementCount).toBe(1);
  });

  it("selects the element set current at a past time", async () => {
    // The query that makes historical replay correct.
    const db = new InMemoryDatabase();
    await db.elements.insertMany([
      element("2026-08-01T00:00:00Z"),
      element("2026-08-15T00:00:00Z"),
      element("2026-08-29T00:00:00Z"),
    ]);

    const chosen = await db.elements.findForTime({
      catalogId: "25544",
      atOrBefore: new Date("2026-08-20T00:00:00Z"),
    });
    expect(chosen?.epoch.toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });

  it("returns nothing rather than silently propagating backwards", async () => {
    // Choosing a later set would mean propagating backwards across a possible
    // manoeuvre. The caller decides whether that is acceptable, not the repository.
    const db = new InMemoryDatabase();
    await db.elements.insertMany([element("2026-08-29T00:00:00Z")]);

    const chosen = await db.elements.findForTime({
      catalogId: "25544",
      atOrBefore: new Date("2026-08-01T00:00:00Z"),
    });
    expect(chosen).toBeUndefined();
  });

  it("batches latest elements for many objects", async () => {
    const db = new InMemoryDatabase();
    await db.elements.insertMany([
      element("2026-08-29T00:00:00Z", { catalogId: "25544" }),
      element("2026-08-30T00:00:00Z", { catalogId: "25544" }),
      element("2026-08-30T00:00:00Z", { catalogId: "20580" }),
    ]);

    const found = await db.elements.findLatestForMany(["25544", "20580", "99999"]);
    expect(found.size).toBe(2);
    expect(found.get("25544")?.epoch.toISOString()).toBe("2026-08-30T00:00:00.000Z");
  });

  it("omits decayed objects from whole-catalog propagation", async () => {
    const db = new InMemoryDatabase();
    await db.satellites.upsertMany([
      satellite(),
      satellite({ catalogId: "1", decayDate: new Date("1958-01-04") }),
    ]);
    await db.elements.insertMany([
      element("2026-08-30T00:00:00Z", { catalogId: "25544" }),
      element("2026-08-30T00:00:00Z", { catalogId: "1" }),
    ]);

    expect(await db.elements.findAllLatest()).toHaveLength(1);
    expect(await db.elements.findAllLatest({ excludeDecayed: false })).toHaveLength(2);
  });

  it("returns history newest first", async () => {
    const db = new InMemoryDatabase();
    await db.elements.insertMany([
      element("2026-08-01T00:00:00Z"),
      element("2026-08-29T00:00:00Z"),
      element("2026-08-15T00:00:00Z"),
    ]);

    const history = await db.elements.findHistory("25544");
    expect(history.map((h) => h.epoch.toISOString())).toEqual([
      "2026-08-29T00:00:00.000Z",
      "2026-08-15T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ]);
  });
});

describe("retention", () => {
  const now = new Date("2026-08-31T12:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

  it("never deletes the newest set, however old", async () => {
    // Otherwise a long-dormant object would become unpropagable and vanish.
    const db = new InMemoryDatabase({ now: () => now });
    await db.elements.insertMany([element(daysAgo(900))]);

    expect(await db.elements.prune()).toBe(0);
    expect(db.elementCount).toBe(1);
  });

  it("keeps recent history at full resolution", async () => {
    const db = new InMemoryDatabase({ now: () => now });
    await db.elements.insertMany([
      element(daysAgo(0)),
      element(daysAgo(1)),
      element(daysAgo(2)),
    ]);

    expect(await db.elements.prune({ fullResolutionDays: 7 })).toBe(0);
    expect(db.elementCount).toBe(3);
  });

  it("thins older history to one set per day", async () => {
    const db = new InMemoryDatabase({ now: () => now });
    const base = now.getTime() - 30 * 86_400_000;
    await db.elements.insertMany([
      element(new Date(base).toISOString()),
      element(new Date(base + 3_600_000).toISOString()),
      element(new Date(base + 7_200_000).toISOString()),
      element(daysAgo(0)),
    ]);

    const deleted = await db.elements.prune({
      fullResolutionDays: 7,
      dailyResolutionDays: 365,
    });
    expect(deleted).toBe(2);
    expect(db.elementCount).toBe(2);
  });
});

describe("provider runs", () => {
  it("records a run lifecycle", async () => {
    const db = new InMemoryDatabase();
    const id = await db.providerRuns.start("celestrak-gp", "active");
    await db.providerRuns.finish(id, {
      status: "success",
      recordsFetched: 20_000,
      recordsInserted: 4,
      recordsUnchanged: 19_996,
    });

    const [run] = await db.providerRuns.latestRuns();
    expect(run?.status).toBe("success");
    // The healthy steady state: lots fetched, almost nothing new.
    expect(run?.recordsInserted).toBe(4);
    expect(run?.completedAt).toBeDefined();
  });

  it("finds the last known good run even after a failure", async () => {
    // This is what serving cached data during an outage actually rests on.
    const db = new InMemoryDatabase();
    const good = await db.providerRuns.start("celestrak-gp", "active");
    await db.providerRuns.finish(good, { status: "success", recordsFetched: 100 });

    const bad = await db.providerRuns.start("celestrak-gp", "active");
    await db.providerRuns.finish(bad, { status: "failed", errorSummary: "timeout" });

    const latest = await db.providerRuns.latestRuns();
    expect(latest[0]?.status).toBe("failed");

    const lastGood = await db.providerRuns.latestSuccessfulRun("celestrak-gp", "active");
    expect(lastGood?.id).toBe(good);
  });

  it("counts a partial run as last known good", async () => {
    const db = new InMemoryDatabase();
    const id = await db.providerRuns.start("celestrak-gp", "active");
    await db.providerRuns.finish(id, { status: "partial", recordsInserted: 10 });

    expect(
      await db.providerRuns.latestSuccessfulRun("celestrak-gp", "active"),
    ).toBeDefined();
  });
});

describe("ingestion leases", () => {
  it("lets only one holder acquire", async () => {
    const db = new InMemoryDatabase();
    expect(await db.leases.acquire("celestrak:active", "worker-a", 60)).toBeDefined();
    expect(await db.leases.acquire("celestrak:active", "worker-b", 60)).toBeUndefined();
  });

  it("frees an expired lease so a crashed worker cannot block forever", async () => {
    let now = new Date("2026-08-31T12:00:00Z");
    const db = new InMemoryDatabase({ now: () => now });

    await db.leases.acquire("celestrak:active", "worker-a", 60);
    now = new Date(now.getTime() + 61_000);

    expect(await db.leases.acquire("celestrak:active", "worker-b", 60)).toBeDefined();
  });

  it("only lets the holder renew or release", async () => {
    const db = new InMemoryDatabase();
    await db.leases.acquire("celestrak:active", "worker-a", 60);

    expect(await db.leases.renew("celestrak:active", "worker-b", 60)).toBe(false);
    await db.leases.release("celestrak:active", "worker-b");
    // Still held by worker-a.
    expect(await db.leases.acquire("celestrak:active", "worker-c", 60)).toBeUndefined();

    await db.leases.release("celestrak:active", "worker-a");
    expect(await db.leases.acquire("celestrak:active", "worker-c", 60)).toBeDefined();
  });
});
