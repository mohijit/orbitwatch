import type { Database } from "@orbitwatch/database";
import { normalizeCatalogId, parseUtcTimestamp } from "@orbitwatch/orbit-core";
import {
  policyFor,
  satnogsTransmittersResponseSchema,
  type GuardedHttpClient,
  type SatnogsTransmitter,
} from "@orbitwatch/providers";

import {
  defaultHolder,
  DEFAULT_LEASE_TTL_SECONDS,
  NULL_LOGGER,
  type IngestionLogger,
} from "./ingest-elements.js";

/**
 * Ingest radio transmitters from the SatNOGS DB.
 *
 * WHY THIS PROVIDER EXISTS IN THE PRODUCT
 * Orbital elements say where an object is and nothing about what it transmits. For a
 * ground station operator the frequency IS the answer: a pass at 18:42 is only
 * actionable alongside a downlink to tune to. Nothing in the GP catalog can be made to
 * yield that, so it comes from the community database that publishes it.
 *
 * SAME PIPELINE AS ELEMENTS
 * LEASE → RATE POLICY → FETCH → VALIDATE → NORMALIZE → STORE → LOG, for the same
 * reasons: one worker at a time, a durable rate check that survives an ephemeral CI
 * runner, schema validation against the provider's real shape, and a provider_runs row
 * whether it succeeded or not.
 *
 * PARTIAL SUCCESS IS A REAL OUTCOME
 * SatNOGS is community-maintained and carries records that are legitimately odd:
 * entries with no NORAD id, ids outside the catalog, occasional malformed rows. A
 * single bad record must not discard the other forty-nine, so rejects are counted and
 * reported rather than thrown, and the run is marked `partial`. Failing the whole
 * ingestion on one row would mean the most interesting objects — the new and the
 * unusual — reliably break it.
 */

const PROVIDER = "satnogs-db";
const BASE_URL = "https://db.satnogs.org/api";

export interface TransmitterIngestionResult {
  readonly status: "success" | "partial" | "skipped" | "failed";
  readonly fetched: number;
  readonly inserted: number;
  readonly updated: number;
  readonly rejected: number;
  readonly durationMs: number;
  readonly errorSummary?: string;
  readonly runId?: string;
}

export interface IngestTransmittersOptions {
  readonly database: Database;
  readonly http: GuardedHttpClient;
  /**
   * Restrict to one object, or omit for the whole database.
   *
   * SatNOGS supports both and they are genuinely different operations: the per-object
   * form is what a user's selection triggers, the bulk form is what a scheduled run
   * uses. The resource key records which, so the rate policy treats them separately —
   * a user opening one satellite must not exhaust the budget for the nightly refresh.
   */
  readonly catalogId?: string;
  readonly holder?: string;
  readonly leaseTtlSeconds?: number;
  readonly logger?: IngestionLogger;
  readonly now?: () => Date;
}

function resourceKey(catalogId: string | undefined): string {
  return catalogId === undefined ? "transmitters-all" : `transmitters-${catalogId}`;
}

function buildUrl(catalogId: string | undefined): string {
  const url = new URL(`${BASE_URL}/transmitters/`);
  url.searchParams.set("format", "json");
  if (catalogId !== undefined) url.searchParams.set("satellite__norad_cat_id", catalogId);
  return url.toString();
}

/**
 * The frequency to present as "the" uplink or downlink.
 *
 * SatNOGS publishes a nominal value and a `_drifted` one, measured from actual
 * observations. Where both exist the nominal is used and the drifted is not silently
 * substituted: a drifted figure is an observation of one spacecraft's ageing
 * oscillator, and presenting it as the published frequency would be quietly replacing
 * the provider's claim with a derived one. Nulls are common — many entries carry only
 * one of the pair — so the fallback exists rather than dropping the transmitter.
 */
function frequency(nominal: number | null, drifted: number | null): number | undefined {
  if (nominal !== null) return nominal;
  return drifted ?? undefined;
}

function toRecord(
  transmitter: SatnogsTransmitter,
  retrievedAt: Date,
): Parameters<Database["radio"]["upsertMany"]>[0][number] {
  // SatNOGS sends the NORAD id as a number; the rest of this system keys on a string
  // that is 6-digit safe. normalizeCatalogId is the one definition of that conversion.
  const catalogId =
    typeof transmitter.norad_cat_id === "number"
      ? normalizeCatalogId(String(transmitter.norad_cat_id))
      : undefined;

  return {
    uuid: transmitter.uuid,
    provider: PROVIDER,
    catalogId,
    satId: transmitter.sat_id,
    description: transmitter.description,
    type: transmitter.type,
    status: transmitter.status,
    alive: transmitter.alive,
    uplinkLowHz: frequency(transmitter.uplink_low, transmitter.uplink_drifted),
    uplinkHighHz: transmitter.uplink_high ?? undefined,
    downlinkLowHz: frequency(transmitter.downlink_low, transmitter.downlink_drifted),
    downlinkHighHz: transmitter.downlink_high ?? undefined,
    mode: transmitter.mode ?? undefined,
    uplinkMode: transmitter.uplink_mode ?? undefined,
    baud: transmitter.baud ?? undefined,
    inverted: transmitter.invert,
    service: transmitter.service ?? undefined,
    // `citation` is one of the passthrough fields the schema keeps but does not model,
    // so it arrives as unknown and is checked rather than cast. A transmitter listing
    // without a source is folklore, and people who use this data check the source.
    citation: typeof transmitter["citation"] === "string" ? transmitter["citation"] : undefined,
    // No timezone designator on SatNOGS's `updated`; it is UTC. Parsed by orbit-core
    // rather than `new Date()`, which would apply the host's offset.
    updatedAt: safeTimestamp(transmitter.updated),
    retrievedAt,
  };
}

