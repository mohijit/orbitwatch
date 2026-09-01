import type { CatalogId } from "@orbitwatch/orbit-core";

import type {
  Database,
  ElementQuery,
  IngestionLeaseRepository,
  OrbitalElementRecord,
  OrbitalElementRepository,
  ProviderRunRecord,
  ProviderRunRepository,
  ProviderRunStatus,
  SatelliteFilter,
  SatelliteRecord,
  SatelliteRepository,
  SatelliteGroupMembership,
  SatelliteGroupRepository,
} from "./repositories.js";

/**
 * In-memory implementation of the storage interfaces.
 *
 * Not a mock of the production database — a real, complete implementation of the same
 * contract. That distinction matters: the ingestion pipeline, the API routes and the
 * retention policy are all exercised against this in tests, so their logic is verified
 * for real, and only the SQL translation remains to be proven against Postgres.
 *
 * It is also what lets development proceed before hosted credentials exist, without
 * anyone being tempted to fabricate data to fill the gap.
 *
 * NOT suitable for production: no durability, no cross-process visibility, and the
 * whole catalog lives in one process's heap.
 */
export class InMemoryDatabase implements Database {
  readonly satellites: SatelliteRepository;
  readonly elements: OrbitalElementRepository;
  readonly groups: SatelliteGroupRepository;
  readonly providerRuns: ProviderRunRepository;
  readonly leases: IngestionLeaseRepository;

