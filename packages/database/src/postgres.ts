import type { CatalogId, ObjectType, OrbitClass } from "@orbitwatch/orbit-core";
import postgres from "postgres";

import { migrationConnectionString, type DatabaseConfig } from "./config.js";
import { runMigrations } from "./migrator.js";
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
  RadioRepository,
  RadioTransmitter,
  SatelliteGroupRepository,
  SpaceWeatherObservation,
  SpaceWeatherRepository,
} from "./repositories.js";

/**
 * Postgres implementation of the storage contract.
 *
 * The behaviour of this file is defined by `database-contract.ts`, which
 * `InMemoryDatabase` also satisfies. Two implementations of one executable
 * specification is the point: business logic is tested at speed against the in-memory
 * one, and this file only has to prove that the SQL translation agrees.
 *
 * Conventions:
 *   * `undefined` maps to SQL NULL in both directions. The repositories never surface
 *     `null`, so callers deal with one absent value rather than two.
 *   * Every timestamp column is TIMESTAMPTZ and every Date is UTC. No local time is
 *     constructed anywhere in this layer.
 *   * Batched writes are chunked. A 20,000-object catalog in a single statement would
 *     exceed the wire protocol's parameter limit.
 */

type Sql = ReturnType<typeof postgres>;

/** A composable piece of SQL produced by the tagged template. */
type Fragment = ReturnType<Sql>;

/** Rows per write statement. Keeps parameter counts and lock durations bounded. */
const WRITE_CHUNK_SIZE = 500;

/** The parameter type postgres.js accepts for a JSON value. */
type JsonParameter = Parameters<Sql["json"]>[0];

/**
 * Widen a row array for `sql.json`.
 *
 * postgres.js types its JSON parameter as an index-signature object, which a precise
 * object-literal type does not satisfy even though it is plain JSON at runtime. The
 * cast is confined to this one place rather than repeated at every call site.
 */
function jsonRows(rows: readonly Record<string, unknown>[]): JsonParameter {
  return rows as unknown as JsonParameter;
}

/** Escape character for ILIKE patterns. Not a backslash, so nothing depends on the
 *  server's `standard_conforming_strings` setting. */
const LIKE_ESCAPE = "!";

/** Column lists live in one place so the SELECTs and the mappers cannot drift apart. */
const ELEMENT_COLUMNS = `id, catalog_id, provider, format, epoch, retrieved_at, omm,
  tle_line_1, tle_line_2, mean_motion, eccentricity, inclination, bstar`;

const SATELLITE_COLUMNS = `catalog_id, name, international_designator, object_type,
  operational_status, owner, launch_date, launch_site, decay_date, period_minutes,
  inclination_degrees, apogee_km, perigee_km, rcs_square_metres, orbit_class, metadata,
  source_provider, updated_at`;

const PROVIDER_RUN_COLUMNS = `id, provider, resource, started_at, completed_at, status,
  records_fetched, records_inserted, records_unchanged, records_rejected,
  source_timestamp, error_summary`;

// ── mapping helpers ──────────────────────────────────────────────────────────────

/**
 * Coerce a driver value to a Date.
 *
 * The driver returns TIMESTAMPTZ as a Date, and DATE as either a Date or a string
 * depending on version and type-parser configuration. Handling both costs three lines
 * and removes a class of bug that would appear in exactly one environment.
 */
function toDate(value: unknown): Date | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

function requireDate(value: unknown, column: string): Date {
  const parsed = toDate(value);
  if (parsed === undefined) {
    throw new TypeError(`Column "${column}" was expected to hold a timestamp`);
  }
  return parsed;
}

function toOptionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toNumber(value: unknown, column: string): number {
  const parsed = toOptionalNumber(value);
  if (parsed === undefined) {
    throw new TypeError(`Column "${column}" was expected to be numeric`);
  }
  return parsed;
}

/**
 * Render a DATE parameter.
 *
 * launch_date and decay_date are calendar dates, not instants. Sending the full ISO
 * timestamp would let the server's timezone shift the stored day by one.
 */
function toDateOnly(value: Date | undefined): string | undefined {
  return value === undefined ? undefined : value.toISOString().slice(0, 10);
}

function mapSatellite(row: Record<string, unknown>): SatelliteRecord {
  return {
    catalogId: String(row["catalog_id"]) as CatalogId,
    name: String(row["name"]),
    internationalDesignator: toOptionalString(row["international_designator"]),
    objectType: String(row["object_type"]) as ObjectType,
    operationalStatus: toOptionalString(row["operational_status"]),
    owner: toOptionalString(row["owner"]),
    launchDate: toDate(row["launch_date"]),
    launchSite: toOptionalString(row["launch_site"]),
    decayDate: toDate(row["decay_date"]),
    periodMinutes: toOptionalNumber(row["period_minutes"]),
    inclinationDegrees: toOptionalNumber(row["inclination_degrees"]),
    apogeeKm: toOptionalNumber(row["apogee_km"]),
    perigeeKm: toOptionalNumber(row["perigee_km"]),
    rcsSquareMetres: toOptionalNumber(row["rcs_square_metres"]),
    orbitClass: toOptionalString(row["orbit_class"]) as OrbitClass | undefined,
    metadata: (row["metadata"] ?? {}) as Readonly<Record<string, unknown>>,
    sourceProvider: String(row["source_provider"]),
    updatedAt: requireDate(row["updated_at"], "updated_at"),
  };
}

