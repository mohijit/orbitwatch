import { z } from "zod";

/**
 * HTTP API contracts.
 *
 * Defined once here and consumed by the server, the web app and the mobile app, so a
 * response shape cannot drift away from the clients that read it. The schemas are the
 * specification; the server builds responses that satisfy them and the clients parse
 * with them, which turns a breaking change into a test failure rather than a runtime
 * surprise on a device.
 *
 * WIRE FORMAT
 * Timestamps are ISO 8601 strings in UTC. JSON has no date type, and passing epoch
 * milliseconds would lose the explicit timezone that this domain depends on. Catalog
 * identifiers are strings, never numbers — see docs/adr/0004 on Alpha-5.
 */

/** ISO 8601 instant. Kept as a string on the wire; parsed at the edges. */
export const isoTimestampSchema = z
  .string()
  .refine(
    (value) => !Number.isNaN(new Date(value).getTime()),
    "Expected an ISO 8601 timestamp",
  );

export const objectTypeSchema = z.enum(["PAYLOAD", "ROCKET BODY", "DEBRIS", "UNKNOWN"]);
export const orbitClassSchema = z.enum([
  "LEO",
  "MEO",
  "GEO",
  "GSO",
  "HEO",
  "HIGH",
  "UNKNOWN",
]);

export const propagationConfidenceSchema = z.enum([
  "NOMINAL",
  "DEGRADED",
  "EXTRAPOLATED",
  "UNRELIABLE",
]);

// ── errors ───────────────────────────────────────────────────────────────────────

/**
 * Error envelope.
 *
 * One shape for every failure, so a client has exactly one thing to handle. `code` is
 * machine-readable and stable; `message` is for humans and may change.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Present on validation failures: which field, and why. */
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

// ── health ───────────────────────────────────────────────────────────────────────

/**
 * Dependency health.
 *
 * `configured` and `healthy` are separate facts. An unconfigured shared cache is a
 * supported deployment, not a failure — reporting it as unhealthy would train
 * operators to ignore the health endpoint. A configured dependency that cannot be
 * reached is a real problem.
 */
export const dependencyHealthSchema = z.object({
  configured: z.boolean(),
  healthy: z.boolean(),
  /** Round-trip latency in milliseconds when reachable. */
  latencyMs: z.number().nonnegative().optional(),
  /** Why it is unhealthy. Never contains a credential or connection string. */
  detail: z.string().optional(),
});

