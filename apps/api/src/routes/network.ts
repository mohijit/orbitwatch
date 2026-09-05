import type { GroundStationsResponse, SolarEventsResponse } from "@orbitwatch/contracts";
import { policyFor } from "@orbitwatch/providers";
import type { FastifyInstance } from "fastify";

import type { ApiContext } from "../server.js";

/**
 * Ground stations and solar events.
 *
 * Two providers, one route file, because both are context rather than core: neither is
 * on the path the globe depends on, and grouping them keeps the satellite routes about
 * satellites.
 */

const DEFAULT_STATION_LIMIT = 50;
const MAX_STATION_LIMIT = 500;
const DEFAULT_EVENT_LIMIT = 20;
const MAX_EVENT_LIMIT = 100;
/** A month of events covers a full solar rotation. */
const EVENT_WINDOW_DAYS = 30;

function boundedLimit(raw: unknown, fallback: number, max: number): number {
  const requested = Number(raw);
  return Number.isInteger(requested) && requested > 0 ? Math.min(requested, max) : fallback;
}

export function registerNetworkRoutes(app: FastifyInstance, context: ApiContext): void {
  /**
   * Ground stations that can receive passes.
   *
   * THE COUNTS ARE THE HONEST PART
   * Of 4,452 stations, 4,119 are Offline. Returning a list without saying so would let
   * a client present the total as receiving capacity and overstate coverage tenfold.
   * So the response carries the breakdown by status, and defaults to the online ones.
   */
  app.get("/stations", async (request): Promise<GroundStationsResponse> => {
    const raw = request.query as Record<string, unknown>;
    const status = typeof raw["status"] === "string" ? raw["status"] : "Online";
    const limit = boundedLimit(raw["limit"], DEFAULT_STATION_LIMIT, MAX_STATION_LIMIT);

    const [stations, byStatus] = await Promise.all([
      // "all" is spelled explicitly rather than inferred from an absent parameter: a
      // client that forgets the filter should get the useful default, not 4,452 rows.
      context.database.stations.list(status === "all" ? { limit } : { status, limit }),
      context.database.stations.countByStatus(),
    ]);

    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);

    return {
      count: stations.length,
      total,
      byStatus,
      stations: stations.map((station) => ({
        id: station.id,
        name: station.name,
        latitude: station.latitude,
        longitude: station.longitude,
        altitudeM: station.altitudeM,
        minHorizonDegrees: station.minHorizonDegrees,
        status: station.status,
        bands: [...station.bands],
        observations: station.observations,
        ...(station.lastSeen === undefined ? {} : { lastSeen: station.lastSeen.toISOString() }),
      })),
      attribution: policyFor("satnogs-network").attribution,
    };
  });

  /**
   * Recent solar and geomagnetic events.
   *
   * Distinct from /space-weather, which reports the CURRENT level on the R/S/G scales.
   * This is what happened: a coronal mass ejection was observed, a storm began. Both
   * belong, and conflating them would lose the difference between a condition and an
   * event.
   */
  app.get("/solar-events", async (request): Promise<SolarEventsResponse> => {
    const raw = request.query as Record<string, unknown>;
    const limit = boundedLimit(raw["limit"], DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT);
    const types =
      typeof raw["type"] === "string"
        ? raw["type"].split(",").map((one) => one.trim()).filter((one) => one !== "")
        : undefined;

    const events = await context.database.solarEvents.recent({
      since: new Date(context.now().getTime() - EVENT_WINDOW_DAYS * 24 * 3_600_000),
      ...(types === undefined || types.length === 0 ? {} : { types }),
      limit,
    });

    return {
      count: events.length,
      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        // Whether this product can explain the type. A client should not present an
        // unrecognised code as though it were understood.
        knownType: event.knownType,
        issuedAt: event.issuedAt.toISOString(),
        url: event.url,
        summary: event.summary,
      })),
      attribution: policyFor("nasa-donki").attribution,
    };
  });
}
