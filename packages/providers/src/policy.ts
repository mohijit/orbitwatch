/**
 * Per-provider access policy.
 *
 * Every value here is derived from the provider's published terms, not guessed.
 * Changing a number in this file changes how aggressively we contact a third party,
 * so each entry carries a citation.
 */

export interface ProviderPolicy {
  readonly id: ProviderId;
  readonly displayName: string;
  /**
   * Minimum milliseconds between successful downloads of the same resource.
   * Enforced by FetchGuard across process restarts.
   */
  readonly minIntervalMs: number;
  /** Freshness thresholds for the UI's DataFreshnessBadge, in milliseconds. */
  readonly freshness: { readonly freshMs: number; readonly agingMs: number };
  /** Whether a credential is required for normal public operation. */
  readonly requiresCredential: boolean;
  /** Human-readable attribution string, surfaced in About → Data Sources. */
  readonly attribution: string;
  /** Why the interval is what it is. */
  readonly policyNote: string;
}

export type ProviderId =
  | "celestrak-gp"
  | "celestrak-satcat"
  | "celestrak-socrates"
  | "satnogs-db"
  | "satnogs-network"
  | "launch-library"
  | "noaa-swpc"
  | "nasa-donki"
  | "wheretheiss";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const PROVIDER_POLICIES: Readonly<Record<ProviderId, ProviderPolicy>> = {
  "celestrak-gp": {
    id: "celestrak-gp",
    displayName: "CelesTrak GP",
    // CelesTrak publishes GP updates roughly every 2 hours and permits ONE download
    // per update cycle. We add a 10-minute margin so clock skew between our host and
    // theirs can never push us into a second request inside the same cycle.
    minIntervalMs: 2 * HOUR + 10 * MINUTE,
    freshness: { freshMs: 2 * HOUR, agingMs: 8 * HOUR },
    requiresCredential: false,
    attribution: "Orbital data courtesy of CelesTrak (celestrak.org).",
    policyNote:
      "One download per ~2h update cycle. A second request in the same cycle returns " +
      "HTTP 403; repeated violations result in IP-level firewall blocking.",
  },
  "celestrak-satcat": {
    id: "celestrak-satcat",
    displayName: "CelesTrak SATCAT",
    // Catalog metadata changes slowly (launches, decays, status changes).
    minIntervalMs: 1 * DAY,
    freshness: { freshMs: 2 * DAY, agingMs: 7 * DAY },
    requiresCredential: false,
    attribution: "Satellite catalog metadata courtesy of CelesTrak (celestrak.org).",
    policyNote: "Metadata changes slowly; daily refresh is ample and respects the host.",
  },
  "celestrak-socrates": {
    id: "celestrak-socrates",
    displayName: "CelesTrak SOCRATES Plus",
    // SOCRATES runs on its own publication cycle; 8h keeps us well inside it.
    minIntervalMs: 8 * HOUR,
    freshness: { freshMs: 12 * HOUR, agingMs: 36 * HOUR },
    requiresCredential: false,
    attribution: "Conjunction data courtesy of CelesTrak SOCRATES Plus (celestrak.org).",
    policyNote:
      "Published as CSV on a fixed cycle. Informational/educational only — never " +
      "presented as operational collision-avoidance guidance.",
  },
  "satnogs-db": {
    id: "satnogs-db",
    displayName: "SatNOGS DB",
    minIntervalMs: 6 * HOUR,
    freshness: { freshMs: 12 * HOUR, agingMs: 3 * DAY },
    requiresCredential: false,
    attribution:
      "Transmitter data from SatNOGS DB (db.satnogs.org), licensed CC BY-SA 4.0.",
    policyNote: "Transmitter records change infrequently; 6h refresh is generous.",
  },
  "satnogs-network": {
    id: "satnogs-network",
    displayName: "SatNOGS Network",
    minIntervalMs: 1 * HOUR,
    freshness: { freshMs: 2 * HOUR, agingMs: 12 * HOUR },
    requiresCredential: false,
    attribution: "Ground station data from SatNOGS Network (network.satnogs.org).",
    policyNote: "Station status changes hourly at most.",
  },
  "launch-library": {
    id: "launch-library",
    displayName: "Launch Library 2",
    // 15 requests/hour unauthenticated. At one request per 15 minutes for each of a
    // small number of resources we stay far inside that ceiling.
    minIntervalMs: 15 * MINUTE,
    freshness: { freshMs: 30 * MINUTE, agingMs: 3 * HOUR },
    requiresCredential: false,
    attribution: "Launch data from Launch Library 2 by The Space Devs (thespacedevs.com).",
    policyNote:
      "15 requests/hour for unauthenticated clients. Never called from a browser; " +
      "all access is server-side and cached.",
  },
  "noaa-swpc": {
    id: "noaa-swpc",
    displayName: "NOAA SWPC",
    minIntervalMs: 5 * MINUTE,
    freshness: { freshMs: 15 * MINUTE, agingMs: 1 * HOUR },
    requiresCredential: false,
    attribution: "Space weather data from NOAA Space Weather Prediction Center.",
    policyNote: "Public JSON products, no key required. Data changes on minute scales.",
  },
  "nasa-donki": {
    id: "nasa-donki",
    displayName: "NASA DONKI",
    minIntervalMs: 30 * MINUTE,
    freshness: { freshMs: 1 * HOUR, agingMs: 6 * HOUR },
    // DEMO_KEY works but is heavily throttled; a real key is recommended in production.
    requiresCredential: false,
    attribution: "Solar event data from NASA DONKI (api.nasa.gov).",
    policyNote:
      "DEMO_KEY is rate limited to ~30 requests/hour per IP. Set NASA_API_KEY for " +
      "production use.",
  },
  wheretheiss: {
    id: "wheretheiss",
    displayName: "WhereTheISS.at",
    // Used only for independent verification of our own SGP4 output, never to drive
    // the animation. Their documented guidance is roughly 1 request/second; we are
    // far more conservative because this is a correctness check, not a data feed.
    minIntervalMs: 1 * MINUTE,
    freshness: { freshMs: 5 * MINUTE, agingMs: 30 * MINUTE },
    requiresCredential: false,
    attribution: "ISS position cross-check from WhereTheISS.at.",
    policyNote:
      "Verification only. The ISS animation is always driven by local SGP4 " +
      "propagation, never by polling this endpoint.",
  },
} as const;

export function policyFor(id: ProviderId): ProviderPolicy {
  return PROVIDER_POLICIES[id];
}
