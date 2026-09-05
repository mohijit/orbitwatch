import type { Database, SpaceWeatherObservation } from "@orbitwatch/database";
import {
  noaaPlanetaryKIndexSchema,
  noaaScalesSchema,
  parseNoaaSolarWind,
  policyFor,
  type GuardedHttpClient,
} from "@orbitwatch/providers";

import {
  defaultHolder,
  DEFAULT_LEASE_TTL_SECONDS,
  NULL_LOGGER,
  type IngestionLogger,
} from "./ingest-elements.js";

/**
 * Ingest space weather from NOAA SWPC.
 *
 * WHY A TRACKER CARES
 * Not decoration. Elevated geomagnetic activity heats and expands the thermosphere,
 * which raises drag on everything in low orbit — so a propagated position drifts from
 * reality faster during a storm, and the accuracy this app reports for an ageing
 * element set is optimistic exactly when conditions are most disturbed. Radio blackouts
 * matter to the ground-station audience for the same directness.
 *
 * THREE PRODUCTS, ONE RUN, INDEPENDENT FAILURE
 * NOAA publishes three unrelated shapes and any of them can be unavailable on its own.
 * Each is fetched, parsed and stored separately, and one failing does not discard the
 * other two — losing the Kp series because a solar wind endpoint 500s would be trading
 * useful data for tidiness. The run is `partial` when some succeeded, `failed` only
 * when none did.
 */

const PROVIDER = "noaa-swpc";
const RESOURCE = "space-weather";
const BASE = "https://services.swpc.noaa.gov";

const PRODUCTS = {
  "planetary-k-index": `${BASE}/products/noaa-planetary-k-index.json`,
  "solar-wind": `${BASE}/products/geospace/propagated-solar-wind-1-hour.json`,
  scales: `${BASE}/products/noaa-scales.json`,
} as const;

export interface SpaceWeatherIngestionResult {
  readonly status: "success" | "partial" | "skipped" | "failed";
  readonly inserted: number;
  readonly updated: number;
  readonly durationMs: number;
  /** Which products landed, and what went wrong with the ones that did not. */
  readonly sources: Readonly<Record<string, string>>;
  readonly errorSummary?: string;
  readonly runId?: string;
}

export interface IngestSpaceWeatherOptions {
  readonly database: Database;
  readonly http: GuardedHttpClient;
  readonly holder?: string;
  readonly leaseTtlSeconds?: number;
  readonly logger?: IngestionLogger;
  readonly now?: () => Date;
}

/**
 * NOAA publishes scale levels as strings, and `null` when a level is not stated.
 *
 * Parsed rather than coerced: `Number(null)` is 0, and 0 is "none" on these scales — so
 * a missing value would silently become an all-clear. That is the single most
 * consequential mistake available in this file.
 */
function toScale(value: string | null | undefined): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 5 ? parsed : undefined;
}

const EMPTY = {
  kp: undefined,
  aRunning: undefined,
  solarWindSpeedKmS: undefined,
  solarWindDensity: undefined,
  bzNt: undefined,
  radioBlackoutScale: undefined,
  solarRadiationScale: undefined,
  geomagneticScale: undefined,
} as const;

