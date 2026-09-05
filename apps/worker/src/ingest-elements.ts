import type { Database, OrbitalElementRecord } from "@orbitwatch/database";
import {
  ElementParseError,
  classifyOrbit,
  deriveOrbitGeometry,
  minutes,
  normalizeCatalogId,
  parseOmm,
  parseUtcTimestamp,
  type CatalogId,
  type OMMJsonObject,
} from "@orbitwatch/orbit-core";
import {
  buildGpUrl,
  gpResourceKey,
  parseGpResponse,
  policyFor,
  type CelestrakGpQuery,
  type GuardedHttpClient,
  type ProviderRefusedError,
} from "@orbitwatch/providers";

/**
 * Orbital element ingestion.
 *
 * Pipeline, in order, matching the milestone plan:
 *
 *   LEASE     one worker per resource, so a redeploy overlap cannot double-write
 *   FETCH     through the guarded HTTP client, which enforces provider rate policy
 *   VALIDATE  per record, so one bad row cannot discard a 20,000-object download
 *   NORMALIZE into the shared orbital representation
 *   COMPARE   against stored history, so unchanged elements are a no-op
 *   STORE     append-only, preserving history for replay
 *   LOG       into provider_runs, which is what makes "last known good" auditable
 *
 * LAST KNOWN GOOD
 * Nothing here deletes or overwrites existing elements. A failed run leaves the
 * previous data exactly as it was, and the API keeps serving it with an honest
 * freshness badge. That is the entire outage strategy: degrade the age of the data,
 * never the availability of the product.
 */

export interface IngestionResult {
  readonly runId: string;
  readonly status: "success" | "partial" | "failed" | "skipped";
  readonly fetched: number;
  readonly inserted: number;
  readonly unchanged: number;
  readonly rejected: number;
  readonly skippedReason: string | undefined;
  readonly errorSummary: string | undefined;
  readonly durationMs: number;
}

export interface IngestElementsOptions {
  readonly database: Database;
  readonly http: GuardedHttpClient;
  readonly query: CelestrakGpQuery;
  /** Identifies this worker in the lease table. Defaults to hostname + pid. */
  readonly holder?: string;
  /** Lease lifetime. Must exceed the longest plausible ingest. */
  readonly leaseTtlSeconds?: number;
  readonly logger?: IngestionLogger;
  readonly now?: () => Date;
}

export interface IngestionLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const NULL_LOGGER: IngestionLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * A full catalog download can legitimately take a while. The lease must outlive it,
 * but not by so much that a crashed worker blocks the next scheduled run.
 */
export const DEFAULT_LEASE_TTL_SECONDS = 600;

/** How many rejected records to keep in the error summary before truncating. */
const MAX_REPORTED_REJECTIONS = 5;