function safeTimestamp(value: string): Date | undefined {
  try {
    return parseUtcTimestamp(value);
  } catch {
    // A malformed timestamp is not a reason to lose the frequency, which is the part
    // the user came for.
    return undefined;
  }
}

export async function ingestTransmitters(
  options: IngestTransmittersOptions,
): Promise<TransmitterIngestionResult> {
  const {
    database,
    http,
    catalogId,
    holder = defaultHolder(),
    leaseTtlSeconds = DEFAULT_LEASE_TTL_SECONDS,
    logger = NULL_LOGGER,
    now = () => new Date(),
  } = options;

  const resource = resourceKey(catalogId);
  const leaseKey = `${PROVIDER}:${resource}`;
  const startedAt = now().getTime();
  const elapsed = (): number => now().getTime() - startedAt;

  const lease = await database.leases.acquire(leaseKey, holder, leaseTtlSeconds);
  if (lease === undefined) {
    logger.info("Transmitter ingestion skipped: another worker holds the lease", { leaseKey });
    return {
      status: "skipped",
      fetched: 0,
      inserted: 0,
      updated: 0,
      rejected: 0,
      durationMs: elapsed(),
      errorSummary: "another worker holds the lease",
    };
  }

  // Durable rate check, before the run row exists — otherwise it would see its own
  // row and conclude an attempt was already in progress.
  const policy = policyFor(PROVIDER);
  const lastAttempt = await database.providerRuns.latestAttempt(PROVIDER, resource);
  if (lastAttempt !== undefined) {
    const sinceMs = now().getTime() - lastAttempt.startedAt.getTime();
    if (sinceMs < policy.minIntervalMs) {
      const reason =
        `provider rate policy: last attempt ${Math.floor(sinceMs / 60_000)} min ago, ` +
        `next allowed in ${Math.ceil((policy.minIntervalMs - sinceMs) / 60_000)} min`;
      logger.info("Transmitter ingestion skipped by durable rate guard", {
        provider: PROVIDER,
        resource,
        reason,
      });
      await database.leases.release(leaseKey, holder);
      return {
        status: "skipped",
        fetched: 0,
        inserted: 0,
        updated: 0,
        rejected: 0,
        durationMs: elapsed(),
        errorSummary: reason,
      };
    }
  }

  const runId = await database.providerRuns.start(PROVIDER, resource);

  try {
    const response = await http.get(buildUrl(catalogId), { provider: PROVIDER, resource });

    if (response.status === "skipped") {
      const reason = `fetch guard: next allowed in ${Math.ceil(response.retryAfterMs / 60_000)} min`;
      logger.info("Transmitter ingestion skipped by fetch guard", { provider: PROVIDER, reason });
      await database.providerRuns.finish(runId, { status: "skipped", errorSummary: reason });
      return {
        status: "skipped",
        fetched: 0,
        inserted: 0,
        updated: 0,
        rejected: 0,
        durationMs: elapsed(),
        errorSummary: reason,
        runId,
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new Error("SatNOGS response was not valid JSON");
    }

    // Per-record validation rather than validating the array in one go: one malformed
    // entry in a community database must not discard the other forty-nine.
    const raw = Array.isArray(payload) ? payload : [];
    if (!Array.isArray(payload)) {
      throw new Error("SatNOGS transmitters response was not an array");
    }

    const accepted: SatnogsTransmitter[] = [];
    let rejected = 0;
    for (const entry of raw) {
      const parsed = satnogsTransmittersResponseSchema.element.safeParse(entry);
      if (parsed.success) accepted.push(parsed.data);
      else rejected += 1;
    }

    const records = accepted.map((transmitter) => toRecord(transmitter, response.fetchedAt));
    const { inserted, updated } = await database.radio.upsertMany(records);

    const status = rejected > 0 ? "partial" : "success";
    await database.providerRuns.finish(runId, {
      status,
      recordsFetched: raw.length,
      recordsInserted: inserted,
      recordsUnchanged: updated,
      recordsRejected: rejected,
      ...(rejected > 0
        ? { errorSummary: `${String(rejected)} transmitter record(s) failed validation` }
        : {}),
    });

    logger.info("Transmitter ingestion complete", {
      provider: PROVIDER,
      resource,
      fetched: raw.length,
      inserted,
      updated,
      rejected,
    });

    return {
      status,
      fetched: raw.length,
      inserted,
      updated,
      rejected,
      durationMs: elapsed(),
      ...(rejected > 0
        ? { errorSummary: `${String(rejected)} transmitter record(s) failed validation` }
        : {}),
      runId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await database.providerRuns.finish(runId, { status: "failed", errorSummary: message });
    logger.error("Transmitter ingestion failed", { provider: PROVIDER, resource, message });
    return {
      status: "failed",
      fetched: 0,
      inserted: 0,
      updated: 0,
      rejected: 0,
      durationMs: elapsed(),
      errorSummary: message,
      runId,
    };
  } finally {
    await database.leases.release(leaseKey, holder);
  }
}