function mapElement(row: Record<string, unknown>): OrbitalElementRecord {
  return {
    id: String(row["id"]),
    catalogId: String(row["catalog_id"]) as CatalogId,
    provider: String(row["provider"]),
    format: String(row["format"]) as "OMM_JSON" | "TLE",
    epoch: requireDate(row["epoch"], "epoch"),
    retrievedAt: requireDate(row["retrieved_at"], "retrieved_at"),
    omm: (row["omm"] ?? {}) as Readonly<Record<string, unknown>>,
    tleLine1: toOptionalString(row["tle_line_1"]),
    tleLine2: toOptionalString(row["tle_line_2"]),
    meanMotion: toNumber(row["mean_motion"], "mean_motion"),
    eccentricity: toNumber(row["eccentricity"], "eccentricity"),
    inclination: toNumber(row["inclination"], "inclination"),
    bstar: toOptionalNumber(row["bstar"]),
  };
}

function mapProviderRun(row: Record<string, unknown>): ProviderRunRecord {
  return {
    id: String(row["id"]),
    provider: String(row["provider"]),
    resource: String(row["resource"]),
    startedAt: requireDate(row["started_at"], "started_at"),
    completedAt: toDate(row["completed_at"]),
    status: String(row["status"]) as ProviderRunStatus,
    recordsFetched: toNumber(row["records_fetched"], "records_fetched"),
    recordsInserted: toNumber(row["records_inserted"], "records_inserted"),
    recordsUnchanged: toNumber(row["records_unchanged"], "records_unchanged"),
    recordsRejected: toNumber(row["records_rejected"], "records_rejected"),
    sourceTimestamp: toDate(row["source_timestamp"]),
    errorSummary: toOptionalString(row["error_summary"]),
  };
}

/**
 * Escape ILIKE metacharacters in user-supplied search text.
 *
 * Without this, searching for `_` matches every single-character name and searching for
 * `%` matches the whole catalog. A user who types a wildcard by accident should get no
 * results, not all of them.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[!%_]/g, (char) => `${LIKE_ESCAPE}${char}`);
}

function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

// ── database ─────────────────────────────────────────────────────────────────────

export class PostgresDatabase implements Database {
  readonly satellites: SatelliteRepository;
  readonly elements: OrbitalElementRepository;
  readonly groups: SatelliteGroupRepository;
  readonly radio: RadioRepository;
  readonly spaceWeather: SpaceWeatherRepository;
  readonly providerRuns: ProviderRunRepository;
  readonly leases: IngestionLeaseRepository;

  readonly #sql: Sql;
  readonly #config: DatabaseConfig;

  constructor(sql: Sql, config: DatabaseConfig) {
    this.#sql = sql;
    this.#config = config;
    this.satellites = createSatelliteRepository(sql);
    this.elements = createElementRepository(sql);
    this.groups = createGroupRepository(sql);
    this.radio = createRadioRepository(sql);
    this.spaceWeather = createSpaceWeatherRepository(sql);
    this.providerRuns = createProviderRunRepository(sql);
    this.leases = createLeaseRepository(sql);
  }

  /**
   * Apply migrations over a separate SESSION connection.
   *
   * The pooled connection this class normally uses may be a transaction pooler, which
   * supports neither DDL nor advisory locks. Opening the direct connection only for
   * migrations keeps the hot path pooled without breaking the migration path.
   */
  async migrate(): Promise<{ applied: readonly string[] }> {
    const result = await runMigrations(migrationConnectionString(this.#config), {
      ssl: this.#config.DATABASE_SSL,
    });
    return { applied: result.applied };
  }

  async ping(): Promise<number> {
    const started = Date.now();
    await this.#sql`SELECT 1`;
    return Date.now() - started;
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 10 });
  }
}

/**
 * Open a pooled connection and build the repositories.
 *
 * Does not migrate, and does not connect eagerly — the driver connects lazily, so
 * constructing this cannot fail because of a transient network problem at boot.
 */
export function createPostgresDatabase(config: DatabaseConfig): PostgresDatabase {
  const sql = postgres(config.DATABASE_URL, {
    max: config.DATABASE_POOL_MAX,
    ssl: config.DATABASE_SSL ? "require" : false,
    idle_timeout: 30,
    connect_timeout: 30,
    // One slow query must not pin a pooled connection indefinitely.
    connection: { statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS },
    onnotice: () => undefined,
  });
  return new PostgresDatabase(sql, config);
}

// ── satellites ───────────────────────────────────────────────────────────────────

