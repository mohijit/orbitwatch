export {
  FetchGuard,
  FetchGuardStateError,
  type GuardDecision,
  type FetchGuardOptions,
} from "./fetch-guard.js";

export {
  GuardedHttpClient,
  ProviderHttpError,
  ProviderRefusedError,
  type GuardedFetchOptions,
  type GuardedFetchResult,
} from "./http.js";

export {
  PROVIDER_POLICIES,
  policyFor,
  type ProviderId,
  type ProviderPolicy,
} from "./policy.js";

// The machine-readable answer to "has this provider ever been validated against a real
// production response?" Used by the API's /providers/status so the claim cannot drift
// away from a source comment.
export {
  PROVIDER_VERIFICATION,
  isVerified,
  verificationFor,
  type ProviderVerification,
  type VerificationStatus,
} from "./verification.js";

// Provider response schemas, each validated against a real captured production
// response. See fixtures/manifest.json for provenance.
export * from "./schemas/noaa.js";
export * from "./schemas/launch-library.js";
export * from "./schemas/wheretheiss.js";

// CelesTrak schemas. NOT verified against a live response — see the file header.
export * from "./schemas/celestrak.js";