export async function ingestOrbitalElements(
  options: IngestElementsOptions,
): Promise<IngestionResult> {
  const {
    database,
    http,
    query,
    holder = defaultHolder(),
    leaseTtlSeconds = DEFAULT_LEASE_TTL_SECONDS,
    logger = NULL_LOGGER,
    now = () => new Date(),
  } = options;

  const provider = "celestrak-gp";
  const resource = gpResourceKey(query);
  const leaseKey = `${provider}:${resource}`;
  const startedAt = now().getTime();

  // --- LEASE ---------------------------------------------------------------
  // The FetchGuard stops us over-fetching the provider; this stops two workers
  // writing the same ingest concurrently. Different failures, different mechanisms.
  const lease = await database.leases.acquire(leaseKey, holder, leaseTtlSeconds);
  if (lease === undefined) {
    logger.info("Ingestion skipped: another worker holds the lease", { leaseKey });
    return skipped("another worker holds the lease", startedAt, now);
  }

  // --- RATE POLICY (durable) ----------------------------------------------
  // The on-disk FetchGuard protects a long-lived machine. It cannot protect an
  // ephemeral one: a CI runner starts with an empty disk every time, so the guard
  // would permit a fetch on every scheduled run and we would breach CelesTrak's
  // one-download-per-cycle policy within hours. Because CI runners share IP ranges,
  // being firewalled would harm unrelated users of that infrastructure too.
  //
  // provider_runs is durable and shared, so it is the state that actually survives.
  // Checked BEFORE the run row is created, or the check would see its own row and
  // conclude an attempt was already in progress.
  const policy = policyFor(provider);
  const lastAttempt = await database.providerRuns.latestAttempt(provider, resource);

  if (lastAttempt !== undefined) {
    const elapsedMs = now().getTime() - lastAttempt.startedAt.getTime();
    if (elapsedMs < policy.minIntervalMs) {
      const remainingMinutes = Math.ceil((policy.minIntervalMs - elapsedMs) / 60_000);
      const reason =
        `provider rate policy: last attempt ${Math.floor(elapsedMs / 60_000)} min ago, ` +
        `next allowed in ${remainingMinutes} min`;

      logger.info("Ingestion skipped by durable rate guard", {
        provider,
        resource,
        reason,
      });

      // Released explicitly: the finally below belongs to a try we have not entered.
      await database.leases.release(leaseKey, holder);
      return skipped(reason, startedAt, now);
    }
  }

  const runId = await database.providerRuns.start(provider, resource);

  try {
    // --- FETCH -------------------------------------------------------------
    const url = buildGpUrl(query);
    const response = await http.get(url, { provider, resource });

    if (response.status === "skipped") {
      // Not an error. The provider publishes every ~2h and we already have this
      // cycle's data; fetching again would earn a 403 and risk an IP block.
      const reason =
        response.reason === "backoff-active"
          ? `provider backoff active, ${Math.ceil(response.retryAfterMs / 60_000)} min remaining`
          : `already fetched this cycle, next allowed in ${Math.ceil(response.retryAfterMs / 60_000)} min`;

      logger.info("Ingestion skipped by fetch guard", { provider, resource, reason });
      await database.providerRuns.finish(runId, {
        status: "skipped",
        errorSummary: reason,
      });
      return { ...skipped(reason, startedAt, now), runId };
    }

    // --- VALIDATE ----------------------------------------------------------
    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new IngestionError(
        `${provider} returned a body that is not valid JSON (${response.body.length} bytes)`,
      );
    }

    const { records, rejected } = parseGpResponse(payload);
    logger.info("Fetched GP records", {
      provider,
      resource,
      fetched: records.length,
      rejected: rejected.length,
    });

    if (records.length === 0) {
      // An empty catalog is never correct and must not be allowed to look like a
      // successful run that simply found nothing new.
      throw new IngestionError(
        `${provider} returned no usable records (${rejected.length} rejected). ` +
          `Existing data has been left untouched.`,
      );
    }

    // --- NORMALIZE ---------------------------------------------------------
    const normalized: Omit<OrbitalElementRecord, "id">[] = [];
    const normalizationFailures: string[] = [];

    for (const record of records) {
      try {
        normalized.push(normalizeRecord(record, response.fetchedAt));
      } catch (error) {
        // A record SGP4 cannot initialise is unusable, but the other 19,999 are fine.
        normalizationFailures.push(
          error instanceof ElementParseError
            ? `${error.detail.catalogId ?? "?"}: ${error.detail.reason}`
            : String(error),
        );
      }
    }

    // --- COMPARE + STORE ---------------------------------------------------
    // Satellites must exist before elements, because of the foreign key. Upsert
    // placeholder rows for objects SATCAT has not described yet: an object with
    // elements but no metadata is still trackable, and refusing it would silently
    // drop newly-launched objects until the next SATCAT run.
    await ensureSatellitesExist(database, records, provider);

    const stored = await database.elements.insertMany(normalized);

    // Record group membership when the request was for a named group.
    //
    // This is the only place the membership is knowable: the response IS the list, and
    // nothing in an OMM record says which groups its object belongs to. It matters
    // because `visual` is CelesTrak's curated set of objects bright enough to see with
    // the naked eye — the closest thing a public catalog offers to the brightness data
    // GP elements omit entirely. Without it, "Visible Tonight" degenerates into every
    // sunlit object above the horizon, which measured at 3,614 passes in one night.
    //
    // Stamped with the fetch time rather than now(), so a slow or replayed run does not
    // claim fresher knowledge of the membership than it actually has.
    if (query.kind === "GROUP") {
      const memberIds = records
        .map((record) => normalizeCatalogId(record["NORAD_CAT_ID"]))
        .filter((catalogId): catalogId is CatalogId => catalogId !== undefined);

      const membership = await database.groups.record(
        provider,
        query.value,
        memberIds,
        response.fetchedAt,
      );
      logger.info("Recorded group membership", {
        provider,
        group: query.value,
        members: memberIds.length,
        added: membership.added,
        refreshed: membership.refreshed,
      });
    }

    const totalRejected = rejected.length + normalizationFailures.length;
    const status = totalRejected > 0 ? "partial" : "success";

    // --- LOG ---------------------------------------------------------------
    await database.providerRuns.finish(runId, {
      status,
      recordsFetched: records.length,
      recordsInserted: stored.inserted,
      recordsUnchanged: stored.unchanged,
      recordsRejected: totalRejected,
      ...(totalRejected > 0
        ? { errorSummary: summariseRejections(rejected, normalizationFailures) }
        : {}),
    });

    logger.info("Ingestion complete", {
      provider,
      resource,
      status,
      inserted: stored.inserted,
      unchanged: stored.unchanged,
      rejected: totalRejected,
    });

    return {
      runId,
      status,
      fetched: records.length,
      inserted: stored.inserted,
      unchanged: stored.unchanged,
      rejected: totalRejected,
      skippedReason: undefined,
      errorSummary:
        totalRejected > 0
          ? summariseRejections(rejected, normalizationFailures)
          : undefined,
      durationMs: now().getTime() - startedAt,
    };
  } catch (error) {
    const summary = describeError(error);
    logger.error("Ingestion failed", { provider, resource, error: summary });

    await database.providerRuns.finish(runId, {
      status: "failed",
      errorSummary: summary,
    });

    // Deliberately not rethrown for a scheduled run: one provider failing must not
    // stop the others, and the failure is now recorded where the health endpoint
    // can see it. Existing data is untouched, so the API keeps serving last known good.
    return {
      runId,
      status: "failed",
      fetched: 0,
      inserted: 0,
      unchanged: 0,
      rejected: 0,
      skippedReason: undefined,
      errorSummary: summary,
      durationMs: now().getTime() - startedAt,
    };
  } finally {
    await database.leases.release(leaseKey, holder);
  }
}

