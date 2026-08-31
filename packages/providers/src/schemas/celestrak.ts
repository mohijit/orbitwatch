import { z } from "zod";

/**
 * CelesTrak GP (OMM) and SATCAT schemas.
 *
 * VERIFICATION STATUS: **VERIFIED** against real production responses captured from CI
 * on 2026-08-31. celestrak.org is unreachable from the development network, so the
 * verification runs on a GitHub runner, which has ordinary access. Provenance is in
 * fixtures/manifest.json.
 *
 * Confirmed against the live response rather than the documentation:
 *   * EPOCH carries NO timezone designator ("2026-08-31T03:26:51.705600"). It is UTC,
 *     and parsing it with a bare new Date() applies the host offset instead.
 *   * NORAD_CAT_ID arrives as a JSON number from CelesTrak and as a string from
 *     Space-Track. Both are accepted; it is stored as text (Alpha-5, ADR 0004).
 *   * SATCAT uses EMPTY STRINGS for absent values, not null.
 *   * OBJECT_TYPE is the short code "PAY" and OPS_STATUS_CODE is "+".
 */

/** Marks a schema whose shape has not been confirmed against live data. */
export const CELESTRAK_VERIFICATION_STATUS = "VERIFIED" as const;

/**
 * SATCAT sends an EMPTY STRING for absent values, not null and not an omitted key.
 * Observed in the real response: DECAY_DATE and DATA_STATUS_CODE both arrive as "".
 *
 * This matters more than it looks. An empty DECAY_DATE that survives as a string is
 * present enough for a presence check, so a live object would be recorded as decayed
 * and silently dropped from the catalog - the ISS included. Normalised at the edge.
 */
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional().nullable(),
  );

/**
 * Numeric fields arrive as JSON numbers from CelesTrak and as strings from
 * Space-Track. Accepting both is documented behaviour of the OMM standard, not
 * defensive guessing: the spec does not pin the JSON type.
 */
const numeric = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isFinite(parsed)) {
    ctx.addIssue({ code: "custom", message: `Expected a numeric value, got "${value}"` });
    return z.NEVER;
  }
  return parsed;
});

/**
 * A single GP record in OMM JSON form.
 *
 * Only fields SGP4 needs, plus identification, are required. CelesTrak omits several
 * fields the CCSDS spec marks mandatory (CCSDS_OMM_VERS, REF_FRAME, TIME_SYSTEM), so
 * requiring them would reject every real response.
 *
 * `.passthrough()` keeps unmodelled fields, which are stored verbatim in the
 * `omm` JSONB column for provenance and the raw-data tab.
 */
export const celestrakGpRecordSchema = z
  .object({
    OBJECT_NAME: z.string(),
    OBJECT_ID: z.string().optional(),
    // No timezone designator in CelesTrak output. Parsed as UTC by orbit-core's
    // parseUtcTimestamp; parsing it with new Date() would apply the host offset.
    EPOCH: z.string(),
    MEAN_MOTION: numeric,
    // Mirrors the database CHECK constraint. An eccentricity outside [0, 1) is not a
    // closed orbit and cannot be propagated by SGP4.
    ECCENTRICITY: numeric.refine(
      (value) => value >= 0 && value < 1,
      "ECCENTRICITY must be within [0, 1) for a closed orbit",
    ),
    INCLINATION: numeric,
    RA_OF_ASC_NODE: numeric,
    ARG_OF_PERICENTER: numeric,
    MEAN_ANOMALY: numeric,
    EPHEMERIS_TYPE: z.union([z.literal(0), z.literal("0")]).optional(),
    CLASSIFICATION_TYPE: z.string().optional(),
    // String, never a number: see docs/adr/0004 on Alpha-5 identifiers.
    NORAD_CAT_ID: z.union([z.number(), z.string()]),
    ELEMENT_SET_NO: numeric.optional(),
    REV_AT_EPOCH: numeric.optional(),
    BSTAR: numeric,
    MEAN_MOTION_DOT: numeric,
    MEAN_MOTION_DDOT: numeric.optional(),
  })
  .passthrough();

export const celestrakGpResponseSchema = z.array(celestrakGpRecordSchema);

export type CelestrakGpRecord = z.infer<typeof celestrakGpRecordSchema>;

/**
 * SATCAT metadata record.
 *
 * Almost everything is optional: SATCAT carries sparse data for older and classified
 * objects, and rejecting a row because it has no launch site would silently drop a
 * large part of the catalog.
 */
export const celestrakSatcatRecordSchema = z
  .object({
    OBJECT_NAME: z.string(),
    OBJECT_ID: z.string().optional(),
    NORAD_CAT_ID: z.union([z.number(), z.string()]),
    OBJECT_TYPE: z.string().optional(),
    OPS_STATUS_CODE: emptyToUndefined(z.string()),
    OWNER: emptyToUndefined(z.string()),
    LAUNCH_DATE: emptyToUndefined(z.string()),
    LAUNCH_SITE: emptyToUndefined(z.string()),
    DECAY_DATE: emptyToUndefined(z.string()),
    PERIOD: numeric.optional().nullable(),
    INCLINATION: numeric.optional().nullable(),
    APOGEE: numeric.optional().nullable(),
    PERIGEE: numeric.optional().nullable(),
    RCS: numeric.optional().nullable(),
    DATA_STATUS_CODE: emptyToUndefined(z.string()),
    ORBIT_CENTER: emptyToUndefined(z.string()),
    ORBIT_TYPE: emptyToUndefined(z.string()),
  })
  .passthrough();

export const celestrakSatcatResponseSchema = z.array(celestrakSatcatRecordSchema);

export type CelestrakSatcatRecord = z.infer<typeof celestrakSatcatRecordSchema>;

