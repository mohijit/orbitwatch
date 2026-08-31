import { z } from "zod";

/**
 * Launch Library 2 (v2.3.0) response schemas.
 *
 * VERIFIED against the live production response on 2026-08-31, using
 * `launches/upcoming/?limit=5&mode=list`.
 *
 * SCOPE NOTE: `mode=list` returns a REDUCED payload. The fields verified here are
 * exactly those present in list mode — id, name, status, net, window, image. Rocket,
 * pad, launch provider and mission are NOT present in list mode and therefore are NOT
 * modelled here. The detailed payload is a separate shape and must be verified
 * separately before the launches UI depends on it; adding speculative fields now
 * would be guessing, which is what fixtures exist to prevent.
 *
 * RATE LIMIT: 15 requests/hour unauthenticated. All access is server-side and cached;
 * a browser must never call this directly.
 */

/** Cursor-paginated envelope used by every LL2 collection endpoint. */
export const launchLibraryPageSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    count: z.number().int().nonnegative(),
    next: z.string().url().nullable(),
    previous: z.string().url().nullable(),
    results: z.array(item),
  });

/** Reference object pattern LL2 uses for enumerations. */
const referenceSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  abbrev: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});

export const launchListItemSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  name: z.string(),
  response_mode: z.string().optional(),
  slug: z.string().optional(),
  launch_designator: z.string().nullable().optional(),
  status: referenceSchema,
  last_updated: z.string().nullable().optional(),
  /**
   * "No Earlier Than" — the scheduled T-0. Always present, but its meaning depends on
   * `net_precision`: a launch may be accurate only to the month, in which case
   * rendering a precise clock time would misrepresent the provider's certainty.
   */
  net: z.string(),
  net_precision: referenceSchema.nullable().optional(),
  window_start: z.string().nullable().optional(),
  window_end: z.string().nullable().optional(),
  image: z
    .object({
      id: z.number().int().optional(),
      name: z.string().nullable().optional(),
      image_url: z.string().url().nullable().optional(),
      thumbnail_url: z.string().url().nullable().optional(),
      credit: z.string().nullable().optional(),
      license: z
        .object({
          id: z.number().int().optional(),
          name: z.string().nullable().optional(),
          link: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  infographic: z.unknown().nullable().optional(),
});

export const launchListResponseSchema = launchLibraryPageSchema(launchListItemSchema);

export type LaunchListItem = z.infer<typeof launchListItemSchema>;
export type LaunchListResponse = z.infer<typeof launchListResponseSchema>;

/** Normalised launch summary used by the rest of OrbitWatch. */
export interface LaunchSummary {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly statusAbbreviation: string | undefined;
  /** Scheduled T-0 in UTC. */
  readonly net: Date;
  /**
   * How precise `net` actually is ("Hour", "Day", "Month", ...). The UI must not show
   * a to-the-second countdown for a launch known only to the month.
   */
  readonly netPrecision: string | undefined;
  readonly windowStart: Date | undefined;
  readonly windowEnd: Date | undefined;
  readonly imageUrl: string | undefined;
}

export function toLaunchSummaries(input: unknown): readonly LaunchSummary[] {
  const page = launchListResponseSchema.parse(input);

  return page.results.flatMap((item) => {
    const net = new Date(item.net);
    // A launch whose T-0 will not parse is unusable for a countdown; drop it rather
    // than rendering "Invalid Date" in the UI.
    if (Number.isNaN(net.getTime())) return [];

    return [
      {
        id: item.id,
        name: item.name,
        status: item.status.name,
        statusAbbreviation: item.status.abbrev ?? undefined,
        net,
        netPrecision: item.net_precision?.name ?? undefined,
        windowStart: optionalDate(item.window_start),
        windowEnd: optionalDate(item.window_end),
        imageUrl: item.image?.image_url ?? undefined,
      },
    ];
  });
}

function optionalDate(value: string | null | undefined): Date | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

// --- Detailed mode ----------------------------------------------------------

/**
 * VERIFIED against `launches/upcoming/?limit=2&mode=detailed` on 2026-08-31.
 *
 * Only the fields OrbitWatch actually consumes are modelled. The real payload is far
 * larger (a single launch is ~15 KB and carries agency launch statistics, landing
 * counts, social links and more); modelling all of it would be churn with no consumer.
 * Unknown keys pass through because Zod objects are non-strict by default, so an LL2
 * addition cannot break ingestion.
 *
 * NOTE: `launch_service_provider.type` is an OBJECT ({id, name}), not the bare string
 * it was in earlier LL2 versions. Treating it as a string yields "[object Object]".
 */
const namedReferenceSchema = z.object({
  id: z.number().int().optional(),
  name: z.string(),
  abbrev: z.string().nullable().optional(),
});

export const launchDetailedItemSchema = launchListItemSchema.extend({
  probability: z.number().nullable().optional(),
  weather_concerns: z.string().nullable().optional(),
  failreason: z.string().nullable().optional(),
  webcast_live: z.boolean().optional(),
  launch_service_provider: z
    .object({
      id: z.number().int().optional(),
      name: z.string(),
      abbrev: z.string().nullable().optional(),
      // Object, not string — see the note above.
      type: namedReferenceSchema.nullable().optional(),
      country: z.unknown().optional(),
    })
    .nullable()
    .optional(),
  rocket: z
    .object({
      id: z.number().int().optional(),
      configuration: z
        .object({
          id: z.number().int().optional(),
          name: z.string().nullable().optional(),
          full_name: z.string().nullable().optional(),
          variant: z.string().nullable().optional(),
          family: z.string().nullable().optional(),
          reusable: z.boolean().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  mission: z
    .object({
      id: z.number().int().optional(),
      name: z.string().nullable().optional(),
      type: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      orbit: namedReferenceSchema.nullable().optional(),
    })
    .nullable()
    .optional(),
  pad: z
    .object({
      id: z.number().int().optional(),
      name: z.string().nullable().optional(),
      // Numbers in the verified response. Kept strict so a change to strings is
      // caught at ingestion rather than producing NaN on the globe.
      latitude: z.number().nullable().optional(),
      longitude: z.number().nullable().optional(),
      location: z
        .object({
          id: z.number().int().optional(),
          name: z.string().nullable().optional(),
          country: z.unknown().optional(),
          timezone_name: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

export const launchDetailedResponseSchema =
  launchLibraryPageSchema(launchDetailedItemSchema);

export type LaunchDetailedItem = z.infer<typeof launchDetailedItemSchema>;

/** Launch detail used by the /launches page and the launch-site globe layer. */
export interface LaunchDetail extends LaunchSummary {
  readonly providerName: string | undefined;
  readonly providerType: string | undefined;
  readonly rocketName: string | undefined;
  readonly missionName: string | undefined;
  readonly missionDescription: string | undefined;
  readonly missionOrbit: string | undefined;
  readonly padName: string | undefined;
  readonly padLocation: string | undefined;
  /** Present only when the pad has usable coordinates for the globe layer. */
  readonly padCoordinates: { readonly latitude: number; readonly longitude: number } | undefined;
  readonly webcastLive: boolean;
}

export function toLaunchDetails(input: unknown): readonly LaunchDetail[] {
  const page = launchDetailedResponseSchema.parse(input);

  return page.results.flatMap((item) => {
    const net = new Date(item.net);
    if (Number.isNaN(net.getTime())) return [];

    const latitude = item.pad?.latitude ?? undefined;
    const longitude = item.pad?.longitude ?? undefined;

    return [
      {
        id: item.id,
        name: item.name,
        status: item.status.name,
        statusAbbreviation: item.status.abbrev ?? undefined,
        net,
        netPrecision: item.net_precision?.name ?? undefined,
        windowStart: optionalDate(item.window_start),
        windowEnd: optionalDate(item.window_end),
        imageUrl: item.image?.image_url ?? undefined,
        providerName: item.launch_service_provider?.name ?? undefined,
        providerType: item.launch_service_provider?.type?.name ?? undefined,
        rocketName:
          item.rocket?.configuration?.full_name ??
          item.rocket?.configuration?.name ??
          undefined,
        missionName: item.mission?.name ?? undefined,
        missionDescription: item.mission?.description ?? undefined,
        missionOrbit: item.mission?.orbit?.name ?? undefined,
        padName: item.pad?.name ?? undefined,
        padLocation: item.pad?.location?.name ?? undefined,
        padCoordinates:
          latitude !== undefined && longitude !== undefined
            ? { latitude, longitude }
            : undefined,
        webcastLive: item.webcast_live ?? false,
      },
    ];
  });
}
