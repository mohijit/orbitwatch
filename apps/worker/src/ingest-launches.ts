import type { Database, LaunchRecord } from "@orbitwatch/database";
import { policyFor, toLaunchDetails, type GuardedHttpClient } from "@orbitwatch/providers";

import {
  defaultHolder,
  DEFAULT_LEASE_TTL_SECONDS,
  NULL_LOGGER,
  type IngestionLogger,
} from "./ingest-elements.js";

/**
 * Ingest upcoming launches from Launch Library 2.
 *
 * WHY THIS PROVIDER IS RATE-LIMITED HARDER THAN THE OTHERS
 * LL2 allows fifteen unauthenticated requests an hour, across the whole IP. That is a
 * budget small enough that a single misbehaving loop exhausts it for everyone behind
 * the same address, so this is never called from a browser and the durable rate policy
 * is the real protection — the on-disk fetch guard cannot help an ephemeral runner that
 * starts with an empty disk every time.
 *
 * DETAILED MODE, ONE PAGE
 * `mode=detailed` is requested because list mode omits the rocket, pad, provider and
 * mission — everything that makes a launch legible. One page is fetched rather than
 * paging the full 358 upcoming: the product shows the next handful, and spending the
 * hourly budget to store launches eighteen months out would be paying for data nobody
 * has asked for and which will have slipped by the time they do.
 */

const PROVIDER = "launch-library";
const RESOURCE = "upcoming";
const PAGE_SIZE = 20;

function buildUrl(): string {
  const url = new URL("https://ll.thespacedevs.com/2.3.0/launches/upcoming/");
  url.searchParams.set("mode", "detailed");
  url.searchParams.set("limit", String(PAGE_SIZE));
  return url.toString();
}

export interface LaunchIngestionResult {
  readonly status: "success" | "skipped" | "failed";
  readonly fetched: number;
  readonly inserted: number;
  readonly updated: number;
  readonly durationMs: number;
  readonly errorSummary?: string;
  readonly runId?: string;
}

export interface IngestLaunchesOptions {
  readonly database: Database;
  readonly http: GuardedHttpClient;
  readonly holder?: string;
  readonly leaseTtlSeconds?: number;
  readonly logger?: IngestionLogger;
  readonly now?: () => Date;
}

export async function ingestLaunches(
  options: IngestLaunchesOptions,
): Promise<LaunchIngestionResult> {
  const {
    database,
    http,
    holder = defaultHolder(),
    leaseTtlSeconds = DEFAULT_LEASE_TTL_SECONDS,
    logger = NULL_LOGGER,
    now = () => new Date(),
  } = options;

  const leaseKey = `${PROVIDER}:${RESOURCE}`;
  const startedAt = now().getTime();
  const elapsed = (): number => now().getTime() - startedAt;
  const nothing = { fetched: 0, inserted: 0, updated: 0 } as const;

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
  if (lastAttempt !== undefined) {
    const sinceMs = now().getTime() - lastAttempt.startedAt.getTime();
    if (sinceMs < policy.minIntervalMs) {
      const reason =
        `provider rate policy: last attempt ${Math.floor(sinceMs / 60_000)} min ago, ` +
        `next allowed in ${Math.ceil((policy.minIntervalMs - sinceMs) / 60_000)} min`;
      logger.info("Launch ingestion skipped by durable rate guard", { reason });
      await database.leases.release(leaseKey, holder);
      return { status: "skipped", ...nothing, durationMs: elapsed(), errorSummary: reason };
    }
  }

  const runId = await database.providerRuns.start(PROVIDER, RESOURCE);

  try {
    const response = await http.get(buildUrl(), { provider: PROVIDER, resource: RESOURCE });

    if (response.status === "skipped") {
      const reason = `fetch guard: next allowed in ${Math.ceil(response.retryAfterMs / 60_000)} min`;
      await database.providerRuns.finish(runId, { status: "skipped", errorSummary: reason });
      return { status: "skipped", ...nothing, durationMs: elapsed(), errorSummary: reason, runId };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new Error("Launch Library response was not valid JSON");
    }

    // The whole page is validated together, unlike SatNOGS: LL2 is a curated,
    // single-operator API rather than a community database, so a record that fails the
    // schema means the shape has changed and guessing at the rest would be worse than
    // failing loudly with the last known good data retained.
    const details = toLaunchDetails(payload);

    const records: LaunchRecord[] = details.map((launch) => ({
      id: launch.id,
      provider: PROVIDER,
      name: launch.name,
      net: launch.net,
      netPrecision: launch.netPrecision,
      windowStart: launch.windowStart,
      windowEnd: launch.windowEnd,
      statusName: launch.status,
      statusAbbrev: launch.statusAbbreviation,
      serviceProvider: launch.providerName,
      rocketName: launch.rocketName,
      missionName: launch.missionName,
      missionOrbit: launch.missionOrbit,
      padName: launch.padName,
      padLocation: launch.padLocation,
      padLatitude: launch.padCoordinates?.latitude,
      padLongitude: launch.padCoordinates?.longitude,
      webcastLive: launch.webcastLive,
      retrievedAt: response.fetchedAt,
    }));

    const { inserted, updated } = await database.launches.upsertMany(records);

    await database.providerRuns.finish(runId, {
      status: "success",
      recordsFetched: records.length,
      recordsInserted: inserted,
      recordsUnchanged: updated,
      recordsRejected: 0,
    });

    logger.info("Launch ingestion complete", { fetched: records.length, inserted, updated });

    return {
      status: "success",
      fetched: records.length,
      inserted,
      updated,
      durationMs: elapsed(),
      runId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await database.providerRuns.finish(runId, { status: "failed", errorSummary: message });
    logger.error("Launch ingestion failed", { message });
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