export async function ingestSpaceWeather(
  options: IngestSpaceWeatherOptions,
): Promise<SpaceWeatherIngestionResult> {
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
  const sources: Record<string, string> = {};

  const lease = await database.leases.acquire(leaseKey, holder, leaseTtlSeconds);
  if (lease === undefined) {
    return {
      status: "skipped",
      inserted: 0,
      updated: 0,
      durationMs: elapsed(),
      sources,
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
      logger.info("Space weather ingestion skipped by durable rate guard", { reason });
      await database.leases.release(leaseKey, holder);
      return {
        status: "skipped",
        inserted: 0,
        updated: 0,
        durationMs: elapsed(),
        sources,
        errorSummary: reason,
      };
    }
  }

  const runId = await database.providerRuns.start(PROVIDER, RESOURCE);
  const observations: SpaceWeatherObservation[] = [];
  let succeeded = 0;

  try {
    for (const [source, url] of Object.entries(PRODUCTS)) {
      try {
        const response = await http.get(url, { provider: PROVIDER, resource: source });
        if (response.status === "skipped") {
          sources[source] = "skipped by fetch guard";
          continue;
        }

        const payload: unknown = JSON.parse(response.body);
        const fetchedAt = response.fetchedAt;

        if (source === "planetary-k-index") {
          const entries = noaaPlanetaryKIndexSchema.parse(payload);
          for (const entry of entries) {
            observations.push({
              ...EMPTY,
              source: "planetary-k-index",
              observedAt: entry.time_tag,
              kp: entry.Kp,
              aRunning: entry.a_running,
              retrievedAt: fetchedAt,
            });
          }
          sources[source] = `${String(entries.length)} observations`;
        } else if (source === "solar-wind") {
          const samples = parseNoaaSolarWind(payload);
          for (const sample of samples) {
            observations.push({
              ...EMPTY,
              source: "solar-wind",
              // The propagated instant is the one describing conditions AT EARTH, which
              // is what affects satellites; the raw tag is when the spacecraft upstream
              // measured it, about an hour earlier.
              observedAt: sample.propagatedTimeTag ?? sample.timeTag,
              solarWindSpeedKmS: sample.speed,
              solarWindDensity: sample.density,
              bzNt: sample.bz,
              retrievedAt: fetchedAt,
            });
          }
          sources[source] = `${String(samples.length)} samples`;
        } else {
          const scales = noaaScalesSchema.parse(payload);
          // Key "0" is current conditions; the rest are forecast days, which this
          // product does not claim to predict.
          const current = scales["0"];
          if (current !== undefined) {
            const observedAt = new Date(`${current.DateStamp}T${current.TimeStamp}Z`);
            if (!Number.isNaN(observedAt.getTime())) {
              observations.push({
                ...EMPTY,
                source: "scales",
                observedAt,
                radioBlackoutScale: toScale(current.R.Scale),
                solarRadiationScale: toScale(current.S.Scale),
                geomagneticScale: toScale(current.G.Scale),
                retrievedAt: fetchedAt,
              });
              sources[source] = "current conditions";
            } else {
              sources[source] = "unparseable timestamp";
            }
          } else {
            sources[source] = "no current entry";
          }
        }

        succeeded += 1;
      } catch (error) {
        // One product failing must not discard the others.
        sources[source] = error instanceof Error ? error.message : String(error);
        logger.warn("Space weather product failed", { source, detail: sources[source] });
      }
    }

    const { inserted, updated } = await database.spaceWeather.record(observations);

    const total = Object.keys(PRODUCTS).length;
    const status = succeeded === total ? "success" : succeeded === 0 ? "failed" : "partial";
    const errorSummary =
      status === "success"
        ? undefined
        : `${String(total - succeeded)} of ${String(total)} NOAA products failed`;

    await database.providerRuns.finish(runId, {
      status,
      recordsFetched: observations.length,
      recordsInserted: inserted,
      recordsUnchanged: updated,
      recordsRejected: 0,
      ...(errorSummary === undefined ? {} : { errorSummary }),
    });

    logger.info("Space weather ingestion complete", { inserted, updated, sources });

    return {
      status,
      inserted,
      updated,
      durationMs: elapsed(),
      sources,
      ...(errorSummary === undefined ? {} : { errorSummary }),
      runId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await database.providerRuns.finish(runId, { status: "failed", errorSummary: message });
    logger.error("Space weather ingestion failed", { message });
    return {
      status: "failed",
      inserted: 0,
      updated: 0,
      durationMs: elapsed(),
      sources,
      errorSummary: message,
      runId,
    };
  } finally {
    await database.leases.release(leaseKey, holder);
  }
}
