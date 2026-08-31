import type { CatalogId, ObjectType, OrbitClass } from "@orbitwatch/orbit-core";

/**
 * Data-access interfaces.
 *
 * Everything above this layer depends on these interfaces, never on the Postgres
 * driver. That is what keeps the API and worker testable without a database, and what
 * lets the storage engine change without touching business logic.
 *
 * The interfaces are deliberately narrow: they expose the queries OrbitWatch actually
 * makes, not a generic query builder. A repository that can express any query is a
 * database client with extra steps.
 */

export interface SatelliteRecord {
  readonly catalogId: CatalogId;
  readonly name: string;
  readonly internationalDesignator: string | undefined;
  readonly objectType: ObjectType;
  readonly operationalStatus: string | undefined;
  readonly owner: string | undefined;
  readonly launchDate: Date | undefined;
  readonly launchSite: string | undefined;
  readonly decayDate: Date | undefined;
  readonly periodMinutes: number | undefined;
  readonly inclinationDegrees: number | undefined;
  readonly apogeeKm: number | undefined;
  readonly perigeeKm: number | undefined;
  readonly rcsSquareMetres: number | undefined;
  readonly orbitClass: OrbitClass | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly sourceProvider: string;
  readonly updatedAt: Date;
}

/**
 * A stored element set.
 *
 * `epoch` and `retrievedAt` are both present and both matter: the UI must be able to
 * say "elements from 3 hours ago, retrieved 20 minutes ago", which is two facts.
 */
export interface OrbitalElementRecord {
  readonly id: string;
  readonly catalogId: CatalogId;
  readonly provider: string;
  readonly format: "OMM_JSON" | "TLE";
  readonly epoch: Date;
  readonly retrievedAt: Date;
  readonly omm: Readonly<Record<string, unknown>>;
  readonly tleLine1: string | undefined;
  readonly tleLine2: string | undefined;
  readonly meanMotion: number;
  readonly eccentricity: number;
  readonly inclination: number;
  readonly bstar: number | undefined;
}

export interface SatelliteFilter {
  readonly objectTypes?: readonly ObjectType[];
  readonly orbitClasses?: readonly OrbitClass[];
  readonly owners?: readonly string[];
  /** Exclude objects with a recorded decay date. Defaults to true. */
  readonly excludeDecayed?: boolean;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface SatelliteRepository {
  findByCatalogId(catalogId: CatalogId): Promise<SatelliteRecord | undefined>;
  findMany(filter: SatelliteFilter): Promise<readonly SatelliteRecord[]>;
  count(filter: SatelliteFilter): Promise<number>;
  /** Insert or update, returning how many rows actually changed. */
  upsertMany(records: readonly SatelliteRecord[]): Promise<number>;
}

export interface ElementQuery {
  readonly catalogId: CatalogId;
  /**
   * Return the most recent element set at or before this time.
   *
   * This is the query that makes historical replay correct: replaying a past moment
   * must use the elements that were current THEN, not today's elements propagated
   * backwards across an unmodelled manoeuvre.
   */
  readonly atOrBefore?: Date;
}

export interface OrbitalElementRepository {
  /** Newest element set for one object. The live-tracking query. */
  findLatest(catalogId: CatalogId): Promise<OrbitalElementRecord | undefined>;

  /**
   * Newest element sets for many objects in one round trip.
   *
   * Deliberately batched: the globe needs the whole catalog, and issuing 20,000
   * single-row queries would be the dominant cost of a page load.
   */
  findLatestForMany(
    catalogIds: readonly CatalogId[],
  ): Promise<ReadonlyMap<CatalogId, OrbitalElementRecord>>;

  /** Every current element set, for whole-catalog propagation. */
  findAllLatest(filter?: SatelliteFilter): Promise<readonly OrbitalElementRecord[]>;

  /** The element set that was current at a given time. Backs historical replay. */
  findForTime(query: ElementQuery): Promise<OrbitalElementRecord | undefined>;

