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

// Provider response schemas, each validated against a real captured production
// response. See fixtures/manifest.json for provenance.
export * from "./schemas/noaa.js";
export * from "./schemas/launch-library.js";
export * from "./schemas/wheretheiss.js";
