import type { OrbitalElements, ProviderStatus, Satellite } from "@orbitwatch/contracts";
import type {
  OrbitalElementRecord,
  ProviderRunRecord,
  SatelliteRecord,
} from "@orbitwatch/database";

/**
 * Storage records to wire responses.
 *
 * A deliberate boundary rather than serialising database rows directly. Storage carries
 * fields the API has no business exposing — provenance metadata, internal row ids — and
 * an accidental `res.send(row)` is how those leak. Mapping explicitly means every new
 * column is an opt-in decision.
 *
 * Dates become ISO 8601 strings here and nowhere else.
 */

function iso(value: Date | undefined): string | undefined {
  return value?.toISOString();
}

/** Drop undefined keys so an optional field is absent rather than `"x": undefined`. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

export function toSatellite(record: SatelliteRecord): Satellite {
  return compact({
    catalogId: record.catalogId,
    name: record.name,
    internationalDesignator: record.internationalDesignator,
    objectType: record.objectType,
    operationalStatus: record.operationalStatus,
    owner: record.owner,
    launchDate: iso(record.launchDate),
    launchSite: record.launchSite,
    decayDate: iso(record.decayDate),
    periodMinutes: record.periodMinutes,
    inclinationDegrees: record.inclinationDegrees,
    apogeeKm: record.apogeeKm,
    perigeeKm: record.perigeeKm,
    rcsSquareMetres: record.rcsSquareMetres,
    orbitClass: record.orbitClass,
    // `metadata` and `sourceProvider` are intentionally not exposed: provenance is an
    // internal concern, and metadata is unvalidated provider passthrough.
  }) as Satellite;
}

export function toOrbitalElements(record: OrbitalElementRecord): OrbitalElements {
  return compact({
    catalogId: record.catalogId,
    provider: record.provider,
    format: record.format,
    // Epoch and retrieval time are separate facts and both reach the client. The UI
    // cannot honestly say "elements from 3h ago, retrieved 20m ago" without both.
    epoch: record.epoch.toISOString(),
    retrievedAt: record.retrievedAt.toISOString(),
    omm: record.omm,
    tleLine1: record.tleLine1,
    tleLine2: record.tleLine2,
    meanMotion: record.meanMotion,
    eccentricity: record.eccentricity,
    inclination: record.inclination,
    bstar: record.bstar,
    // The row id is not exposed: it is a storage detail, and publishing it invites
    // clients to depend on our insert order.
  }) as OrbitalElements;
}

/**
 * How stale a provider's data is allowed to get before it stops being "healthy".
 *
 * CelesTrak republishes GP data roughly every two hours, so a successful run within
 * that window is fully current. Six hours means we have missed several cycles, which is
 * worth surfacing even though the data still propagates perfectly well.
 */
const HEALTHY_MAX_AGE_SECONDS = 3 * 3600;
const STALE_MAX_AGE_SECONDS = 24 * 3600;

/**
 * Classify a provider's freshness.
 *
 * The distinction that matters operationally: `failing` means the most recent attempt
 * errored, `stale` means attempts are succeeding but not recently enough, and
 * `never-succeeded` means there is no last-known-good state at all — which is the only
 * one of the three where we have nothing to serve.
 */
function classifyFreshness(
  lastRun: ProviderRunRecord | undefined,
  lastSuccess: ProviderRunRecord | undefined,
  now: Date,
): ProviderStatus["freshness"] {
  if (lastSuccess === undefined) return "never-succeeded";

  const ageSeconds = (now.getTime() - lastSuccess.startedAt.getTime()) / 1000;

  // A currently-failing provider is reported as failing even when its last success is
  // recent: the operator needs to know it is broken now, before the data goes stale.
  if (lastRun !== undefined && lastRun.status === "failed") return "failing";

  if (ageSeconds > STALE_MAX_AGE_SECONDS) return "failing";
  if (ageSeconds > HEALTHY_MAX_AGE_SECONDS) return "stale";
  return "healthy";
}

export function toProviderStatus(input: {
  readonly provider: string;
  readonly resource: string;
  readonly verified: boolean;
  readonly lastRun: ProviderRunRecord | undefined;
  readonly lastSuccess: ProviderRunRecord | undefined;
  readonly now: Date;
}): ProviderStatus {
  const { lastRun, lastSuccess, now } = input;

  const ageSeconds =
    lastSuccess === undefined
      ? undefined
      : Math.max(0, (now.getTime() - lastSuccess.startedAt.getTime()) / 1000);

  return compact({
    provider: input.provider,
    resource: input.resource,
    verified: input.verified,
    lastRun:
      lastRun === undefined
        ? undefined
        : compact({
            status: lastRun.status,
            startedAt: lastRun.startedAt.toISOString(),
            completedAt: iso(lastRun.completedAt),
            recordsFetched: lastRun.recordsFetched,
            recordsInserted: lastRun.recordsInserted,
            recordsUnchanged: lastRun.recordsUnchanged,
            recordsRejected: lastRun.recordsRejected,
            errorSummary: lastRun.errorSummary,
          }),
    lastSuccessAt: iso(lastSuccess?.startedAt),
    lastSuccessAgeSeconds: ageSeconds,
    freshness: classifyFreshness(lastRun, lastSuccess, now),
  }) as ProviderStatus;
}