  readonly #satellites = new Map<CatalogId, SatelliteRecord>();
  readonly #elements: OrbitalElementRecord[] = [];
  readonly #runs: ProviderRunRecord[] = [];
  readonly #leases = new Map<string, { holder: string; expiresAt: Date }>();
  /** Keyed `provider|group|catalogId`; none of the three can contain a pipe. */
  readonly #groups = new Map<string, SatelliteGroupMembership>();
  #nextId = 1;
  readonly #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
    this.satellites = this.#createSatelliteRepository();
    this.elements = this.#createElementRepository();
    this.groups = this.#createGroupRepository();
    this.providerRuns = this.#createProviderRunRepository();
    this.leases = this.#createLeaseRepository();
  }

  async migrate(): Promise<{ applied: readonly string[] }> {
    // Nothing to migrate: the schema is the TypeScript types.
    return { applied: [] };
  }

  async ping(): Promise<number> {
    return 0;
  }

  async close(): Promise<void> {
    // Nothing to release.
  }

  /** Test helper: how many element rows are stored. */
  get elementCount(): number {
    return this.#elements.length;
  }

  #createSatelliteRepository(): SatelliteRepository {
    const store = this.#satellites;

    return {
      async findByCatalogId(catalogId) {
        return store.get(catalogId);
      },
      async findMany(filter) {
        const all = [...store.values()].filter((record) =>
          matchesSatelliteFilter(record, filter),
        );
        // Stable ordering so pagination cannot repeat or skip rows.
        all.sort((a, b) => a.catalogId.localeCompare(b.catalogId));
        const offset = filter.offset ?? 0;
        const limit = filter.limit ?? all.length;
        return all.slice(offset, offset + limit);
      },
      async count(filter) {
        return [...store.values()].filter((record) =>
          matchesSatelliteFilter(record, filter),
        ).length;
      },
      async upsertMany(records) {
        let changed = 0;
        for (const record of records) {
          const existing = store.get(record.catalogId);
          // Only count a genuine change, so ingestion can report "4 of 20,000 changed"
          // rather than claiming it rewrote the catalog every run.
          if (existing === undefined || !sameSatellite(existing, record)) changed += 1;
          store.set(record.catalogId, record);
        }
        return changed;
      },
    };
  }

  #createElementRepository(): OrbitalElementRepository {
    const rows = this.#elements;
    const satellites = this.#satellites;
    const nextId = () => String(this.#nextId++);
    const now = this.#now;

    const latestFor = (catalogId: CatalogId): OrbitalElementRecord | undefined => {
      let best: OrbitalElementRecord | undefined;
      for (const row of rows) {
        if (row.catalogId !== catalogId) continue;
        if (best === undefined || row.epoch.getTime() > best.epoch.getTime()) best = row;
      }
      return best;
    };

    return {
      async findLatest(catalogId) {
        return latestFor(catalogId);
      },

      async findLatestForMany(catalogIds) {
        const result = new Map<CatalogId, OrbitalElementRecord>();
        const wanted = new Set(catalogIds);
        for (const row of rows) {
          if (!wanted.has(row.catalogId)) continue;
          const existing = result.get(row.catalogId);
          if (existing === undefined || row.epoch.getTime() > existing.epoch.getTime()) {
            result.set(row.catalogId, row);
          }
        }
        return result;
      },

      async findAllLatest(filter) {
        const byCatalog = new Map<CatalogId, OrbitalElementRecord>();
        for (const row of rows) {
          // The whole SatelliteFilter applies, not only excludeDecayed. A filter
          // parameter that silently ignores most of its fields is a trap: the caller
          // believes it narrowed the catalog and it did not.
          const satellite = satellites.get(row.catalogId);
          if (satellite === undefined) continue;
          if (!matchesSatelliteFilter(satellite, filter ?? {})) continue;

          const existing = byCatalog.get(row.catalogId);
          if (existing === undefined || row.epoch.getTime() > existing.epoch.getTime()) {
            byCatalog.set(row.catalogId, row);
          }
        }
        return [...byCatalog.values()];
      },

      async findForTime(query: ElementQuery) {
        if (query.atOrBefore === undefined) return latestFor(query.catalogId);

        const target = query.atOrBefore.getTime();
        let best: OrbitalElementRecord | undefined;
        for (const row of rows) {
          if (row.catalogId !== query.catalogId) continue;
          if (row.epoch.getTime() > target) continue;
          if (best === undefined || row.epoch.getTime() > best.epoch.getTime())
            best = row;
        }
        // Deliberately no fallback to a later set here. The caller decides whether
        // propagating backwards is acceptable, and orbit-core marks it down when it is.
        return best;
      },

      async findHistory(catalogId, options) {
        const since = options?.since?.getTime();
        const history = rows
          .filter(
            (row) =>
              row.catalogId === catalogId &&
              (since === undefined || row.epoch.getTime() >= since),
          )
          .sort((a, b) => b.epoch.getTime() - a.epoch.getTime());
        return options?.limit === undefined ? history : history.slice(0, options.limit);
      },

      async insertMany(records) {
        let inserted = 0;
        let unchanged = 0;

        for (const record of records) {
          // Mirrors the UNIQUE (catalog_id, provider, epoch) constraint: re-ingesting
          // an unchanged element set must be a no-op, not duplicate history.
          const duplicate = rows.some(
            (row) =>
              row.catalogId === record.catalogId &&
              row.provider === record.provider &&
              row.epoch.getTime() === record.epoch.getTime(),
          );
          if (duplicate) {
            unchanged += 1;
            continue;
          }
          rows.push({ ...record, id: nextId() });
          inserted += 1;
        }

        return { inserted, unchanged };
      },

      async prune(options) {
        const fullDays = options?.fullResolutionDays ?? 7;
        const dailyDays = options?.dailyResolutionDays ?? 365;
        const nowMs = now().getTime();
        const DAY_MS = 86_400_000;

        // Newest row per object. This one is never deleted, at any age, so an object
        // with long-stale elements stays propagable rather than vanishing.
        const newestIdByCatalog = new Map<CatalogId, OrbitalElementRecord>();
        for (const row of rows) {
          const incumbent = newestIdByCatalog.get(row.catalogId);
          if (
            incumbent === undefined ||
            row.epoch.getTime() > incumbent.epoch.getTime()
          ) {
            newestIdByCatalog.set(row.catalogId, row);
          }
        }

        // Within the daily-resolution window we keep the LAST row of each day, so walk
        // newest-first and remember the first id seen for each (object, day) bucket.
        const dayBucket = (row: OrbitalElementRecord): string =>
          `${row.catalogId}:${Math.floor(row.epoch.getTime() / DAY_MS)}`;

        const keeperIdForDay = new Map<string, string>();
        for (const row of [...rows].sort(
          (a, b) => b.epoch.getTime() - a.epoch.getTime(),
        )) {
          const bucket = dayBucket(row);
          if (!keeperIdForDay.has(bucket)) keeperIdForDay.set(bucket, row.id);
        }

        const survivors: OrbitalElementRecord[] = [];
        let deleted = 0;

        for (const row of rows) {
          const ageDays = (nowMs - row.epoch.getTime()) / DAY_MS;
          const isNewestForObject = newestIdByCatalog.get(row.catalogId)?.id === row.id;
          const isDayKeeper = keeperIdForDay.get(dayBucket(row)) === row.id;

          const keep =
            isNewestForObject ||
            // Recent history is kept in full.
            ageDays <= fullDays ||
            // Older than that, one set per day survives until the daily window ends.
            (ageDays <= dailyDays && isDayKeeper);

          if (keep) survivors.push(row);
          else deleted += 1;
        }

        rows.length = 0;
        rows.push(...survivors);
        return deleted;
      },
    };
  }

  #createProviderRunRepository(): ProviderRunRepository {
    const runs = this.#runs;
    const nextId = () => String(this.#nextId++);
    const now = this.#now;

    return {
      async start(provider, resource) {
        const id = nextId();
        runs.push({
          id,
          provider,
          resource,
          startedAt: now(),
          completedAt: undefined,
          status: "running",
          recordsFetched: 0,
          recordsInserted: 0,
          recordsUnchanged: 0,
          recordsRejected: 0,
          sourceTimestamp: undefined,
          errorSummary: undefined,
        });
        return id;
      },

      async finish(runId, outcome) {
        const index = runs.findIndex((run) => run.id === runId);
        if (index === -1) return;
        const existing = runs[index] as ProviderRunRecord;
        runs[index] = {
          ...existing,
          completedAt: now(),
          status: outcome.status,
          recordsFetched: outcome.recordsFetched ?? existing.recordsFetched,
          recordsInserted: outcome.recordsInserted ?? existing.recordsInserted,
          recordsUnchanged: outcome.recordsUnchanged ?? existing.recordsUnchanged,
          recordsRejected: outcome.recordsRejected ?? existing.recordsRejected,
          sourceTimestamp: outcome.sourceTimestamp ?? existing.sourceTimestamp,
          errorSummary: outcome.errorSummary ?? existing.errorSummary,
        };
      },

      async latestRuns() {
        const latest = new Map<string, ProviderRunRecord>();
        for (const run of runs) {
          const key = `${run.provider}:${run.resource}`;
          const existing = latest.get(key);
          if (existing === undefined || isLaterRun(run, existing)) latest.set(key, run);
        }
        return [...latest.values()];
      },

      async latestAttempt(provider, resource) {
        let best: ProviderRunRecord | undefined;
        for (const run of runs) {
          if (run.provider !== provider || run.resource !== resource) continue;
          // Only "skipped" proves no request was issued; everything else may have.
          if (run.status === "skipped") continue;
          if (best === undefined || isLaterRun(run, best)) best = run;
        }
        return best;
      },

      async latestSuccessfulRun(provider, resource) {
        let best: ProviderRunRecord | undefined;
        for (const run of runs) {
          if (run.provider !== provider || run.resource !== resource) continue;
          // "partial" counts: some data landed, so there IS a last known good state.
          if (run.status !== "success" && run.status !== "partial") continue;
          if (best === undefined || isLaterRun(run, best)) best = run;
        }
        return best;
      },
    };
  }

  #createGroupRepository(): SatelliteGroupRepository {
    const groups = this.#groups;
    const key = (provider: string, group: string, catalogId: string): string =>
      `${provider}|${group}|${catalogId}`;

    return {
      record: async (provider, groupName, catalogIds, seenAt) => {
        let added = 0;
        let refreshed = 0;
        for (const catalogId of catalogIds) {
          const composite = key(provider, groupName, catalogId);
          const existing = groups.get(composite);
          if (existing === undefined) {
            groups.set(composite, {
              catalogId,
              provider,
              groupName,
              firstSeenAt: seenAt,
              lastSeenAt: seenAt,
            });
            added += 1;
          } else {
            // firstSeenAt is never moved forward: it records when membership began.
            groups.set(composite, { ...existing, lastSeenAt: seenAt });
            refreshed += 1;
          }
        }
        return { added, refreshed };
      },

      members: async (provider, groupName, options = {}) => {
        const since = options.seenSince;
        return [...groups.values()]
          .filter(
            (member) =>
              member.provider === provider &&
              member.groupName === groupName &&
              (since === undefined || member.lastSeenAt.getTime() >= since.getTime()),
          )
          .sort((a, b) => (a.catalogId < b.catalogId ? -1 : a.catalogId > b.catalogId ? 1 : 0));
      },
    };
  }

  #createLeaseRepository(): IngestionLeaseRepository {
    const leases = this.#leases;
    const now = this.#now;

    return {
      async acquire(resourceKey, holder, ttlSeconds) {
        const existing = leases.get(resourceKey);
        const current = now();

        // An expired lease is free to take: the previous holder crashed, and blocking
        // ingestion forever because a worker died is worse than a rare double-run.
        if (existing !== undefined && existing.expiresAt.getTime() > current.getTime()) {
          return undefined;
        }

        const expiresAt = new Date(current.getTime() + ttlSeconds * 1000);
        leases.set(resourceKey, { holder, expiresAt });
        return { expiresAt };
      },

      async renew(resourceKey, holder, ttlSeconds) {
        const existing = leases.get(resourceKey);
        // Only the holder may renew; a worker whose lease already expired and was
        // taken by someone else must not be able to steal it back mid-ingest.
        if (existing === undefined || existing.holder !== holder) return false;
        leases.set(resourceKey, {
          holder,
          expiresAt: new Date(now().getTime() + ttlSeconds * 1000),
        });
        return true;
      },

      async release(resourceKey, holder) {
        const existing = leases.get(resourceKey);
        if (existing?.holder === holder) leases.delete(resourceKey);
      },
    };
  }
}

