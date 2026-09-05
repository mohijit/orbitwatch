import type { Database } from "@orbitwatch/database";
import { policyFor, toGroundStations, type GuardedHttpClient } from "@orbitwatch/providers";

import {
  defaultHolder,
  DEFAULT_LEASE_TTL_SECONDS,
  NULL_LOGGER,
  type IngestionLogger,
} from "./ingest-elements.js";

/**
 * Ingest ground stations from SatNOGS Network.
 *
 * SatNOGS DB says what a satellite transmits; the Network says who can hear it.
 * Together they answer the question a ground station operator actually has: is anyone
 * positioned to receive this pass, and on what band.
 *
 * EVERYTHING IS STORED, INCLUDING THE OFFLINE MAJORITY
 * The captured listing was 4,119 Offline, 317 Online, 16 Testing. A volunteer network
 * is mostly dormant at any moment. Filtering at ingestion would make the data useless
 * the next time a station comes back, so status is stored and the reader decides — and
 * the API reports the counts rather than letting a total imply capacity.
 *
 * WHOLE-PAGE VALIDATION
 * Unlike SatNOGS DB's transmitter list, this is a single well-formed listing endpoint
 * rather than a stream of community-edited records, so a station failing the schema
 * means the shape changed. Failing loudly with the last known good data retained beats
 * a station list that is quietly missing entries.
 */

const PROVIDER = "satnogs-network";
const RESOURCE = "stations";

function buildUrl(): string {
  const url = new URL("https://network.satnogs.org/api/stations/");
  url.searchParams.set("format", "json");
  return url.toString();
}

export interface StationIngestionResult {
  readonly status: "success" | "skipped" | "failed";
  readonly fetched: number;
  readonly inserted: number;
  readonly updated: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly durationMs: number;
  readonly errorSummary?: string;
  readonly runId?: string;
}

export interface IngestStationsOptions {
  readonly database: Database;
  readonly http: GuardedHttpClient;
  readonly holder?: string;
  readonly leaseTtlSeconds?: number;
  readonly logger?: IngestionLogger;
  readonly now?: () => Date;
  /**
   * Skip the DURABLE rate check for this run.
   *
   * The policy is ours, not the provider's, so a transient failure — a timeout on a
   * slow endpoint — should not cost a full window before it can be retried. This does
   * NOT bypass the on-disk fetch guard or a provider-requested backoff, both of which
   * exist to protect the provider rather than to pace us.
   */
  readonly force?: boolean;
}

export async function ingestStations(
  options: IngestStationsOptions,
): Promise<StationIngestionResult> {
  const {
    database,
    http,
    holder = defaultHolder(),
    leaseTtlSeconds = DEFAULT_LEASE_TTL_SECONDS,
    logger = NULL_LOGGER,
    now = () => new Date(),
    force = false,
  } = options;

  const leaseKey = `${PROVIDER}:${RESOURCE}`;
  const startedAt = now().getTime();
  const elapsed = (): number => now().getTime() - startedAt;
  const nothing = { fetched: 0, inserted: 0, updated: 0, byStatus: {} } as const;

  const lease = await database.leases.acquire(leaseKey, holder, leaseTtlSeconds);
  if (lease === undefined) {
    return {
      status: "skipped",
      ...nothing,
      durationMs: elapsed(),
      errorSummary: "another worker holds the lease",
    };
  }

  const policy = policyFor(PROVIDER);
  const lastAttempt = await database.providerRuns.latestAttempt(PROVIDER, RESOURCE);
  if (lastAttempt !== undefined && !force) {
    const sinceMs = now().getTime() - lastAttempt.startedAt.getTime();
    if (sinceMs < policy.minIntervalMs) {
      const reason =
        `provider rate policy: last attempt ${Math.floor(sinceMs / 60_000)} min ago, ` +
        `next allowed in ${Math.ceil((policy.minIntervalMs - sinceMs) / 60_000)} min`;
      logger.info("Station ingestion skipped by durable rate guard", { reason });
      await database.leases.release(leaseKey, holder);
      return { status: "skipped", ...nothing, durationMs: elapsed(), errorSummary: reason };
    }
  }

  const runId = await database.providerRuns.start(PROVIDER, RESOURCE);

  try {
    const response = await http.get(buildUrl(), {
      provider: PROVIDER,
      resource: RESOURCE,
      /*
       * Longer than the 30 s default, because this endpoint is genuinely slow.
       *
       * The full listing is 4,452 stations and 3.3 MB, and the first live run timed out
       * at the default — recorded as a failed provider_run, which is the pipeline
       * behaving correctly and also an hour of rate policy spent on nothing. The
       * provider is not at fault and neither is the guard; the timeout was simply set
       * for small responses.
       */
      timeoutMs: 120_000,
    });

    if (response.status === "skipped") {
      const reason = `fetch guard: next allowed in ${Math.ceil(response.retryAfterMs / 60_000)} min`;
      await database.providerRuns.finish(runId, { status: "skipped", errorSummary: reason });
      return { status: "skipped", ...nothing, durationMs: elapsed(), errorSummary: reason, runId };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new Error("SatNOGS Network response was not valid JSON");
    }

    const stations = toGroundStations(payload);
    const byStatus: Record<string, number> = {};
    for (const station of stations) {
      byStatus[station.status] = (byStatus[station.status] ?? 0) + 1;
    }

    const { inserted, updated } = await database.stations.upsertMany(
      stations.map((station) => ({
        id: station.id,
        provider: PROVIDER,
        name: station.name,
        latitude: station.latitude,
        longitude: station.longitude,
        altitudeM: station.altitudeM,
        minHorizonDegrees: station.minHorizonDegrees,
        status: station.status,
        bands: station.bands,
        observations: station.observations,
        lastSeen: station.lastSeen,
        retrievedAt: response.fetchedAt,
      })),
    );

    await database.providerRuns.finish(runId, {
      status: "success",
      recordsFetched: stations.length,
      recordsInserted: inserted,
      recordsUnchanged: updated,
      recordsRejected: 0,
    });

    logger.info("Station ingestion complete", {
      fetched: stations.length,
      inserted,
      updated,
      byStatus,
    });

    return {
      status: "success",
      fetched: stations.length,
      inserted,
      updated,
      byStatus,
      durationMs: elapsed(),
      runId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await database.providerRuns.finish(runId, { status: "failed", errorSummary: message });
    logger.error("Station ingestion failed", { message });
    return {
      status: "failed",
      ...nothing,
      durationMs: elapsed(),
      errorSummary: message,
      runId,
    };
  } finally {
    await database.leases.release(leaseKey, holder);
  }
}
