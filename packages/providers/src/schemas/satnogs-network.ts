import { z } from "zod";

/**
 * SatNOGS Network — the ground stations that actually observe.
 *
 * Verified against a real production response captured on 2026-09-02. The full listing
 * is 4,452 stations and 3.4 MB; the committed fixture keeps a representative 44 across
 * all three status values, and `fixtures/manifest.json` records that it is truncated.
 *
 * WHAT THIS IS FOR
 * SatNOGS DB says what a satellite transmits. The Network says who can hear it. Between
 * them a user can ask the question a ground station operator actually has: is anyone
 * positioned to receive this pass, and on what band.
 *
 * MOST STATIONS ARE OFFLINE, AND THAT IS NORMAL
 * Of 4,452 stations in the captured listing, 4,119 were Offline, 317 Online and 16
 * Testing. A volunteer network is mostly dormant at any moment. Presenting the total as
 * though it were the receiving capacity would overstate coverage by an order of
 * magnitude, so status is carried through rather than counted away.
 */

/** Station status, exactly as the Network publishes it. */
export const satnogsStationStatusSchema = z.enum(["Online", "Offline", "Testing"]);

/**
 * An antenna's usable band.
 *
 * Frequencies are integer hertz, as published. A station with no antennas is real —
 * a registered site not yet equipped — and must not be rejected.
 */
export const satnogsAntennaSchema = z
  .object({
    frequency: z.number().int(),
    frequency_max: z.number().int(),
    band: z.string(),
    antenna_type: z.string(),
    antenna_type_name: z.string(),
  })
  .passthrough();

export const satnogsStationSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    /** Metres above sea level. */
    altitude: z.number(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    /**
     * Minimum elevation the station will observe down to, in degrees.
     *
     * Genuinely per-station: a site in a valley may not see below 40 degrees. It is
     * the station's own horizon, and it is why "above 10 degrees" is not the same
     * question for every receiver.
     */
    min_horizon: z.number(),
    status: satnogsStationStatusSchema,
    antenna: z.array(satnogsAntennaSchema),
    /** Null for a station that has never checked in. */
    last_seen: z.string().nullable(),
    observations: z.number().int(),
    qthlocator: z.string().nullable().optional(),
  })
  .passthrough();

export const satnogsStationsResponseSchema = z.array(satnogsStationSchema);

export type SatnogsStation = z.infer<typeof satnogsStationSchema>;

/** A station, normalised for storage. */
export interface GroundStation {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly altitudeM: number;
  readonly minHorizonDegrees: number;
  readonly status: string;
  /** Distinct bands the station can receive, e.g. ["UHF", "VHF"]. */
  readonly bands: readonly string[];
  readonly observations: number;
  readonly lastSeen: Date | undefined;
}

export function toGroundStations(input: unknown): readonly GroundStation[] {
  const stations = satnogsStationsResponseSchema.parse(input);

  return stations.map((station) => {
    const lastSeen = station.last_seen === null ? undefined : new Date(station.last_seen);

    return {
      id: String(station.id),
      name: station.name,
      latitude: station.lat,
      longitude: station.lng,
      altitudeM: station.altitude,
      minHorizonDegrees: station.min_horizon,
      status: station.status,
      // Deduplicated and sorted: a station with four UHF antennas covers one band, and
      // listing it four times would overstate what it can do.
      bands: [...new Set(station.antenna.map((antenna) => antenna.band))].sort(),
      observations: station.observations,
      lastSeen: lastSeen === undefined || Number.isNaN(lastSeen.getTime()) ? undefined : lastSeen,
    };
  });
}
