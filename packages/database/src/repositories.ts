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

export type ProviderRunStatus = "running" | "success" | "partial" | "failed" | "skipped";

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

  /**
   * Most recent run that may have issued an upstream request.
   *
   * Distinct from `latestSuccessfulRun`, and the difference is what keeps us inside a
   * provider's rate policy. A run that fetched successfully and then failed while
   * storing has still consumed the provider's once-per-cycle budget, so asking "when
   * did we last succeed?" would permit an immediate re-fetch and earn an HTTP 403.
   *
   * Only `skipped` guarantees no request was made, so every other status counts —
   * including `running`, which may be a request in flight or a crashed worker. Treating
   * a crashed run as having consumed the budget is the fail-closed direction: we lose
   * one cycle of freshness rather than risk an IP-level block.
   *
   * This is the durable, SHARED counterpart to the on-disk FetchGuard. The guard is
   * per-machine, which is worthless on ephemeral CI runners that start with an empty
   * disk every time; this survives because the database does.
   */
  latestAttempt(
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

/**
 * Membership of a provider-published group, e.g. CelesTrak's `visual`.
 *
 * `lastSeenAt` is the useful half: membership changes, and an object that has dropped
 * out of a group must stop being presented as one of its members.
 */
export interface SatelliteGroupMembership {
  readonly catalogId: CatalogId;
  readonly provider: string;
  readonly groupName: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

export interface SatelliteGroupRepository {
  /**
   * Record the full membership of a group as of one ingestion run.
   *
   * Takes the WHOLE list, not additions, because that is what the provider publishes
   * and it is the only way to notice a departure. `seenAt` is the run's fetch time
   * rather than now(), so a replayed or delayed run does not claim fresher knowledge
   * than it has.
   */
  record(
    provider: string,
    groupName: string,
    catalogIds: readonly CatalogId[],
    seenAt: Date,
  ): Promise<{ readonly added: number; readonly refreshed: number }>;

  /**
   * Members of a group, optionally only those still listed as of `since`.
   *
   * The filter is how a caller avoids offering an object that has silently left the
   * group: pass the start of the most recent successful run for that resource.
   */
  members(
    provider: string,
    groupName: string,
    options?: { readonly seenSince?: Date },
  ): Promise<readonly SatelliteGroupMembership[]>;
}

/** Everything the application needs from storage, in one place. */
/**
 * A radio transmitter, as the provider publishes it.
 *
 * Frequencies are in HERTZ, verbatim from the provider. No unit is converted on the way
 * in: a factor of a thousand is the classic silent error in radio data, and the safest
 * place for it not to happen is nowhere.
 */
export interface RadioTransmitter {
  readonly uuid: string;
  readonly provider: string;
  /** Undefined for SatNOGS entries with no NORAD id yet — pre-launch, mostly. */
  readonly catalogId: string | undefined;
  readonly satId: string | undefined;
  readonly description: string;
  readonly type: string | undefined;
  readonly status: string;
  /** The provider's own claim that this transmitter works. Distinct from `status`. */
  readonly alive: boolean;
  readonly uplinkLowHz: number | undefined;
  readonly uplinkHighHz: number | undefined;
  readonly downlinkLowHz: number | undefined;
  readonly downlinkHighHz: number | undefined;
  readonly mode: string | undefined;
  readonly uplinkMode: string | undefined;
  readonly baud: number | undefined;
  readonly inverted: boolean | undefined;
  readonly service: string | undefined;
  readonly citation: string | undefined;
  /** When the PROVIDER last changed it. Not when we fetched it. */
  readonly updatedAt: Date | undefined;
  readonly retrievedAt: Date;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

/** What an ingestion supplies; the seen-at timestamps are the store's business. */
export type RadioTransmitterInput = Omit<RadioTransmitter, "firstSeenAt" | "lastSeenAt">;

export interface RadioRepository {
  /**
   * Insert or update transmitters, keyed on the provider's UUID.
   *
   * Upsert rather than replace-all: SatNOGS is queried per satellite as well as in
   * bulk, and a per-satellite refresh must not delete every other object's
   * transmitters. Returns inserted/updated counts so an ingestion run can report what
   * actually changed rather than what it sent.
   */
  upsertMany(
    transmitters: readonly RadioTransmitterInput[],
  ): Promise<{ readonly inserted: number; readonly updated: number }>;

  /**
   * Transmitters for one object.
   *
   * `includeDead` defaults to false because a ground station wants what is working
   * now; the dead entries are history, not the answer. They remain retrievable rather
   * than deleted, since "this used to transmit on 145.8" is a real question.
   */
  forSatellite(
    catalogId: CatalogId,
    options?: { readonly includeDead?: boolean },
  ): Promise<readonly RadioTransmitter[]>;

  /** How many transmitters are stored, for /providers/status and diagnostics. */
  count(): Promise<number>;
}

/** Which NOAA product an observation came from. */
export type SpaceWeatherSource = "planetary-k-index" | "solar-wind" | "scales";

/**
 * One space weather observation.
 *
 * Every measurement is optional because the three NOAA products report different
 * quantities; a missing value means "this source does not publish that", which is a
 * fact rather than a gap.
 */
export interface SpaceWeatherObservation {
  readonly source: SpaceWeatherSource;
  /** The instant the observation DESCRIBES, not when it was fetched. */
  readonly observedAt: Date;
  readonly kp: number | undefined;
  readonly aRunning: number | undefined;
  readonly solarWindSpeedKmS: number | undefined;
  readonly solarWindDensity: number | undefined;
  readonly bzNt: number | undefined;
  readonly radioBlackoutScale: number | undefined;
  readonly solarRadiationScale: number | undefined;
  readonly geomagneticScale: number | undefined;
  readonly retrievedAt: Date;
}

export interface SpaceWeatherRepository {
  /**
   * Insert or refresh observations, keyed on (source, observedAt).
   *
   * Upsert rather than append: NOAA republishes overlapping windows on every poll, and
   * the same instant arriving twice is the normal case, not a conflict.
   */
  record(
    observations: readonly SpaceWeatherObservation[],
  ): Promise<{ readonly inserted: number; readonly updated: number }>;

  /** The most recent observation from a source, or undefined if none is stored. */
  latest(source: SpaceWeatherSource): Promise<SpaceWeatherObservation | undefined>;

  /**
   * Observations from a source at or after `since`, oldest first.
   *
   * Ascending because the only consumer plots them left to right, and reversing a
   * result set in the client is work the database has already done.
   */
  since(
    source: SpaceWeatherSource,
    since: Date,
  ): Promise<readonly SpaceWeatherObservation[]>;
}

export interface Database {
  readonly satellites: SatelliteRepository;
  readonly elements: OrbitalElementRepository;
  readonly groups: SatelliteGroupRepository;
  readonly radio: RadioRepository;
  readonly spaceWeather: SpaceWeatherRepository;
  readonly providerRuns: ProviderRunRepository;
  readonly leases: IngestionLeaseRepository;
  /** Run migrations. Safe to call repeatedly; already-applied ones are skipped. */
  migrate(): Promise<{ readonly applied: readonly string[] }>;
  /** Liveness check for /health. Returns round-trip latency in milliseconds. */
  ping(): Promise<number>;
  close(): Promise<void>;
}
