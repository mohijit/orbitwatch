"use client";

import { useEffect, useState } from "react";

import type { SpaceWeatherResponse } from "@orbitwatch/contracts";

import { fetchSpaceWeather } from "../../lib/api-client";

/**
 * Current space weather, and what it means for the positions on screen.
 *
 * NOT A WEATHER WIDGET
 * Elevated geomagnetic activity expands the thermosphere and raises drag on everything
 * in low orbit. A position propagated from an ageing element set therefore drifts from
 * reality FASTER during a storm — which is to say the accuracy this app reports is
 * optimistic exactly when conditions are most disturbed. That is the only reason this
 * is here, and the panel says so rather than leaving the number to look decorative.
 *
 * MISSING IS NOT CALM
 * Kp 0 means a quiet magnetosphere. No Kp at all means nobody has told us. The panel
 * distinguishes them, because reporting calm conditions during a storm it merely failed
 * to fetch is the one thing this must never do.
 */

type State =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | ({ readonly status: "ready" } & SpaceWeatherResponse);

/** Refreshed on the provider's own cadence; NOAA republishes every few minutes. */
const REFRESH_MS = 5 * 60_000;

/**
 * Kp bands, as NOAA defines them.
 *
 * 5 is the threshold for a G1 geomagnetic storm — not a gradient we invented, and the
 * point at which drag effects start to matter to low-orbit propagation.
 */
function kpSeverity(kp: number): "quiet" | "unsettled" | "storm" {
  if (kp >= 5) return "storm";
  if (kp >= 4) return "unsettled";
  return "quiet";
}

function describeDrag(kp: number | undefined): string {
  if (kp === undefined) {
    return "Geomagnetic activity is unknown, so the effect on orbital drag cannot be stated.";
  }
  if (kp >= 5) {
    return (
      "Storm conditions. The thermosphere is expanded and drag is elevated, so positions " +
      "propagated from older elements drift faster than their stated accuracy suggests."
    );
  }
  if (kp >= 4) {
    return "Unsettled. Drag is somewhat elevated for objects in low orbit.";
  }
  return "Quiet. Drag is nominal, and propagation accuracy is not degraded by activity.";
}

export function SpaceWeatherPanel() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const response = await fetchSpaceWeather();
        if (!cancelled) setState({ status: "ready", ...response });
      } catch {
        // A failed lookup is not calm conditions.
        if (!cancelled) setState({ status: "failed" });
      }
    };

    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (state.status === "loading") return null;

  if (state.status === "failed" || state.unavailable) {
    return (
      <section className="space-weather" data-testid="space-weather">
        <h2 className="telemetry-panel__section-heading">Space weather</h2>
        <p className="space-weather__note" data-testid="space-weather-unavailable">
          Space weather is not available. This is a missing reading, not a quiet
          magnetosphere — treat the accuracy figures as unqualified by conditions.
        </p>
      </section>
    );
  }

  const severity = state.kp === undefined ? "quiet" : kpSeverity(state.kp);

  return (
    <section className="space-weather" data-testid="space-weather">
      <h2 className="telemetry-panel__section-heading">Space weather</h2>

      <div className="space-weather__row">
        <span
          className={`space-weather__kp space-weather__kp--${severity}`}
          data-testid="space-weather-kp"
          aria-label={
            state.kp === undefined
              ? "Planetary K index unknown"
              : `Planetary K index ${state.kp.toFixed(2)}, ${severity}`
          }
        >
          Kp {state.kp === undefined ? "—" : state.kp.toFixed(2)}
        </span>

        {state.solarWindSpeedKmS === undefined ? null : (
          <span className="space-weather__wind" data-testid="space-weather-wind">
            {Math.round(state.solarWindSpeedKmS)} km/s
          </span>
        )}

        {/* R/S/G are ordinal NOAA levels, not measurements: shown as published. */}
        <span className="space-weather__scales" data-testid="space-weather-scales">
          R{state.radioBlackoutScale ?? "?"} S{state.solarRadiationScale ?? "?"} G
          {state.geomagneticScale ?? "?"}
        </span>
      </div>

      <p className="space-weather__meaning" data-testid="space-weather-meaning">
        {describeDrag(state.kp)}
      </p>

      <p className="space-weather__attribution">
        {state.attribution}
        {state.kpObservedAt === undefined
          ? null
          : ` Observed ${new Date(state.kpObservedAt).toISOString().slice(0, 16).replace("T", " ")}Z.`}
      </p>
    </section>
  );
}