/**
 * Convert a validated GP record into a storable element row.
 *
 * Runs the record through the real SGP4 initialisation via `parseOmm`, so a record
 * that cannot actually be propagated is rejected here rather than being stored and
 * failing later on the globe.
 */
function normalizeRecord(
  record: Record<string, unknown>,
  retrievedAt: Date,
): Omit<OrbitalElementRecord, "id"> {
  const omm = record as unknown as OMMJsonObject;
  const { elements } = parseOmm(omm, { provider: "celestrak", retrievedAt });

  return {
    catalogId: elements.catalogId,
    provider: "celestrak",
    format: "OMM_JSON",
    epoch: elements.epoch,
    retrievedAt,
    omm: record,
    tleLine1: undefined,
    tleLine2: undefined,
    meanMotion: elements.meanMotion,
    eccentricity: elements.eccentricity,
    inclination: elements.inclination,
    bstar: elements.bstar,
  };
}

/**
 * Ensure a satellites row exists for every object we are about to store elements for.
 *
 * Creates minimal placeholder rows only. SATCAT ingestion fills in object type, owner,
 * launch details and so on; until then the object is trackable but its metadata is
 * honestly empty rather than invented.
 */
async function ensureSatellitesExist(
  database: Database,
  records: readonly Record<string, unknown>[],
  provider: string,
): Promise<void> {
  const existing = new Set<string>();
  const catalogIds: string[] = [];

  for (const record of records) {
    const catalogId = normalizeCatalogId(record["NORAD_CAT_ID"]);
    if (catalogId !== undefined) catalogIds.push(catalogId);
  }

  const found = await database.satellites.findMany({
    excludeDecayed: false,
    limit: Number.MAX_SAFE_INTEGER,
  });
  for (const satellite of found) existing.add(satellite.catalogId);

  const placeholders = [];
  const now = new Date();

  for (const record of records) {
    const catalogId = normalizeCatalogId(record["NORAD_CAT_ID"]);
    if (catalogId === undefined || existing.has(catalogId)) continue;
    existing.add(catalogId);

    const name = typeof record["OBJECT_NAME"] === "string" ? record["OBJECT_NAME"] : catalogId;
    const designator =
      typeof record["OBJECT_ID"] === "string" ? record["OBJECT_ID"] : undefined;

    placeholders.push({
      catalogId,
      name,
      internationalDesignator: designator,
      // UNKNOWN, not PAYLOAD: GP data does not say what an object is, and guessing
      // would mislabel debris.
      objectType: "UNKNOWN" as const,
      operationalStatus: undefined,
      owner: undefined,
      launchDate: undefined,
      launchSite: undefined,
      decayDate: undefined,
      periodMinutes: undefined,
      inclinationDegrees: undefined,
      apogeeKm: undefined,
      perigeeKm: undefined,
      rcsSquareMetres: undefined,
      orbitClass: undefined,
      metadata: {},
      sourceProvider: provider,
      updatedAt: now,
    });
  }

  if (placeholders.length > 0) await database.satellites.upsertMany(placeholders);
}

function summariseRejections(
  rejected: readonly { index: number; reason: string }[],
  normalizationFailures: readonly string[],
): string {
  const parts: string[] = [];
  if (rejected.length > 0) {
    parts.push(
      `${rejected.length} schema rejection(s): ` +
        rejected
          .slice(0, MAX_REPORTED_REJECTIONS)
          .map((r) => `[${r.index}] ${r.reason}`)
          .join(" | "),
    );
  }
  if (normalizationFailures.length > 0) {
    parts.push(
      `${normalizationFailures.length} normalisation failure(s): ` +
        normalizationFailures.slice(0, MAX_REPORTED_REJECTIONS).join(" | "),
    );
  }
  return parts.join("; ").slice(0, 2000);
}

function skipped(
  reason: string,
  startedAt: number,
  now: () => Date,
): IngestionResult {
  return {
    runId: "",
    status: "skipped",
    fetched: 0,
    inserted: 0,
    unchanged: 0,
    rejected: 0,
    skippedReason: reason,
    errorSummary: undefined,
    durationMs: now().getTime() - startedAt,
  };
}

export function defaultHolder(): string {
  return `worker-${process.pid}`;
}

function describeError(error: unknown): string {
  if (isProviderRefused(error)) {
    // The most important failure to report clearly: we asked too often and upstream
    // told us to stop. A human needs to see this, not a retry loop.
    return `PROVIDER REFUSED: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isProviderRefused(error: unknown): error is ProviderRefusedError {
  return error instanceof Error && error.name === "ProviderRefusedError";
}

export class IngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestionError";
  }
}

/** Re-exported so the worker entry point can derive orbit metadata after SATCAT. */
export { classifyOrbit, deriveOrbitGeometry, minutes, parseUtcTimestamp };
