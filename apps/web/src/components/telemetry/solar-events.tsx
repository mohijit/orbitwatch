"use client";

import { useEffect, useState } from "react";

import type { SolarEventsResponse } from "@orbitwatch/contracts";

import { fetchSolarEvents } from "../../lib/api-client";

/**
 * What the Sun has actually done recently.
 *
 * DISTINCT FROM THE SPACE WEATHER PANEL, ON PURPOSE
 * That one reports the CURRENT level on NOAA's R/S/G scales — a number describing right
 * now. This is a list of discrete events: a coronal mass ejection was observed, a
 * geomagnetic storm began. Conditions and events are different facts, and a tracker
 * that showed only the first would say "quiet" on the day after a storm that has
 * already raised drag on everything in low orbit.
 *
 * TYPES ARE EXPLAINED, OR MARKED AS UNEXPLAINED
 * "RBE" means nothing to most people, so each known code carries a plain description.
 * NASA adds types, and one this product does not recognise is shown as the raw code
 * with no invented gloss — guessing at what an unfamiliar acronym means is exactly how
 * a data product starts asserting things its source did not say.
 */

type State =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | ({ readonly status: "ready" } & SolarEventsResponse);

const REFRESH_MS = 30 * 60_000;

/** NASA's own definitions, in plain words. */
const TYPE_LABELS: Record<string, string> = {
  CME: "Coronal mass ejection",
  GST: "Geomagnetic storm",
  FLR: "Solar flare",
  SEP: "Solar energetic particles",
  RBE: "Radiation belt enhancement",
  IPS: "Interplanetary shock",
  MPC: "Magnetopause crossing",
  Report: "Summary report",
};

/** The two types with a direct, statable consequence for objects in low orbit. */
const AFFECTS_ORBITS = new Set(["GST", "CME"]);

const dateFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function SolarEvents() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const response = await fetchSolarEvents(6);
        if (!cancelled) setState({ status: "ready", ...response });
      } catch {
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

  if (state.status === "failed") {
    return (
      <section className="solar-events" data-testid="solar-events">
        <h2 className="telemetry-panel__section-heading">Recent solar activity</h2>
        <p className="solar-events__note">Solar event history could not be loaded.</p>
      </section>
    );
  }

  if (state.count === 0) {
    return (
      <section className="solar-events" data-testid="solar-events">
        <h2 className="telemetry-panel__section-heading">Recent solar activity</h2>
        <p className="solar-events__note" data-testid="solar-events-empty">
          No solar events recorded in the last 30 days.
        </p>
      </section>
    );
  }

  return (
    <section className="solar-events" data-testid="solar-events">
      <h2 className="telemetry-panel__section-heading">Recent solar activity</h2>

      <ol className="solar-events__list" aria-label="Recent solar events">
        {state.events.map((event) => {
          const label = event.knownType ? TYPE_LABELS[event.type] : undefined;
          return (
            <li key={event.id} className="solar-events__item" data-testid="solar-event">
              <span
                className={`solar-events__type${
                  AFFECTS_ORBITS.has(event.type) ? " solar-events__type--orbital" : ""
                }`}
                data-testid="solar-event-type"
                // The raw code is the visible text; the expansion is what a screen
                // reader says, because "RBE" read aloud is three letters.
                aria-label={label ?? `Event type ${event.type}, not described`}
                title={label ?? "Type not described by OrbitWatch"}
              >
                {event.type}
              </span>
              <span className="solar-events__when">
                {dateFormat.format(new Date(event.issuedAt))}
              </span>
              <span className="solar-events__label">
                {label ?? `${event.type} (type not described)`}
              </span>
            </li>
          );
        })}
      </ol>

      <p className="solar-events__footnote">
        Geomagnetic storms and coronal mass ejections raise atmospheric drag in low
        orbit, so positions propagated from older elements drift faster after one.
      </p>
      <p className="solar-events__attribution">{state.attribution}</p>
    </section>
  );
}
