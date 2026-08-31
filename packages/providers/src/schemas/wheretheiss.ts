import { z } from "zod";

/**
 * WhereTheISS.at response schema.
 *
 * VERIFIED against the live production response on 2026-08-31.
 *
 * ROLE: verification only. This endpoint exists in OrbitWatch purely to cross-check
 * our own SGP4 output for the ISS. It must never drive the animation — doing so would
 * make the product depend on a third party for something we compute locally, and
 * would be exactly the "poll a server for position" anti-pattern the architecture
 * avoids.
 *
 * UNITS TRAP: `velocity` is in km/HOUR, not km/s. A live value of 27530 is 7.65 km/s.
 * Comparing it directly against our km/s speed would appear to show a 3600x error.
 */
export const whereTheIssSchema = z.object({
  name: z.string(),
  id: z.number().int(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Altitude above the ellipsoid, in the unit named by `units`. */
  altitude: z.number(),
  /** Speed in units-per-HOUR (km/h when units === "kilometers"). */
  velocity: z.number(),
  /** Whether the spacecraft is in daylight or eclipse, as judged by the provider. */
  visibility: z.string(),
  /** Radius of the visible ground circle. */
  footprint: z.number(),
  /** Unix epoch SECONDS, not milliseconds. */
  timestamp: z.number().int(),
  daynum: z.number(),
  solar_lat: z.number(),
  solar_lon: z.number(),
  units: z.union([z.literal("kilometers"), z.literal("miles")]),
});

export type WhereTheIssResponse = z.infer<typeof whereTheIssSchema>;

/** Seconds per hour, used to convert the provider's km/h into our canonical km/s. */
const SECONDS_PER_HOUR = 3600;

export interface IssCrossCheck {
  readonly time: Date;
  readonly latitude: number;
  readonly longitude: number;
  readonly altitudeKm: number;
  /** Converted to km/s so it is directly comparable with our SGP4 output. */
  readonly speedKmPerSecond: number;
}

/**
 * Normalise the provider response into OrbitWatch's canonical units.
 *
 * Rejects the `miles` unit rather than converting silently: we have never observed it,
 * so a conversion path for it would be untested code handling real data.
 */
export function toIssCrossCheck(input: unknown): IssCrossCheck {
  const parsed = whereTheIssSchema.parse(input);

  if (parsed.units !== "kilometers") {
    throw new Error(
      `WhereTheISS.at returned units "${parsed.units}"; only "kilometers" is supported.`,
    );
  }

  return {
    // Unix seconds -> milliseconds.
    time: new Date(parsed.timestamp * 1000),
    latitude: parsed.latitude,
    longitude: parsed.longitude,
    altitudeKm: parsed.altitude,
    speedKmPerSecond: parsed.velocity / SECONDS_PER_HOUR,
  };
}