/**
 * Order two runs, newest first.
 *
 * Ties on startedAt are real: two runs can begin in the same millisecond, and in tests
 * they routinely do. Falling back to the monotonically increasing id makes the order
 * total and deterministic, mirroring `ORDER BY started_at DESC, id DESC` in SQL.
 * Without the tie-break, a failure immediately after a success can be reported as the
 * current state or not, depending on iteration order.
 */
function isLaterRun(candidate: ProviderRunRecord, incumbent: ProviderRunRecord): boolean {
  const difference = candidate.startedAt.getTime() - incumbent.startedAt.getTime();
  if (difference !== 0) return difference > 0;
  return Number(candidate.id) > Number(incumbent.id);
}

function sameSatellite(a: SatelliteRecord, b: SatelliteRecord): boolean {
  return (
    a.name === b.name &&
    a.objectType === b.objectType &&
    a.operationalStatus === b.operationalStatus &&
    a.owner === b.owner &&
    a.decayDate?.getTime() === b.decayDate?.getTime() &&
    a.orbitClass === b.orbitClass
  );
}

export type { ProviderRunStatus };

/**
 * Whether a satellite passes a filter.
 *
 * Shared by findMany, count and findAllLatest so the three cannot drift apart, and
 * mirrors the WHERE clause built in postgres.ts. The contract suite runs against both.
 */
function matchesSatelliteFilter(
  record: SatelliteRecord,
  filter: SatelliteFilter,
): boolean {
  if (filter.objectTypes && !filter.objectTypes.includes(record.objectType)) {
    return false;
  }
  if (
    filter.orbitClasses &&
    (record.orbitClass === undefined || !filter.orbitClasses.includes(record.orbitClass))
  ) {
    return false;
  }
  if (
    filter.owners &&
    (record.owner === undefined || !filter.owners.includes(record.owner))
  ) {
    return false;
  }
  // Decayed objects are excluded by default: they are no longer in orbit, and including
  // them by default would put re-entered debris on the live globe.
  if ((filter.excludeDecayed ?? true) && record.decayDate !== undefined) {
    return false;
  }
  if (filter.search !== undefined && filter.search.trim() !== "") {
    const needle = filter.search.trim().toLowerCase();
    // Each field is tested on its own rather than against a concatenation, so a search
    // term can never match by spanning the boundary between two unrelated fields.
    const fields = [
      record.name,
      record.catalogId,
      record.internationalDesignator ?? "",
      record.owner ?? "",
    ];
    if (!fields.some((field) => field.toLowerCase().includes(needle))) return false;
  }
  return true;
}
