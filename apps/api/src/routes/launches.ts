import type { LaunchesResponse } from "@orbitwatch/contracts";
import { policyFor } from "@orbitwatch/providers";
import type { FastifyInstance } from "fastify";

import type { ApiContext } from "../server.js";

/**
 * Upcoming launches.
 *
 * The one forward-looking part of the product: everything else describes what is
 * already in orbit, and these are the objects that will be in the catalog next week.
 *
 * NET_PRECISION IS SERVED, NOT RESOLVED
 * Launch Library publishes a full ISO timestamp even for a launch known only to the
 * month, together with how precise that timestamp is. The API passes both through
 * rather than rounding the time itself: rounding would destroy information the client
 * might present differently, and formatting is a presentation decision. What the API
 * refuses to do is send the timestamp alone, which would let any client render invented
 * precision without knowing it.
 */

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export function registerLaunchRoutes(app: FastifyInstance, context: ApiContext): void {
  app.get("/launches/upcoming", async (request): Promise<LaunchesResponse> => {
    const raw = request.query as Record<string, unknown>;
    const requested = Number(raw["limit"]);
    const limit =
      Number.isInteger(requested) && requested > 0
        ? Math.min(requested, MAX_LIMIT)
        : DEFAULT_LIMIT;

    // From now, not from the start of today: a launch two hours ago has happened, and
    // listing it as upcoming would be stale information presented as a schedule.
    const launches = await context.database.launches.upcoming(context.now(), limit);

    return {
      count: launches.length,
      launches: launches.map((launch) => ({
        id: launch.id,
        name: launch.name,
        net: launch.net.toISOString(),
        ...(launch.netPrecision === undefined ? {} : { netPrecision: launch.netPrecision }),
        ...(launch.windowStart === undefined
          ? {}
          : { windowStart: launch.windowStart.toISOString() }),
        ...(launch.windowEnd === undefined ? {} : { windowEnd: launch.windowEnd.toISOString() }),
        ...(launch.statusName === undefined ? {} : { status: launch.statusName }),
        ...(launch.serviceProvider === undefined
          ? {}
          : { serviceProvider: launch.serviceProvider }),
        ...(launch.rocketName === undefined ? {} : { rocket: launch.rocketName }),
        ...(launch.missionName === undefined ? {} : { mission: launch.missionName }),
        ...(launch.missionOrbit === undefined ? {} : { orbit: launch.missionOrbit }),
        ...(launch.padName === undefined ? {} : { pad: launch.padName }),
        ...(launch.padLocation === undefined ? {} : { padLocation: launch.padLocation }),
        ...(launch.padLatitude === undefined || launch.padLongitude === undefined
          ? {}
          : { padLatitude: launch.padLatitude, padLongitude: launch.padLongitude }),
        webcastLive: launch.webcastLive,
      })),
      attribution: policyFor("launch-library").attribution,
    };
  });
}
