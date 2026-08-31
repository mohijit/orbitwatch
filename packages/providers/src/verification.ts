import type { ProviderId } from "./policy.js";

/**
 * Provider verification registry.
 *
 * The single machine-readable source of truth for whether a provider's schema has been
 * validated against a real production response. It previously lived only in file
 * comments and the README, which meant the API could describe a provider as working
 * while the schema behind it had never seen live data.
 *
 * THE GATE
 * A provider is VERIFIED only when all four of these hold:
 *   1. a real production request succeeded,
 *   2. the response was captured as a fixture with recorded provenance,
 *   3. the Zod schema validates that captured response unmodified, and
 *   4. parsing tests were built from that fixture.
 *
 * A successful request alone is not verification, and a documentation-derived schema is
 * never verification. Fixtures are never fabricated to close the gap.
 *
 * Provenance for every entry is in `fixtures/manifest.json`.
 */

export type VerificationStatus =
  /** Schema validated against a captured real production response. */
  | "VERIFIED"
  /** Schema derived from documentation. Fine for development; not verified. */
  | "UNVERIFIED"
  /** Verification attempted and prevented by the environment, not by our code. */
  | "BLOCKED";

export interface ProviderVerification {
  readonly status: VerificationStatus;
  /** The exact resource a successful verification exercised. */
  readonly endpoint?: string;
  /** When the verifying response was captured. */
  readonly verifiedAt?: string;
  /** Why it is blocked or unverified. Present for everything except VERIFIED. */
  readonly reason?: string;
}

export const PROVIDER_VERIFICATION: Readonly<Record<ProviderId, ProviderVerification>> = {
  "launch-library": {
    status: "VERIFIED",
    endpoint: "https://ll.thespacedevs.com/2.3.0/launches/upcoming/",
    verifiedAt: "2026-08-31T12:51:37.046Z",
  },
  "noaa-swpc": {
    status: "VERIFIED",
    endpoint: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
    verifiedAt: "2026-08-31T12:32:11.668Z",
  },
  wheretheiss: {
    status: "VERIFIED",
    endpoint: "https://api.wheretheiss.at/v1/satellites/25544",
    verifiedAt: "2026-08-31T12:28:07.522Z",
  },

  // Unreachable from the development network. The schemas are written from CelesTrak's
  // documentation and are explicitly not verified — see schemas/celestrak.ts.
  "celestrak-gp": {
    status: "BLOCKED",
    endpoint: "https://celestrak.org/NORAD/elements/gp.php",
    reason:
      "TCP connect never completes from the development network (SYN blocked). " +
      "Reproduced with curl over both IPv4 and IPv6, and via an independent fetch service.",
  },
  "celestrak-satcat": {
    status: "BLOCKED",
    endpoint: "https://celestrak.org/satcat/records.php",
    reason: "Same host and same TCP connect failure as celestrak-gp.",
  },
  "satnogs-db": {
    status: "BLOCKED",
    endpoint: "https://db.satnogs.org/api/transmitters/",
    reason:
      "TCP connect and TLS handshake succeed, then the server returns no bytes before " +
      "timeout. Reproduced on the cheapest available endpoint.",
  },

  // Not yet attempted. These belong to milestones that have not started, and a request
  // we have never made must not be reported as anything other than unverified.
  "celestrak-socrates": {
    status: "UNVERIFIED",
    reason: "Conjunction ingestion is M7 work; no request has been made yet.",
  },
  "satnogs-network": {
    status: "UNVERIFIED",
    reason: "Ground-station data is M7 work; no request has been made yet.",
  },
  "nasa-donki": {
    status: "UNVERIFIED",
    reason: "DONKI ingestion is M7 work; no request has been made yet.",
  },
} as const;

export function verificationFor(id: ProviderId): ProviderVerification {
  return PROVIDER_VERIFICATION[id];
}

/**
 * Whether a provider may be described as integrated.
 *
 * BLOCKED is not a softer VERIFIED. It records that the failure is environmental rather
 * than a defect in our adapter, and nothing more — it still means the schema has never
 * met real data.
 */
export function isVerified(id: ProviderId): boolean {
  return PROVIDER_VERIFICATION[id].status === "VERIFIED";
}
