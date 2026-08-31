import { z } from "zod";

/**
 * SatNOGS DB schemas: satellite records and transmitters.
 *
 * VERIFICATION STATUS: **VERIFIED** against real production responses captured from CI
 * on 2026-08-31 (db.satnogs.org completes TLS from the development network and then
 * returns no bytes before timeout; a GitHub runner has ordinary access). Provenance is
 * in fixtures/manifest.json.
 *
 * Confirmed against the live response rather than assumption:
 *   * `sat_id` is SatNOGS's own opaque identifier (e.g. "XSKZ-5603-1870-9019-3066"),
 *     NOT the NORAD catalog number. `norad_cat_id` is the join key back to our catalog.
 *   * Several numeric-shaped fields are legitimately null: `uplink_high`,
 *     `uplink_drift`, `downlink_high`, `downlink_drift`, `baud`, `norad_follow_id`.
 *   * `updated` has NO timezone designator on the seconds fraction pattern used
 *     elsewhere in this codebase — parsed the same way, as UTC.
 *   * `itu_notification` is an object `{ urls: [] }`, not a boolean or string.
 */

export const SATNOGS_VERIFICATION_STATUS = "VERIFIED" as const;

/** Transmitter operational status, as SatNOGS actually sends it (lowercase). */
export const satnogsTransmitterStatusSchema = z.enum(["active", "inactive", "suspended"]);

/**
 * A single transmitter record.
 *
 * `.passthrough()` keeps fields we do not model (`iaru_coordination`, `citation`,
 * `params`, ...) so they remain available for provenance without every future SatNOGS
 * addition requiring a schema change here.
 */
export const satnogsTransmitterSchema = z
  .object({
    uuid: z.string(),
    description: z.string(),
    alive: z.boolean(),
    type: z.enum(["Transmitter", "Transceiver", "Transponder"]),
    // Hz. Frequently null: many transmitters report only a drifted/nominal value.
    uplink_low: z.number().int().nullable(),
    uplink_high: z.number().int().nullable(),
    uplink_drift: z.number().int().nullable(),
    uplink_drifted: z.number().int().nullable(),
    downlink_low: z.number().int().nullable(),
    downlink_high: z.number().int().nullable(),
    downlink_drift: z.number().int().nullable(),
    downlink_drifted: z.number().int().nullable(),
    mode: z.string().nullable(),
    mode_id: z.number().int().nullable(),
    uplink_mode: z.string().nullable(),
    invert: z.boolean(),
    baud: z.number().nullable(),
    // SatNOGS's own opaque satellite id. NOT the NORAD catalog number.
    sat_id: z.string(),
    norad_cat_id: z.number().int(),
    norad_follow_id: z.number().int().nullable(),
    status: satnogsTransmitterStatusSchema,
    // No timezone designator; UTC. Parsed by orbit-core's parseUtcTimestamp, never a
    // bare new Date(), which would apply the host offset.
    updated: z.string(),
    service: z.string().nullable(),
  })
  .passthrough();

export const satnogsTransmittersResponseSchema = z.array(satnogsTransmitterSchema);

export type SatnogsTransmitter = z.infer<typeof satnogsTransmitterSchema>;

/**
 * A satellite record.
 *
 * Sparse by nature: `decayed`, `deployed` and `norad_follow_id` are null for most
 * currently-flying objects, and requiring them would reject the majority of the
 * catalog.
 */
export const satnogsSatelliteSchema = z
  .object({
    sat_id: z.string(),
    norad_cat_id: z.number().int().nullable(),
    norad_follow_id: z.number().int().nullable(),
    name: z.string(),
    names: z.string().nullable(),
    status: z.enum(["alive", "dead", "future", "re-entered", "in orbit"]).or(z.string()),
    decayed: z.string().nullable(),
    launched: z.string().nullable(),
    deployed: z.string().nullable(),
    website: z.string().nullable(),
    operator: z.string().nullable(),
    countries: z.string().nullable(),
    updated: z.string(),
    is_frequency_violator: z.boolean().optional(),
  })
  .passthrough();

export const satnogsSatellitesResponseSchema = z.array(satnogsSatelliteSchema);

export type SatnogsSatellite = z.infer<typeof satnogsSatelliteSchema>;

const DB_BASE_URL = "https://db.satnogs.org/api";

/** Build a transmitters-by-NORAD-id request URL. The only place one is constructed. */
export function buildSatnogsTransmittersUrl(noradCatId: string): string {
  const url = new URL(`${DB_BASE_URL}/transmitters/`);
  url.searchParams.set("satellite__norad_cat_id", noradCatId);
  url.searchParams.set("format", "json");
  return url.toString();
}

/** Build a satellite-lookup request URL. */
export function buildSatnogsSatelliteUrl(noradCatId: string): string {
  const url = new URL(`${DB_BASE_URL}/satellites/`);
  url.searchParams.set("norad_cat_id", noradCatId);
  url.searchParams.set("format", "json");
  return url.toString();
}

/** Stable resource key for the fetch guard and provider_runs. */
export function satnogsResourceKey(kind: "transmitters" | "satellites", noradCatId: string): string {
  return `${kind}-${noradCatId.toLowerCase()}`;
}

/**
 * Parse a transmitters response, separating valid records from rejected ones.
 *
 * Per-record, like the CelesTrak parsers: one malformed transmitter must not discard
 * every other transmitter for the same object.
 */
export function parseSatnogsTransmittersResponse(input: unknown): {
  readonly records: readonly SatnogsTransmitter[];
  readonly rejected: readonly { index: number; reason: string }[];
} {
  if (!Array.isArray(input)) {
    return { records: [], rejected: [{ index: -1, reason: "Response was not a JSON array" }] };
  }

  const records: SatnogsTransmitter[] = [];
  const rejected: { index: number; reason: string }[] = [];

  for (const [index, raw] of input.entries()) {
    const parsed = satnogsTransmitterSchema.safeParse(raw);
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

/** Parse a satellites response, separating valid records from rejected ones. */
export function parseSatnogsSatellitesResponse(input: unknown): {
  readonly records: readonly SatnogsSatellite[];
  readonly rejected: readonly { index: number; reason: string }[];
} {
  if (!Array.isArray(input)) {
    return { records: [], rejected: [{ index: -1, reason: "Response was not a JSON array" }] };
  }

  const records: SatnogsSatellite[] = [];
  const rejected: { index: number; reason: string }[] = [];

  for (const [index, raw] of input.entries()) {
    const parsed = satnogsSatelliteSchema.safeParse(raw);
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

/**
 * Only transmitters worth surfacing.
 *
 * "alive" is a per-transmitter status set by the community, distinct from `status`
 * (an ADMIN-set field). Filtering to alive+active transmitters is what keeps the radio
 * panel from listing dead frequencies as though they might still work.
 */
export function isUsableTransmitter(transmitter: SatnogsTransmitter): boolean {
  return transmitter.alive && transmitter.status === "active";
}