export const healthResponseSchema = z.object({
  /**
   * ok        — everything configured is working.
   * degraded  — serving traffic, but something is impaired or absent.
   * unhealthy — cannot serve meaningful responses.
   */
  status: z.enum(["ok", "degraded", "unhealthy"]),
  time: isoTimestampSchema,
  uptimeSeconds: z.number().nonnegative(),
  version: z.string(),
  dependencies: z.object({
    database: dependencyHealthSchema,
    cache: dependencyHealthSchema,
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

// ── provider status ──────────────────────────────────────────────────────────────

export const providerRunStatusSchema = z.enum([
  "running",
  "success",
  "partial",
  "failed",
  "skipped",
]);

/**
 * One provider resource's ingestion state.
 *
 * `lastRun` and `lastSuccess` are deliberately both present. A provider failing right
 * now is close to healthy if it succeeded twenty minutes ago and badly degraded if it
 * last succeeded three days ago, and only both facts together distinguish the two.
 */
export const providerStatusSchema = z.object({
  provider: z.string(),
  resource: z.string(),
  /**
   * Whether this provider's schema has been validated against a real production
   * response. Documentation-derived schemas are fine for development but do not make a
   * provider verified, and the API states which is which rather than implying trust.
   */
  verified: z.boolean(),
  lastRun: z
    .object({
      status: providerRunStatusSchema,
      startedAt: isoTimestampSchema,
      completedAt: isoTimestampSchema.optional(),
      recordsFetched: z.number().int().nonnegative(),
      recordsInserted: z.number().int().nonnegative(),
      recordsUnchanged: z.number().int().nonnegative(),
      recordsRejected: z.number().int().nonnegative(),
      errorSummary: z.string().optional(),
    })
    .optional(),
  lastSuccessAt: isoTimestampSchema.optional(),
  /** Age of the last success in seconds, so a client need not compute it. */
  lastSuccessAgeSeconds: z.number().nonnegative().optional(),
  /** healthy | stale | failing | never-succeeded */
  freshness: z.enum(["healthy", "stale", "failing", "never-succeeded"]),
});

export const providerStatusResponseSchema = z.object({
  time: isoTimestampSchema,
  providers: z.array(providerStatusSchema),
});

export type ProviderStatus = z.infer<typeof providerStatusSchema>;
export type ProviderStatusResponse = z.infer<typeof providerStatusResponseSchema>;

// ── satellites ───────────────────────────────────────────────────────────────────

export const satelliteSchema = z.object({
  catalogId: z.string(),
  name: z.string(),
  internationalDesignator: z.string().optional(),
  objectType: objectTypeSchema,
  operationalStatus: z.string().optional(),
  owner: z.string().optional(),
  launchDate: isoTimestampSchema.optional(),
  launchSite: z.string().optional(),
  decayDate: isoTimestampSchema.optional(),
  periodMinutes: z.number().optional(),
  inclinationDegrees: z.number().optional(),
  apogeeKm: z.number().optional(),
  perigeeKm: z.number().optional(),
  rcsSquareMetres: z.number().optional(),
  orbitClass: orbitClassSchema.optional(),
});

export type Satellite = z.infer<typeof satelliteSchema>;

export const satelliteListResponseSchema = z.object({
  satellites: z.array(satelliteSchema),
  /** Total matching the filter, not the page size. Drives pagination controls. */
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export type SatelliteListResponse = z.infer<typeof satelliteListResponseSchema>;

// ── orbital elements ─────────────────────────────────────────────────────────────

/**
 * How much to trust a propagation from this element set to a given time.
 *
 * Served alongside the elements rather than left to the client, so web and mobile
 * cannot disagree about whether a position is trustworthy. `renderable: false` means
 * the client must refuse to draw a position: an authoritative-looking wrong answer is
 * worse than an honest gap.
 */
export const accuracySchema = z.object({
  confidence: propagationConfidenceSchema,
  hoursFromEpoch: z.number(),
  backwards: z.boolean(),
  label: z.string(),
  warning: z.string().optional(),
  renderable: z.boolean(),
});

/**
 * An element set as served.
 *
 * `epoch` and `retrievedAt` are both present and are different facts: elements fetched
 * two minutes ago can describe an orbit from eighteen hours ago. Conflating them is the
 * single most common way a tracker misrepresents how live it is.
 */
export const orbitalElementsSchema = z.object({
  catalogId: z.string(),
  provider: z.string(),
  format: z.enum(["OMM_JSON", "TLE"]),
  epoch: isoTimestampSchema,
  retrievedAt: isoTimestampSchema,
  /** The full OMM record as published, for the raw-data view and provenance. */
  omm: z.record(z.string(), z.unknown()),
  tleLine1: z.string().optional(),
  tleLine2: z.string().optional(),
  meanMotion: z.number(),
  eccentricity: z.number(),
  inclination: z.number(),
  bstar: z.number().optional(),
});

export type OrbitalElements = z.infer<typeof orbitalElementsSchema>;

export const elementsResponseSchema = z.object({
  elements: orbitalElementsSchema,
  /** Assessed against the requested time, which defaults to now. */
  accuracy: accuracySchema,
  /** The instant the accuracy was assessed for. */
  assessedFor: isoTimestampSchema,
});

export type ElementsResponse = z.infer<typeof elementsResponseSchema>;

export const elementHistoryResponseSchema = z.object({
  catalogId: z.string(),
  history: z.array(orbitalElementsSchema),
});

export type ElementHistoryResponse = z.infer<typeof elementHistoryResponseSchema>;

/**
 * Bulk element sets for whole-catalog propagation.
 *
 * The globe needs every object at once, and the client propagates locally. Serving
 * elements rather than positions is what keeps the animation smooth without the server
 * computing positions at frame rate.
 */
export const catalogElementsResponseSchema = z.object({
  time: isoTimestampSchema,
  count: z.number().int().nonnegative(),
  elements: z.array(orbitalElementsSchema),
});

export type CatalogElementsResponse = z.infer<typeof catalogElementsResponseSchema>;

/**
 * Membership of a provider-published group.
 *
 * Catalog IDs only, deliberately. The client already holds every element set for the
 * globe, so sending the elements again would be a second copy of data it has; what it
 * cannot derive is WHICH objects are in the group. That is the whole payload.
 *
 * `observedAt` is when the provider last listed this membership, not when this response
 * was built. A group whose membership is a week stale is a different claim from one
 * refreshed an hour ago, and the client is entitled to say so.
 */
export const catalogGroupResponseSchema = z.object({
  provider: z.string(),
  group: z.string(),
  count: z.number().int().nonnegative(),
  catalogIds: z.array(z.string()),
  observedAt: isoTimestampSchema.optional(),
});

export type CatalogGroupResponse = z.infer<typeof catalogGroupResponseSchema>;

// ── query parameters ─────────────────────────────────────────────────────────────

/** Bounded so a client cannot request the entire catalog in one page by accident. */
export const MAX_PAGE_SIZE = 500;

export const satelliteQuerySchema = z.object({
  search: z.string().trim().min(1).max(100).optional(),
  objectType: z.array(objectTypeSchema).optional(),
  orbitClass: z.array(orbitClassSchema).optional(),
  owner: z.array(z.string().max(50)).optional(),
  includeDecayed: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export type SatelliteQuery = z.infer<typeof satelliteQuerySchema>;

// ── observer ─────────────────────────────────────────────────────────────────────

/**
 * A place someone is observing from.
 *
 * Lives in contracts rather than in the web app because every platform needs it and
 * they must agree byte for byte: the M6 gate asserts that web and native compute the
 * same look angles and pass times from the same observer, which is only meaningful if
 * "the same observer" has one definition. It is also what the web app persists to
 * local storage, so this schema doubles as the validator for data that has been
 * sitting in a browser across app versions.
 *
 * Altitude is in KILOMETRES, matching orbit-core, and is above the WGS-84 ellipsoid
 * rather than above sea level. The distinction is worth tens of metres, which is far
 * below anything this affects, but naming it stops the two being silently mixed.
 */
export const observerLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /**
   * Bounded well beyond any inhabited elevation. The point is not to police altitude
   * but to reject nonsense — a metres value pasted into a kilometres field turns
   * Everest into 8,849 km and puts the observer above most of the catalog.
   */
  altitude: z.number().min(-0.5).max(20),
  label: z.string().min(1).max(120).optional(),
});

export type ObserverLocationInput = z.infer<typeof observerLocationSchema>;

/** How the observer's position was obtained. Shown in the UI; never guessed. */
export const observerSourceSchema = z.enum(["DEVICE", "GLOBE", "MANUAL"]);

export type ObserverSource = z.infer<typeof observerSourceSchema>;

/**
 * A stored observer, with provenance and an accuracy figure when the source has one.
 *
 * `accuracyMetres` comes from the Geolocation API and is only ever present for a
 * DEVICE fix. A hand-entered coordinate has no meaningful accuracy, and inventing one
 * would misrepresent it.
 */
export const storedObserverSchema = observerLocationSchema.extend({
  source: observerSourceSchema,
  accuracyMetres: z.number().positive().optional(),
  savedAt: isoTimestampSchema,
});

export type StoredObserver = z.infer<typeof storedObserverSchema>;