/**
 * Normalise the SATCAT object type.
 *
 * CelesTrak uses short codes. Anything unrecognised becomes UNKNOWN rather than being
 * guessed: mislabelling debris as a payload would put it in the wrong filter and the
 * wrong visual category.
 */
export function normalizeObjectType(
  raw: string | undefined,
): "PAYLOAD" | "ROCKET BODY" | "DEBRIS" | "UNKNOWN" {
  switch (raw?.trim().toUpperCase()) {
    case "PAY":
    case "PAYLOAD":
      return "PAYLOAD";
    case "R/B":
    case "ROCKET BODY":
      return "ROCKET BODY";
    case "DEB":
    case "DEBRIS":
      return "DEBRIS";
    default:
      return "UNKNOWN";
  }
}

/**
 * Normalise the operational status code.
 *
 * Returns the raw code when unrecognised rather than inventing a status. The product
 * must not assert that an object is operational when the catalog did not say so.
 */
export function normalizeOperationalStatus(raw: string | undefined): string | undefined {
  const code = raw?.trim().toUpperCase();
  if (code === undefined || code === "") return undefined;

  const known: Record<string, string> = {
    "+": "OPERATIONAL",
    "-": "NONOPERATIONAL",
    P: "PARTIALLY OPERATIONAL",
    B: "BACKUP/STANDBY",
    S: "SPARE",
    X: "EXTENDED MISSION",
    D: "DECAYED",
    "?": "UNKNOWN",
  };
  return known[code] ?? code;
}

/**
 * CelesTrak GP query parameters.
 *
 * Modelled as a closed union rather than a free-form string so no caller can
 * construct an arbitrary upstream URL.
 */
export type CelestrakGpQuery =
  | { readonly kind: "CATNR"; readonly value: string }
  | { readonly kind: "INTDES"; readonly value: string }
  | { readonly kind: "GROUP"; readonly value: CelestrakGroup }
  | { readonly kind: "NAME"; readonly value: string }
  | { readonly kind: "SPECIAL"; readonly value: string };

/**
 * Supported CelesTrak groups.
 *
 * Deliberately a small set. Groups overlap heavily — `active` already contains most
 * of `stations`, `gnss` and `starlink` — and fetching overlapping groups would consume
 * several of our once-per-cycle download budgets to obtain mostly the same objects.
 * The ingestion strategy is: fetch `active` as the catalog backbone, and fetch a
 * narrow group only when it carries objects `active` omits.
 */
export const CELESTRAK_GROUPS = [
  "active",
  "stations",
  "visual",
  "geo",
  "gnss",
  "starlink",
  "oneweb",
  "iridium-NEXT",
  "amateur",
  "weather",
  "resource",
  "science",
  "last-30-days",
  "cosmos-2251-debris",
  "iridium-33-debris",
] as const;

export type CelestrakGroup = (typeof CELESTRAK_GROUPS)[number];

const GP_BASE_URL = "https://celestrak.org/NORAD/elements/gp.php";
const SATCAT_BASE_URL = "https://celestrak.org/satcat/records.php";

/** Build a GP request URL. The only place a CelesTrak GP URL is constructed. */
export function buildGpUrl(query: CelestrakGpQuery): string {
  const url = new URL(GP_BASE_URL);
  url.searchParams.set(query.kind, query.value);
  url.searchParams.set("FORMAT", "json");
  return url.toString();
}

/** Build a SATCAT request URL. */
export function buildSatcatUrl(
  query: { readonly kind: "CATNR" | "GROUP"; readonly value: string },
): string {
  const url = new URL(SATCAT_BASE_URL);
  url.searchParams.set(query.kind, query.value);
  url.searchParams.set("FORMAT", "json");
  return url.toString();
}

/** Stable resource key for the fetch guard and provider_runs. */
export function gpResourceKey(query: CelestrakGpQuery): string {
  return `${query.kind.toLowerCase()}-${query.value.toLowerCase()}`;
}

/**
 * Parse a GP response, separating valid records from rejected ones.
 *
 * A single malformed record must not discard an entire 20,000-object download, so
 * validation is per-record. Rejections are counted and reported through
 * provider_runs, which is what makes an upstream schema change visible rather than
 * silent.
 */
export function parseGpResponse(input: unknown): {
  readonly records: readonly CelestrakGpRecord[];
  readonly rejected: readonly { index: number; reason: string }[];
} {
  if (!Array.isArray(input)) {
    return {
      records: [],
      rejected: [{ index: -1, reason: "Response was not a JSON array" }],
    };
  }

  const records: CelestrakGpRecord[] = [];
  const rejected: { index: number; reason: string }[] = [];

  for (const [index, raw] of input.entries()) {
    const parsed = celestrakGpRecordSchema.safeParse(raw);
    if (parsed.success) records.push(parsed.data);
    else {
      rejected.push({
        index,
        reason: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      });
    }
  }

  return { records, rejected };
}

/** Parse a SATCAT response, separating valid records from rejected ones. */
export function parseSatcatResponse(input: unknown): {
  readonly records: readonly CelestrakSatcatRecord[];
  readonly rejected: readonly { index: number; reason: string }[];
} {
  if (!Array.isArray(input)) {
    return {
      records: [],
      rejected: [{ index: -1, reason: "Response was not a JSON array" }],
    };
  }

  const records: CelestrakSatcatRecord[] = [];
  const rejected: { index: number; reason: string }[] = [];

  for (const [index, raw] of input.entries()) {
    const parsed = celestrakSatcatRecordSchema.safeParse(raw);
    if (parsed.success) records.push(parsed.data);
    else {
      rejected.push({
        index,
        reason: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      });
    }
  }

  return { records, rejected };
}
