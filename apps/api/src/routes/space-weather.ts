import type { SpaceWeatherResponse } from "@orbitwatch/contracts";
import { policyFor } from "@orbitwatch/providers";
import type { FastifyInstance } from "fastify";

import type { ApiContext } from "../server.js";

/**
 * Current space weather.
 *
 * WHY THIS IS IN A SATELLITE TRACKER
 * Elevated geomagnetic activity expands the thermosphere and raises drag on everything
 * in low orbit, so a position propagated from an ageing element set drifts from reality
 * faster during a storm — which is to say the accuracy this product reports is
 * optimistic exactly when conditions are most disturbed. Radio blackouts matter to the
 * ground-station audience just as directly. It is context for how far to trust a
 * position, not a weather widget.
 *
 * MISSING IS NOT CALM
 * Every field is optional and `unavailable` is explicit. Kp 0 means a quiet
 * magnetosphere; no Kp at all means nobody has told us. Collapsing the two would have
 * the app reporting calm conditions during a storm it had merely failed to fetch, which
 * is the one failure mode this endpoint exists to avoid.
 */

/** How much recent Kp to return. Two days is eight three-hourly points either side of a storm. */
const KP_HISTORY_HOURS = 48;

export function registerSpaceWeatherRoutes(app: FastifyInstance, context: ApiContext): void {
  app.get("/space-weather", async (): Promise<SpaceWeatherResponse> => {
    const [kp, solarWind, scales] = await Promise.all([
      context.database.spaceWeather.latest("planetary-k-index"),
      context.database.spaceWeather.latest("solar-wind"),
      context.database.spaceWeather.latest("scales"),
    ]);

    const history = await context.database.spaceWeather.since(
      "planetary-k-index",
      new Date(context.now().getTime() - KP_HISTORY_HOURS * 3_600_000),
    );

    return {
      ...(kp?.kp === undefined ? {} : { kp: kp.kp }),
      ...(kp === undefined ? {} : { kpObservedAt: kp.observedAt.toISOString() }),
      ...(solarWind?.solarWindSpeedKmS === undefined
        ? {}
        : { solarWindSpeedKmS: solarWind.solarWindSpeedKmS }),
      ...(solarWind?.bzNt === undefined ? {} : { bzNt: solarWind.bzNt }),
      ...(solarWind === undefined
        ? {}
        : { solarWindObservedAt: solarWind.observedAt.toISOString() }),
      ...(scales?.radioBlackoutScale === undefined
        ? {}
        : { radioBlackoutScale: scales.radioBlackoutScale }),
      ...(scales?.solarRadiationScale === undefined
        ? {}
        : { solarRadiationScale: scales.solarRadiationScale }),
      ...(scales?.geomagneticScale === undefined
        ? {}
        : { geomagneticScale: scales.geomagneticScale }),
      ...(scales === undefined ? {} : { scalesObservedAt: scales.observedAt.toISOString() }),
      kpHistory: history
        .filter((observation) => observation.kp !== undefined)
        .map((observation) => ({
          observedAt: observation.observedAt.toISOString(),
          kp: observation.kp as number,
        })),
      unavailable: kp === undefined && solarWind === undefined && scales === undefined,
      attribution: policyFor("noaa-swpc").attribution,
    };
  });
}