function createSatelliteRepository(sql: Sql): SatelliteRepository {
  /**
   * Build a WHERE clause from a filter.
   *
   * Composed from parameterised fragments rather than string concatenation, so a search
   * term can never become SQL.
   */
  const buildWhere = (filter: SatelliteFilter, prefix = ""): Fragment => {
    const column = (name: string) => sql.unsafe(`${prefix}${name}`);
    const conditions: Fragment[] = [];

    if (filter.objectTypes !== undefined) {
      conditions.push(
        sql`${column("object_type")} = ANY(${sql.array([...filter.objectTypes])})`,
      );
    }
    if (filter.orbitClasses !== undefined) {
      conditions.push(
        sql`${column("orbit_class")} = ANY(${sql.array([...filter.orbitClasses])})`,
      );
    }
    if (filter.owners !== undefined) {
      conditions.push(sql`${column("owner")} = ANY(${sql.array([...filter.owners])})`);
    }
    // Decayed objects are excluded by default: they are no longer in orbit, and putting
    // re-entered debris on a live globe would simply be wrong.
    if (filter.excludeDecayed ?? true) {
      conditions.push(sql`${column("decay_date")} IS NULL`);
    }
    if (filter.search !== undefined && filter.search.trim() !== "") {
      // Substring, case-insensitive, over the same fields the in-memory implementation
      // searches. ILIKE cannot use the tsvector index, which is a deliberate trade:
      // matching "star" inside "STARLINK-1234" is what users expect, and full-text
      // search only matches whole lexemes.
      const pattern = `%${escapeLikePattern(filter.search.trim())}%`;
      conditions.push(sql`(
        ${column("name")} ILIKE ${pattern} ESCAPE ${LIKE_ESCAPE}
        OR ${column("catalog_id")} ILIKE ${pattern} ESCAPE ${LIKE_ESCAPE}
        OR coalesce(${column("international_designator")}, '') ILIKE ${pattern} ESCAPE ${LIKE_ESCAPE}
        OR coalesce(${column("owner")}, '') ILIKE ${pattern} ESCAPE ${LIKE_ESCAPE}
      )`);
    }

    if (conditions.length === 0) return sql`TRUE`;
    return conditions.reduce((left, right) => sql`${left} AND ${right}`);
  };

  return {
    async findByCatalogId(catalogId) {
      const rows = await sql.unsafe(
        `SELECT ${SATELLITE_COLUMNS} FROM satellites WHERE catalog_id = $1`,
        [catalogId],
      );
      const row = rows[0];
      return row === undefined ? undefined : mapSatellite(row as Record<string, unknown>);
    },

    async findMany(filter) {
      // COLLATE "C" gives byte-order sorting that is identical regardless of the
      // database's locale. Pagination whose order changes between environments silently
      // repeats and skips rows.
      const rows = await sql`
        SELECT ${sql.unsafe(SATELLITE_COLUMNS)}
        FROM satellites
        WHERE ${buildWhere(filter)}
        ORDER BY catalog_id COLLATE "C"
        LIMIT ${filter.limit ?? null}
        OFFSET ${filter.offset ?? 0}
      `;
      return rows.map((row) => mapSatellite(row as Record<string, unknown>));
    },

    async count(filter) {
      const rows = await sql<{ total: string }[]>`
        SELECT count(*) AS total FROM satellites WHERE ${buildWhere(filter)}
      `;
      return Number(rows[0]?.total ?? 0);
    },

    async upsertMany(records) {
      if (records.length === 0) return 0;

      let changed = 0;

      for (const batch of chunk(records, WRITE_CHUNK_SIZE)) {
        // NOT JSON.stringify: postgres.js encodes a json parameter itself, so passing a
        // pre-stringified value double-encodes it and the server receives a scalar
        // string rather than an array. sql.json() marks the value explicitly.
        const payload = sql.json(
          jsonRows(
            batch.map((record) => ({
              catalog_id: record.catalogId,
              name: record.name,
              international_designator: record.internationalDesignator ?? null,
              object_type: record.objectType,
              operational_status: record.operationalStatus ?? null,
              owner: record.owner ?? null,
              launch_date: toDateOnly(record.launchDate) ?? null,
              launch_site: record.launchSite ?? null,
              decay_date: toDateOnly(record.decayDate) ?? null,
              period_minutes: record.periodMinutes ?? null,
              inclination_degrees: record.inclinationDegrees ?? null,
              apogee_km: record.apogeeKm ?? null,
              perigee_km: record.perigeeKm ?? null,
              rcs_square_metres: record.rcsSquareMetres ?? null,
              orbit_class: record.orbitClass ?? null,
              metadata: record.metadata,
              source_provider: record.sourceProvider,
              updated_at: record.updatedAt.toISOString(),
            })),
          ),
        );

        // The `changed` CTE reads `satellites` in the same snapshot as the INSERT, so it
        // observes the PRE-upsert state. That is what makes "4 of 20,000 actually
        // changed" a true statement rather than a count of everything we wrote.
        //
        // The comparison covers the same fields the in-memory implementation compares,
        // because the two must agree on what "changed" means.
        const rows = await sql<{ total: string }[]>`
          WITH input AS (
            SELECT * FROM json_to_recordset(${payload}::json) AS x(
              catalog_id TEXT, name TEXT, international_designator TEXT,
              object_type TEXT, operational_status TEXT, owner TEXT,
              launch_date DATE, launch_site TEXT, decay_date DATE,
              period_minutes DOUBLE PRECISION, inclination_degrees DOUBLE PRECISION,
              apogee_km DOUBLE PRECISION, perigee_km DOUBLE PRECISION,
              rcs_square_metres DOUBLE PRECISION, orbit_class TEXT,
              metadata JSONB, source_provider TEXT, updated_at TIMESTAMPTZ
            )
          ),
          changed AS (
            SELECT count(*) AS total
            FROM input i
            LEFT JOIN satellites s ON s.catalog_id = i.catalog_id
            WHERE s.catalog_id IS NULL
               OR s.name               IS DISTINCT FROM i.name
               OR s.object_type        IS DISTINCT FROM i.object_type
               OR s.operational_status IS DISTINCT FROM i.operational_status
               OR s.owner              IS DISTINCT FROM i.owner
               OR s.decay_date         IS DISTINCT FROM i.decay_date
               OR s.orbit_class        IS DISTINCT FROM i.orbit_class
          ),
          upserted AS (
            INSERT INTO satellites (
              catalog_id, name, international_designator, object_type,
              operational_status, owner, launch_date, launch_site, decay_date,
              period_minutes, inclination_degrees, apogee_km, perigee_km,
              rcs_square_metres, orbit_class, metadata, source_provider, updated_at
            )
            SELECT catalog_id, name, international_designator, object_type,
                   operational_status, owner, launch_date, launch_site, decay_date,
                   period_minutes, inclination_degrees, apogee_km, perigee_km,
                   rcs_square_metres, orbit_class, coalesce(metadata, '{}'::jsonb),
                   source_provider, updated_at
            FROM input
            ON CONFLICT (catalog_id) DO UPDATE SET
              name                     = EXCLUDED.name,
              international_designator = EXCLUDED.international_designator,
              object_type              = EXCLUDED.object_type,
              operational_status       = EXCLUDED.operational_status,
              owner                    = EXCLUDED.owner,
              launch_date              = EXCLUDED.launch_date,
              launch_site              = EXCLUDED.launch_site,
              decay_date               = EXCLUDED.decay_date,
              period_minutes           = EXCLUDED.period_minutes,
              inclination_degrees      = EXCLUDED.inclination_degrees,
              apogee_km                = EXCLUDED.apogee_km,
              perigee_km               = EXCLUDED.perigee_km,
              rcs_square_metres        = EXCLUDED.rcs_square_metres,
              orbit_class              = EXCLUDED.orbit_class,
              metadata                 = EXCLUDED.metadata,
              source_provider          = EXCLUDED.source_provider,
              updated_at               = EXCLUDED.updated_at
            RETURNING catalog_id
          )
          SELECT (SELECT total FROM changed) AS total,
                 (SELECT count(*) FROM upserted) AS written
        `;

        changed += Number(rows[0]?.total ?? 0);
      }

      return changed;
    },
  };
}