  /** Stored history for one object, newest first. Backs the DATA tab and replay. */
  findHistory(
    catalogId: CatalogId,
    options?: { readonly since?: Date; readonly limit?: number },
  ): Promise<readonly OrbitalElementRecord[]>;

  /**
   * Append element sets, ignoring ones already stored.
   *
   * Returns inserted and unchanged counts separately: "we fetched 20,000 and 4 were
   * new" is the normal healthy outcome two hours after the last run, and reporting it
   * as "20,000 records processed" would hide a stalled upstream feed.
   */
  insertMany(
    records: readonly Omit<OrbitalElementRecord, "id">[],
  ): Promise<{ inserted: number; unchanged: number }>;

  /** Apply the retention policy. Returns rows deleted. */
  prune(options?: {
    readonly fullResolutionDays?: number;
    readonly dailyResolutionDays?: number;
  }): Promise<number>;
}

export type ProviderRunStatus =
  | "running"
  | "success"
  | "partial"
  | "failed"
  | "skipped";

export interface ProviderRunRecord {
  readonly id: string;
  readonly provider: string;
  readonly resource: string;
  readonly startedAt: Date;
  readonly completedAt: Date | undefined;
  readonly status: ProviderRunStatus;
  readonly recordsFetched: number;
  readonly recordsInserted: number;
  readonly recordsUnchanged: number;
  readonly recordsRejected: number;
  readonly sourceTimestamp: Date | undefined;
  readonly errorSummary: string | undefined;
}

export interface ProviderRunRepository {
  start(provider: string, resource: string): Promise<string>;
  finish(
    runId: string,
    outcome: {
      readonly status: ProviderRunStatus;
      readonly recordsFetched?: number;
      readonly recordsInserted?: number;
      readonly recordsUnchanged?: number;
      readonly recordsRejected?: number;
      readonly sourceTimestamp?: Date;
      readonly errorSummary?: string;
    },
  ): Promise<void>;
  /** Most recent run per provider/resource. Backs /providers/status. */
  latestRuns(): Promise<readonly ProviderRunRecord[]>;
  /**
   * Most recent SUCCESSFUL run, which is what "last known good" actually means.
   * A provider failing right now is healthy-ish if it succeeded 20 minutes ago and
   * badly degraded if it last succeeded three days ago.
   */
  latestSuccessfulRun(
    provider: string,
    resource: string,
  ): Promise<ProviderRunRecord | undefined>;
}

/**
 * Cooperative ingestion lease.
 *
 * The persistent FetchGuard stops us over-fetching a provider. This stops two workers
 * writing the same ingest concurrently — a different failure, needing a different
 * mechanism, because the guard is per-machine and this is per-database.
 */
export interface IngestionLeaseRepository {
  /**
   * Try to acquire a lease. Returns undefined when another holder has it.
   * Leases expire so a crashed worker cannot block ingestion forever.
   */
  acquire(
    resourceKey: string,
    holder: string,
    ttlSeconds: number,
  ): Promise<{ readonly expiresAt: Date } | undefined>;
  /** Extend a held lease during a long ingest. */
  renew(resourceKey: string, holder: string, ttlSeconds: number): Promise<boolean>;
  /** Release early. Only the holder may release, so a late worker cannot free it. */
  release(resourceKey: string, holder: string): Promise<void>;
}

/** Everything the application needs from storage, in one place. */
export interface Database {
  readonly satellites: SatelliteRepository;
  readonly elements: OrbitalElementRepository;
  readonly providerRuns: ProviderRunRepository;
  readonly leases: IngestionLeaseRepository;
  /** Run migrations. Safe to call repeatedly; already-applied ones are skipped. */
  migrate(): Promise<{ readonly applied: readonly string[] }>;
  /** Liveness check for /health. Returns round-trip latency in milliseconds. */
  ping(): Promise<number>;
  close(): Promise<void>;
}
