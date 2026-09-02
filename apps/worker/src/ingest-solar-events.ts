import type { Database } from "@orbitwatch/database";
import { policyFor, toSolarEvents, type GuardedHttpClient } from "@orbitwatch/providers";

import {
  defaultHolder,
  DEFAULT_LEASE_TTL_SECONDS,
  NULL_LOGGER,
  type IngestionLogger,
} from "./ingest-elements.js";

/**
 * Ingest solar and geomagnetic events from NASA DONKI.
 *
 * HOW THIS DIFFERS FROM THE NOAA INGESTION
 * NOAA reports the CURRENT level on the R/S/G scales — a number describing right now.
 * DONKI publishes discrete EVENTS with narrative: a coronal mass ejection was observed,
 * a geomagnetic storm began. Both belong in a tracker, and they answer different
 * questions: the scales say what conditions are, the events say what happened.
 *
 * WHOLE-PAGE VALIDATION, DELIBERATELY
 * DONKI is a single curated NASA service, so a record that fails the schema means the
 * format changed. Salvaging what parses would leave an event list quietly incomplete,
 * and an event list missing a geomagnetic storm is worse than an ingestion that failed
 * and said so. SatNOGS DB's transmitter feed is community-edited and gets the opposite
 * treatment for the opposite reason.
 *
 * DEMO_KEY BY DEFAULT
 * NASA_API_KEY is used when set. The public demonstration key works and is heavily
 * throttled, which is the right default for a project that must run for a contributor
 * with no credentials — and the throttling is real, so the durable rate policy matters
 * more here than the on-disk guard.
 */

const PROVIDER = "nasa-donki";
const RESOURCE = "notifications";

/** How far back to ask for events. A month covers a full solar rotation. */
const WINDOW_DAYS = 30;

function buildUrl(now: Date, apiKey: string): string {
  const url = new URL("https://api.nasa.gov/DONKI/notifications");
  const start = new Date(now.getTime() - WINDOW_DAYS * 24 * 3_600_000);
  url.searchParams.set("startDate", start.toISOString().slice(0, 10));
  url.searchParams.set("endDate", now.toISOString().slice(0, 10));
  url.searchParams.set("type", "all");
  url.searchParams.set("api_key", apiKey);
  return url.toString();
}

export interface SolarEventIngestionResult {
  readonly status: "success" | "skipped" | "failed";
  readonly fetched: number;
  readonly inserted: number;
  readonly updated: number;
  /** How many of each message type arrived, for the run log. */
  readonly byType: Readonly<Record<string, number>>;
  readonly durationMs: number;
  readonly errorSummary?: string;
  readonly runId?: string;
}

export interface IngestSolarEventsOptions {
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
  /** Defaults to NASA_API_KEY, then to NASA's public demonstration key. */
  readonly apiKey?: string;
}

export async function ingestSolarEvents(
  options: IngestSolarEventsOptions,
): Promise<SolarEventIngestionResult> {
  const {
    database,
    http,
    holder = defaultHolder(),
    leaseTtlSeconds = DEFAULT_LEASE_TTL_SECONDS,
    logger = NULL_LOGGER,
    now = () => new Date(),
    force = false,
    apiKey = process.env["NASA_API_KEY"] ?? "DEMO_KEY",
  } = options;

  const leaseKey = `${PROVIDER}:${RESOURCE}`;
  const startedAt = now().getTime();
  const elapsed = (): number => now().getTime() - startedAt;
  const nothing = { fetched: 0, inserted: 0, updated: 0, byType: {} } as const;

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
      logger.info("Solar event ingestion skipped by durable rate guard", { reason });
      await database.leases.release(leaseKey, holder);
      return { status: "skipped", ...nothing, durationMs: elapsed(), errorSummary: reason };
    }
  }

  const runId = await database.providerRuns.start(PROVIDER, RESOURCE);

  try {
    const response = await http.get(buildUrl(now(), apiKey), {
      provider: PROVIDER,
      resource: RESOURCE,
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
      throw new Error("NASA DONKI response was not valid JSON");
    }

    const events = toSolarEvents(payload);
    const byType: Record<string, number> = {};
    for (const event of events) {
      byType[event.type] = (byType[event.type] ?? 0) + 1;
    }

    const { inserted, updated } = await database.solarEvents.upsertMany(
      events.map((event) => ({
        id: event.id,
        provider: PROVIDER,
        type: event.type,
        knownType: event.known,
        issuedAt: event.issuedAt,
        url: event.url,
        summary: event.summary,
        body: event.body,
        retrievedAt: response.fetchedAt,
      })),
    );

    await database.providerRuns.finish(runId, {
      status: "success",
      recordsFetched: events.length,
      recordsInserted: inserted,
      recordsUnchanged: updated,
      recordsRejected: 0,
    });

    logger.info("Solar event ingestion complete", {
      fetched: events.length,
      inserted,
      updated,
      byType,
    });

    return {
      status: "success",
      fetched: events.length,
      inserted,
      updated,
      byType,
      durationMs: elapsed(),
      runId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await database.providerRuns.finish(runId, { status: "failed", errorSummary: message });
    logger.error("Solar event ingestion failed", { message });
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