// ── orbital elements ─────────────────────────────────────────────────────────────

function createElementRepository(sql: Sql): OrbitalElementRepository {
  return {
    async findLatest(catalogId) {
      const rows = await sql.unsafe(
        `SELECT ${ELEMENT_COLUMNS} FROM orbital_elements
         WHERE catalog_id = $1 ORDER BY epoch DESC LIMIT 1`,
        [catalogId],
      );
      const row = rows[0];
      return row === undefined ? undefined : mapElement(row as Record<string, unknown>);
    },

    async findLatestForMany(catalogIds) {
      const result = new Map<CatalogId, OrbitalElementRecord>();
      if (catalogIds.length === 0) return result;

      // DISTINCT ON returns the first row of each catalog_id group under this ORDER BY,
      // which is the newest epoch. One round trip for the whole catalog, which is the
      // entire reason this exists separately from findLatest.
      const rows = await sql`
        SELECT DISTINCT ON (catalog_id) ${sql.unsafe(ELEMENT_COLUMNS)}
        FROM orbital_elements
        WHERE catalog_id = ANY(${sql.array([...catalogIds])})
        ORDER BY catalog_id, epoch DESC
      `;
      for (const row of rows) {
        const record = mapElement(row as Record<string, unknown>);
        result.set(record.catalogId, record);
      }
      return result;
    },

    async findAllLatest(filter) {
      const conditions: Fragment[] = [];
      if (filter?.objectTypes !== undefined) {
        conditions.push(sql`s.object_type = ANY(${sql.array([...filter.objectTypes])})`);
      }
      if (filter?.orbitClasses !== undefined) {
        conditions.push(sql`s.orbit_class = ANY(${sql.array([...filter.orbitClasses])})`);
      }
      if (filter?.owners !== undefined) {
        conditions.push(sql`s.owner = ANY(${sql.array([...filter.owners])})`);
      }
      if (filter?.excludeDecayed ?? true) {
        conditions.push(sql`s.decay_date IS NULL`);
      }
      if (filter?.search !== undefined && filter.search.trim() !== "") {
        const pattern = `%${escapeLikePattern(filter.search.trim())}%`;
        conditions.push(sql`(
          s.name ILIKE ${pattern} ESCAPE ${LIKE_ESCAPE}
          OR s.catalog_id ILIKE ${pattern} ESCAPE ${LIKE_ESCAPE}
          OR coalesce(s.international_designator, '') ILIKE ${pattern} ESCAPE ${LIKE_ESCAPE}
          OR coalesce(s.owner, '') ILIKE ${pattern} ESCAPE ${LIKE_ESCAPE}
        )`);
      }
      const where =
        conditions.length === 0
          ? sql`TRUE`
          : conditions.reduce((left, right) => sql`${left} AND ${right}`);

      const rows = await sql`
        SELECT DISTINCT ON (e.catalog_id)
          e.id, e.catalog_id, e.provider, e.format, e.epoch, e.retrieved_at, e.omm,
          e.tle_line_1, e.tle_line_2, e.mean_motion, e.eccentricity, e.inclination,
          e.bstar
        FROM orbital_elements e
        JOIN satellites s ON s.catalog_id = e.catalog_id
        WHERE ${where}
        ORDER BY e.catalog_id, e.epoch DESC
      `;
      return rows.map((row) => mapElement(row as Record<string, unknown>));
    },

    async findForTime(query: ElementQuery) {
      // Deliberately no fallback to a later element set. Whether propagating backwards
      // is acceptable is the caller's decision, and orbit-core downgrades the confidence
      // classification when it happens.
      const rows = await sql.unsafe(
        `SELECT ${ELEMENT_COLUMNS} FROM orbital_elements
         WHERE catalog_id = $1
           AND ($2::timestamptz IS NULL OR epoch <= $2::timestamptz)
         ORDER BY epoch DESC LIMIT 1`,
        [query.catalogId, query.atOrBefore?.toISOString() ?? null],
      );
      const row = rows[0];
      return row === undefined ? undefined : mapElement(row as Record<string, unknown>);
    },

    async findHistory(catalogId, options) {
      const rows = await sql.unsafe(
        `SELECT ${ELEMENT_COLUMNS} FROM orbital_elements
         WHERE catalog_id = $1
           AND ($2::timestamptz IS NULL OR epoch >= $2::timestamptz)
         ORDER BY epoch DESC
         LIMIT $3`,
        [catalogId, options?.since?.toISOString() ?? null, options?.limit ?? null],
      );
      return rows.map((row) => mapElement(row as Record<string, unknown>));
    },

    async insertMany(records) {
      if (records.length === 0) return { inserted: 0, unchanged: 0 };

      let inserted = 0;

      for (const batch of chunk(records, WRITE_CHUNK_SIZE)) {
        // See upsertMany: sql.json() rather than JSON.stringify, or the parameter is
        // double-encoded and arrives as a scalar.
        const payload = sql.json(
          jsonRows(
            batch.map((record) => ({
              catalog_id: record.catalogId,
              provider: record.provider,
              format: record.format,
              epoch: record.epoch.toISOString(),
              retrieved_at: record.retrievedAt.toISOString(),
              omm: record.omm,
              tle_line_1: record.tleLine1 ?? null,
              tle_line_2: record.tleLine2 ?? null,
              mean_motion: record.meanMotion,
              eccentricity: record.eccentricity,
              inclination: record.inclination,
              bstar: record.bstar ?? null,
            })),
          ),
        );

        // DO NOTHING on the (catalog_id, provider, epoch) unique constraint. Re-ingesting
        // an unchanged element set is the normal case two hours after the last run, and
        // must be a no-op rather than unbounded duplicate history.
        const rows = await sql<{ id: string }[]>`
          INSERT INTO orbital_elements (
            catalog_id, provider, format, epoch, retrieved_at, omm,
            tle_line_1, tle_line_2, mean_motion, eccentricity, inclination, bstar
          )
          SELECT catalog_id, provider, format, epoch, retrieved_at, omm,
                 tle_line_1, tle_line_2, mean_motion, eccentricity, inclination, bstar
          FROM json_to_recordset(${payload}::json) AS x(
            catalog_id TEXT, provider TEXT, format TEXT, epoch TIMESTAMPTZ,
            retrieved_at TIMESTAMPTZ, omm JSONB, tle_line_1 TEXT, tle_line_2 TEXT,
            mean_motion DOUBLE PRECISION, eccentricity DOUBLE PRECISION,
            inclination DOUBLE PRECISION, bstar DOUBLE PRECISION
          )
          ON CONFLICT (catalog_id, provider, epoch) DO NOTHING
          RETURNING id
        `;

        inserted += rows.length;
      }

      return { inserted, unchanged: records.length - inserted };
    },

    async prune(options) {
      const rows = await sql<{ deleted: number }[]>`
        SELECT prune_orbital_elements(
          ${options?.fullResolutionDays ?? 7}::integer,
          ${options?.dailyResolutionDays ?? 365}::integer
        ) AS deleted
      `;
      return Number(rows[0]?.deleted ?? 0);
    },
  };
}

