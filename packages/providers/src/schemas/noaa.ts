import { z } from "zod";

/**
 * NOAA SWPC response schemas.
 *
 * VERIFIED against live production responses on 2026-08-31. See fixtures/manifest.json.
 *
 * DOCUMENTATION DISCREPANCIES FOUND
 * ---------------------------------
 * 1. `products/solar-wind/plasma-1-day.json` — widely cited online, but the entire
 *    `products/solar-wind/` directory returns HTTP 404. The real propagated solar wind
 *    product is `products/geospace/propagated-solar-wind-1-hour.json`.
 *
 * 2. The two products use DIFFERENT encodings. The Kp product is an array of OBJECTS;
 *    the solar wind product is an array of ARRAYS with a header row. Several sources
 *    describe both as the header-row form. We handle each as it actually is.
 *
 * 3. Kp `time_tag` carries NO timezone designator ("2026-08-24T00:00:00"). ECMAScript
 *    parses such strings as LOCAL time, which would shift readings by the host offset.
 *    The solar wind product's `time_tag` DOES carry a trailing "Z". We normalise both.
 */

/**
 * Parse a NOAA timestamp as UTC.
 *
 * NOAA mixes designator-less and Z-suffixed timestamps across products, so this is
 * applied uniformly rather than trusting any single product's convention.
 */
const utcTimestamp = z.string().transform((value, ctx) => {
  const trimmed = value.trim();
  const hasDesignator = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const parsed = new Date(hasDesignator ? trimmed : `${trimmed}Z`);
  if (Number.isNaN(parsed.getTime())) {
    ctx.addIssue({ code: "custom", message: `Unparseable NOAA timestamp: ${value}` });
    return z.NEVER;
  }
  return parsed;
});

// --- Planetary K index ------------------------------------------------------

/**
 * `products/noaa-planetary-k-index.json`
 *
 * Kp is the 3-hourly planetary geomagnetic index (0-9). Elevated Kp increases
 * thermospheric density, which raises drag on low-Earth-orbit satellites and degrades
 * the accuracy of propagation from older elements — which is why it belongs in a
 * tracking product rather than being decorative.
 */
export const noaaPlanetaryKIndexEntrySchema = z.object({
  time_tag: utcTimestamp,
  Kp: z.number().min(0).max(9),
  a_running: z.number(),
  station_count: z.number().int(),
});

export const noaaPlanetaryKIndexSchema = z.array(noaaPlanetaryKIndexEntrySchema);

export type NoaaPlanetaryKIndexEntry = z.infer<typeof noaaPlanetaryKIndexEntrySchema>;

// --- Propagated solar wind --------------------------------------------------

/**
 * `products/geospace/propagated-solar-wind-1-hour.json`
 *
 * Header-row encoded: element 0 is an array of column names, the rest are value rows.
 * Column order is validated rather than assumed, so a NOAA reordering surfaces as a
 * validation failure instead of silently swapping speed and density.
 */
const SOLAR_WIND_COLUMNS = [
  "time_tag",
  "speed",
  "density",
  "temperature",
  "bx",
  "by",
  "bz",
  "bt",
  "vx",
  "vy",
  "vz",
  "propagated_time_tag",
] as const;

export const noaaSolarWindRawSchema = z
  .array(z.array(z.union([z.string(), z.number(), z.null()])))
  .min(1);

export interface SolarWindSample {
  /** Observation time at the spacecraft. */
  readonly timeTag: Date;
  /** Time the sample is propagated to at Earth. */
  readonly propagatedTimeTag: Date | undefined;
  /** Bulk solar wind speed, km/s. */
  readonly speed: number | undefined;
  /** Proton density, particles/cm3. */
  readonly density: number | undefined;
  readonly temperature: number | undefined;
  /** Interplanetary magnetic field components, nT. */
  readonly bx: number | undefined;
  readonly by: number | undefined;
  /** Bz is the geoeffective component: sustained southward (negative) Bz drives storms. */
  readonly bz: number | undefined;
  /** Total field magnitude, nT. */
  readonly bt: number | undefined;
}

/**
 * Decode the header-row solar wind product into typed samples.
 *
 * Throws if the header does not match the expected columns — an upstream schema
 * change must fail loudly at ingestion, where it can be logged and the last known
 * good data retained, rather than quietly producing wrong numbers.
 */
export function parseNoaaSolarWind(input: unknown): readonly SolarWindSample[] {
  const rows = noaaSolarWindRawSchema.parse(input);
  const header = rows[0];
  if (header === undefined) return [];

  const headerNames = header.map((value) => String(value));
  for (const [index, expected] of SOLAR_WIND_COLUMNS.entries()) {
    if (headerNames[index] !== expected) {
      throw new Error(
        `NOAA solar wind column ${index} is "${headerNames[index]}", expected "${expected}". ` +
          `Upstream format has changed; refusing to guess the column order.`,
      );
    }
  }

  const samples: SolarWindSample[] = [];
  for (const row of rows.slice(1)) {
    const timeTag = toDate(row[0]);
    if (timeTag === undefined) continue;

    samples.push({
      timeTag,
      propagatedTimeTag: toDate(row[11]),
      speed: toNumber(row[1]),
      density: toNumber(row[2]),
      temperature: toNumber(row[3]),
      bx: toNumber(row[4]),
      by: toNumber(row[5]),
      bz: toNumber(row[6]),
      bt: toNumber(row[7]),
    });
  }
  return samples;
}

// --- NOAA scales ------------------------------------------------------------

/**
 * `products/noaa-scales.json`
 *
 * Keyed by day offset as a STRING: "0" is current conditions, "1".."3" are forecast
 * days, and "-1" carries the previous period. Scale/Text/probability values are
 * strings or null rather than numbers, so they are kept as strings and converted at
 * the display layer.
 */
const scaleBlockSchema = z.object({
  Scale: z.string().nullable(),
  Text: z.string().nullable(),
  MinorProb: z.string().nullable().optional(),
  MajorProb: z.string().nullable().optional(),
  Prob: z.string().nullable().optional(),
});

export const noaaScalesEntrySchema = z.object({
  DateStamp: z.string(),
  TimeStamp: z.string(),
  /** Radio blackouts, driven by solar flares. */
  R: scaleBlockSchema,
  /** Solar radiation storms — the scale most relevant to spacecraft health. */
  S: scaleBlockSchema,
  /** Geomagnetic storms. */
  G: scaleBlockSchema,
});

export const noaaScalesSchema = z.record(z.string(), noaaScalesEntrySchema);

export type NoaaScalesEntry = z.infer<typeof noaaScalesEntrySchema>;

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const trimmed = value.trim();
  const hasDesignator = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const parsed = new Date(hasDesignator ? trimmed : `${trimmed}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