// ── provider runs ────────────────────────────────────────────────────────────────

function createProviderRunRepository(sql: Sql): ProviderRunRepository {
  return {
    async start(provider, resource) {
      const rows = await sql<{ id: string }[]>`
        INSERT INTO provider_runs (provider, resource, status)
        VALUES (${provider}, ${resource}, 'running')
        RETURNING id
      `;
      const id = rows[0]?.id;
      if (id === undefined) {
        throw new Error("Failed to record the start of a provider run");
      }
      return String(id);
    },

    async finish(runId, outcome) {
      // coalesce preserves the existing value when the caller omits a count, matching
      // the in-memory implementation: a partial outcome report must not zero the rest.
      await sql`
        UPDATE provider_runs SET
          completed_at      = now(),
          status            = ${outcome.status},
          records_fetched   = coalesce(${outcome.recordsFetched ?? null}, records_fetched),
          records_inserted  = coalesce(${outcome.recordsInserted ?? null}, records_inserted),
          records_unchanged = coalesce(${outcome.recordsUnchanged ?? null}, records_unchanged),
          records_rejected  = coalesce(${outcome.recordsRejected ?? null}, records_rejected),
          source_timestamp  = coalesce(${outcome.sourceTimestamp ?? null}, source_timestamp),
          error_summary     = coalesce(${outcome.errorSummary ?? null}, error_summary)
        WHERE id = ${runId}::bigint
      `;
    },

    async latestRuns() {
      // The id tie-break matters: two runs can start in the same millisecond, and
      // without a total order the reported current state depends on scan order.
      const rows = await sql`
        SELECT DISTINCT ON (provider, resource) ${sql.unsafe(PROVIDER_RUN_COLUMNS)}
        FROM provider_runs
        ORDER BY provider, resource, started_at DESC, id DESC
      `;
      return rows.map((row) => mapProviderRun(row as Record<string, unknown>));
    },

    async latestAttempt(provider, resource) {
      // Everything except "skipped": see the interface for why a failed run still
      // counts against the provider's rate budget.
      const rows = await sql`
        SELECT ${sql.unsafe(PROVIDER_RUN_COLUMNS)}
        FROM provider_runs
        WHERE provider = ${provider} AND resource = ${resource}
          AND status <> 'skipped'
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      `;
      const row = rows[0];
      return row === undefined ? undefined : mapProviderRun(row as Record<string, unknown>);
    },

    async latestSuccessfulRun(provider, resource) {
      // "partial" counts as good: some data landed, so a last-known-good state exists.
      const rows = await sql`
        SELECT ${sql.unsafe(PROVIDER_RUN_COLUMNS)}
        FROM provider_runs
        WHERE provider = ${provider} AND resource = ${resource}
          AND status IN ('success', 'partial')
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      `;
      const row = rows[0];
      return row === undefined
        ? undefined
        : mapProviderRun(row as Record<string, unknown>);
    },
  };
}

// ── ingestion leases ─────────────────────────────────────────────────────────────

interface RadioRow {
  uuid: string;
  provider: string;
  norad_cat_id: string | null;
  sat_id: string | null;
  description: string;
  type: string | null;
  status: string;
  alive: boolean;
  uplink_low_hz: string | number | null;
  uplink_high_hz: string | number | null;
  downlink_low_hz: string | number | null;
  downlink_high_hz: string | number | null;
  mode: string | null;
  uplink_mode: string | null;
  baud: number | null;
  inverted: boolean | null;
  service: string | null;
  citation: string | null;
  updated_at: Date | null;
  retrieved_at: Date;
  first_seen_at: Date;
  last_seen_at: Date;
}

/**
 * BIGINT comes back from postgres.js as a STRING.
 *
 * That is correct of the driver — a 64-bit integer does not always survive a double —
 * and wrong for us if left alone, because `"145825000" > 146000000` compares a string
 * to a number and silently misbehaves. Frequencies fit comfortably in a double (24 GHz
 * is nine digits), so converting here is safe and keeps the rest of the codebase in
 * numbers.
 */
function toHertz(value: string | number | null): number | undefined {
  if (value === null) return undefined;
  const numeric = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(numeric) ? numeric : undefined;
}

function toTransmitter(row: RadioRow): RadioTransmitter {
  return {
    uuid: row.uuid,
    provider: row.provider,
    catalogId: row.norad_cat_id ?? undefined,
    satId: row.sat_id ?? undefined,
    description: row.description,
    type: row.type ?? undefined,
    status: row.status,
    alive: row.alive,
    uplinkLowHz: toHertz(row.uplink_low_hz),
    uplinkHighHz: toHertz(row.uplink_high_hz),
    downlinkLowHz: toHertz(row.downlink_low_hz),
    downlinkHighHz: toHertz(row.downlink_high_hz),
    mode: row.mode ?? undefined,
    uplinkMode: row.uplink_mode ?? undefined,
    baud: row.baud ?? undefined,
    inverted: row.inverted ?? undefined,
    service: row.service ?? undefined,
    citation: row.citation ?? undefined,
    updatedAt: row.updated_at ?? undefined,
    retrievedAt: row.retrieved_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function createRadioRepository(sql: Sql): RadioRepository {
  return {
    async upsertMany(transmitters) {
      if (transmitters.length === 0) return { inserted: 0, updated: 0 };

      let inserted = 0;
      let updated = 0;

      for (const batch of chunk(transmitters, WRITE_CHUNK_SIZE)) {
        const payload = sql.json(
          jsonRows(
            batch.map((transmitter) => ({
              uuid: transmitter.uuid,
              provider: transmitter.provider,
              norad_cat_id: transmitter.catalogId ?? null,
              sat_id: transmitter.satId ?? null,
              description: transmitter.description,
              type: transmitter.type ?? null,
              status: transmitter.status,
              alive: transmitter.alive,
              uplink_low_hz: transmitter.uplinkLowHz ?? null,
              uplink_high_hz: transmitter.uplinkHighHz ?? null,
              downlink_low_hz: transmitter.downlinkLowHz ?? null,
              downlink_high_hz: transmitter.downlinkHighHz ?? null,
              mode: transmitter.mode ?? null,
              uplink_mode: transmitter.uplinkMode ?? null,
              baud: transmitter.baud ?? null,
              inverted: transmitter.inverted ?? null,
              service: transmitter.service ?? null,
              citation: transmitter.citation ?? null,
              updated_at: transmitter.updatedAt?.toISOString() ?? null,
              retrieved_at: transmitter.retrievedAt.toISOString(),
            })),
          ),
        );

        // xmax = 0 distinguishes an insert from an update without a second round trip,
        // the same idiom the element and group writes use. first_seen_at is never
        // moved forward.
        const rows = await sql<{ inserted: boolean }[]>`
          INSERT INTO radio_transmitters (
            uuid, provider, norad_cat_id, sat_id, description, type, status, alive,
            uplink_low_hz, uplink_high_hz, downlink_low_hz, downlink_high_hz,
            mode, uplink_mode, baud, inverted, service, citation,
            updated_at, retrieved_at, first_seen_at, last_seen_at
          )
          SELECT
            i.uuid, i.provider, i.norad_cat_id, i.sat_id, i.description, i.type,
            i.status, i.alive,
            i.uplink_low_hz, i.uplink_high_hz, i.downlink_low_hz, i.downlink_high_hz,
            i.mode, i.uplink_mode, i.baud, i.inverted, i.service, i.citation,
            i.updated_at, i.retrieved_at, now(), now()
          FROM json_to_recordset(${payload}::json) AS i(
            uuid TEXT, provider TEXT, norad_cat_id TEXT, sat_id TEXT, description TEXT,
            type TEXT, status TEXT, alive BOOLEAN,
            uplink_low_hz BIGINT, uplink_high_hz BIGINT,
            downlink_low_hz BIGINT, downlink_high_hz BIGINT,
            mode TEXT, uplink_mode TEXT, baud DOUBLE PRECISION, inverted BOOLEAN,
            service TEXT, citation TEXT,
            updated_at TIMESTAMPTZ, retrieved_at TIMESTAMPTZ
          )
          ON CONFLICT (uuid) DO UPDATE SET
            provider = EXCLUDED.provider,
            norad_cat_id = EXCLUDED.norad_cat_id,
            sat_id = EXCLUDED.sat_id,
            description = EXCLUDED.description,
            type = EXCLUDED.type,
            status = EXCLUDED.status,
            alive = EXCLUDED.alive,
            uplink_low_hz = EXCLUDED.uplink_low_hz,
            uplink_high_hz = EXCLUDED.uplink_high_hz,
            downlink_low_hz = EXCLUDED.downlink_low_hz,
            downlink_high_hz = EXCLUDED.downlink_high_hz,
            mode = EXCLUDED.mode,
            uplink_mode = EXCLUDED.uplink_mode,
            baud = EXCLUDED.baud,
            inverted = EXCLUDED.inverted,
            service = EXCLUDED.service,
            citation = EXCLUDED.citation,
            updated_at = EXCLUDED.updated_at,
            retrieved_at = EXCLUDED.retrieved_at,
            last_seen_at = now()
          RETURNING (xmax = 0) AS inserted
        `;

        for (const row of rows) {
          if (row.inserted) inserted += 1;
          else updated += 1;
        }
      }

      return { inserted, updated };
    },

    async forSatellite(catalogId, options = {}) {
      const rows = await sql<RadioRow[]>`
        SELECT * FROM radio_transmitters
        WHERE norad_cat_id = ${catalogId}
          ${options.includeDead === true ? sql`` : sql`AND alive = TRUE`}
        ORDER BY downlink_low_hz NULLS LAST, uuid
      `;
      return rows.map(toTransmitter);
    },

    async count() {
      const rows = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM radio_transmitters`;
      return Number(rows[0]?.count ?? 0);
    },
  };
}

interface SpaceWeatherRow {
  source: string;
  observed_at: Date;
  kp: number | null;
  a_running: number | null;
  solar_wind_speed_km_s: number | null;
  solar_wind_density: number | null;
  bz_nt: number | null;
  radio_blackout_scale: number | null;
  solar_radiation_scale: number | null;
  geomagnetic_scale: number | null;
  retrieved_at: Date;
}

function toObservation(row: SpaceWeatherRow): SpaceWeatherObservation {
  return {
    source: row.source as SpaceWeatherObservation["source"],
    observedAt: row.observed_at,
    kp: row.kp ?? undefined,
    aRunning: row.a_running ?? undefined,
    solarWindSpeedKmS: row.solar_wind_speed_km_s ?? undefined,
    solarWindDensity: row.solar_wind_density ?? undefined,
    bzNt: row.bz_nt ?? undefined,
    radioBlackoutScale: row.radio_blackout_scale ?? undefined,
    solarRadiationScale: row.solar_radiation_scale ?? undefined,
    geomagneticScale: row.geomagnetic_scale ?? undefined,
    retrievedAt: row.retrieved_at,
  };
}

function createSpaceWeatherRepository(sql: Sql): SpaceWeatherRepository {
  return {
    async record(observations) {
      if (observations.length === 0) return { inserted: 0, updated: 0 };

      let inserted = 0;
      let updated = 0;

      for (const batch of chunk(observations, WRITE_CHUNK_SIZE)) {
        const payload = sql.json(
          jsonRows(
            batch.map((observation) => ({
              source: observation.source,
              observed_at: observation.observedAt.toISOString(),
              kp: observation.kp ?? null,
              a_running: observation.aRunning ?? null,
              solar_wind_speed_km_s: observation.solarWindSpeedKmS ?? null,
              solar_wind_density: observation.solarWindDensity ?? null,
              bz_nt: observation.bzNt ?? null,
              radio_blackout_scale: observation.radioBlackoutScale ?? null,
              solar_radiation_scale: observation.solarRadiationScale ?? null,
              geomagnetic_scale: observation.geomagneticScale ?? null,
              retrieved_at: observation.retrievedAt.toISOString(),
            })),
          ),
        );

        const rows = await sql<{ inserted: boolean }[]>`
          INSERT INTO space_weather (
            source, observed_at, kp, a_running,
            solar_wind_speed_km_s, solar_wind_density, bz_nt,
            radio_blackout_scale, solar_radiation_scale, geomagnetic_scale, retrieved_at
          )
          SELECT
            i.source, i.observed_at, i.kp, i.a_running,
            i.solar_wind_speed_km_s, i.solar_wind_density, i.bz_nt,
            i.radio_blackout_scale, i.solar_radiation_scale, i.geomagnetic_scale,
            i.retrieved_at
          FROM json_to_recordset(${payload}::json) AS i(
            source TEXT, observed_at TIMESTAMPTZ,
            kp DOUBLE PRECISION, a_running DOUBLE PRECISION,
            solar_wind_speed_km_s DOUBLE PRECISION, solar_wind_density DOUBLE PRECISION,
            bz_nt DOUBLE PRECISION,
            radio_blackout_scale SMALLINT, solar_radiation_scale SMALLINT,
            geomagnetic_scale SMALLINT, retrieved_at TIMESTAMPTZ
          )
          ON CONFLICT (source, observed_at) DO UPDATE SET
            kp = EXCLUDED.kp,
            a_running = EXCLUDED.a_running,
            solar_wind_speed_km_s = EXCLUDED.solar_wind_speed_km_s,
            solar_wind_density = EXCLUDED.solar_wind_density,
            bz_nt = EXCLUDED.bz_nt,
            radio_blackout_scale = EXCLUDED.radio_blackout_scale,
            solar_radiation_scale = EXCLUDED.solar_radiation_scale,
            geomagnetic_scale = EXCLUDED.geomagnetic_scale,
            retrieved_at = EXCLUDED.retrieved_at
          RETURNING (xmax = 0) AS inserted
        `;

        for (const row of rows) {
          if (row.inserted) inserted += 1;
          else updated += 1;
        }
      }

      return { inserted, updated };
    },

    async latest(source) {
      const rows = await sql<SpaceWeatherRow[]>`
        SELECT * FROM space_weather WHERE source = ${source}
        ORDER BY observed_at DESC LIMIT 1
      `;
      const row = rows[0];
      return row === undefined ? undefined : toObservation(row);
    },

    async since(source, from) {
      const rows = await sql<SpaceWeatherRow[]>`
        SELECT * FROM space_weather
        WHERE source = ${source} AND observed_at >= ${from}
        ORDER BY observed_at ASC
      `;
      return rows.map(toObservation);
    },
  };
}

function createGroupRepository(sql: Sql): SatelliteGroupRepository {
  return {
    async record(provider, groupName, catalogIds, seenAt) {
      if (catalogIds.length === 0) return { added: 0, refreshed: 0 };

      let added = 0;
      let refreshed = 0;

      // Chunked for the same reason element inserts are: a group is small today, but
      // a parameter limit is not the place to discover that it grew.
      for (const batch of chunk(catalogIds, WRITE_CHUNK_SIZE)) {
        // json_to_recordset rather than sql(rows, ...columns): the same idiom the
        // other bulk writes here use, and it keeps the parameter count constant
        // regardless of batch size.
        const payload = sql.json(
          jsonRows(batch.map((catalogId) => ({ catalog_id: catalogId }))),
        );

        // xmax = 0 identifies a genuinely inserted row, which distinguishes a new
        // member from a refreshed one without a second round trip. first_seen_at is
        // deliberately never updated: it records when membership began.
        const rows = await sql<{ inserted: boolean }[]>`
          INSERT INTO satellite_groups (catalog_id, provider, group_name, first_seen_at, last_seen_at)
          SELECT i.catalog_id, ${provider}, ${groupName}, ${seenAt}, ${seenAt}
          FROM json_to_recordset(${payload}::json) AS i(catalog_id TEXT)
          ON CONFLICT (catalog_id, provider, group_name) DO UPDATE
            SET last_seen_at = EXCLUDED.last_seen_at
          RETURNING (xmax = 0) AS inserted
        `;

        for (const row of rows) {
          if (row.inserted) added += 1;
          else refreshed += 1;
        }
      }

      return { added, refreshed };
    },

    async members(provider, groupName, options = {}) {
      const since = options.seenSince;
      const rows = await sql<
        {
          catalog_id: string;
          provider: string;
          group_name: string;
          first_seen_at: Date;
          last_seen_at: Date;
        }[]
      >`
        SELECT catalog_id, provider, group_name, first_seen_at, last_seen_at
        FROM satellite_groups
        WHERE provider = ${provider}
          AND group_name = ${groupName}
          ${since === undefined ? sql`` : sql`AND last_seen_at >= ${since}`}
        ORDER BY catalog_id
      `;

      return rows.map((row) => ({
        catalogId: row.catalog_id as CatalogId,
        provider: row.provider,
        groupName: row.group_name,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      }));
    },
  };
}

function createLeaseRepository(sql: Sql): IngestionLeaseRepository {
  return {
    async acquire(resourceKey, holder, ttlSeconds) {
      // A single atomic statement. The conditional DO UPDATE takes the lease only when
      // the incumbent has expired, so two workers racing cannot both succeed. Checking
      // and then writing in separate statements is precisely the race this avoids.
      const rows = await sql<{ expires_at: Date }[]>`
        INSERT INTO ingestion_leases (resource_key, holder, acquired_at, expires_at)
        VALUES (
          ${resourceKey}, ${holder}, now(),
          now() + make_interval(secs => ${ttlSeconds}::double precision)
        )
        ON CONFLICT (resource_key) DO UPDATE SET
          holder      = EXCLUDED.holder,
          acquired_at = EXCLUDED.acquired_at,
          expires_at  = EXCLUDED.expires_at
        WHERE ingestion_leases.expires_at <= now()
        RETURNING expires_at
      `;
      const row = rows[0];
      return row === undefined
        ? undefined
        : { expiresAt: requireDate(row.expires_at, "expires_at") };
    },

    async renew(resourceKey, holder, ttlSeconds) {
      const rows = await sql`
        UPDATE ingestion_leases
        SET expires_at = now() + make_interval(secs => ${ttlSeconds}::double precision)
        WHERE resource_key = ${resourceKey} AND holder = ${holder}
        RETURNING resource_key
      `;
      return rows.length > 0;
    },

    async release(resourceKey, holder) {
      // Holder-scoped: a worker whose lease already expired and was taken by someone
      // else must not be able to release the new holder's lease.
      await sql`
        DELETE FROM ingestion_leases
        WHERE resource_key = ${resourceKey} AND holder = ${holder}
      `;
    },
  };
}
