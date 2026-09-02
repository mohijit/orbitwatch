"use client";

import { useEffect, useState } from "react";

import type { Launch, LaunchesResponse } from "@orbitwatch/contracts";

import { fetchUpcomingLaunches } from "../../lib/api-client";

/**
 * The next launches.
 *
 * The only forward-looking part of the product: everything else describes what is
 * already in orbit, and these are the objects that will be in the catalog next week.
 *
 * PRECISION IS OBEYED, NOT IGNORED
 * Launch Library publishes a full ISO timestamp for every launch and, separately, how
 * precise that timestamp actually is — Minute, Hour, Day, Week, Month, Quarter, Year.
 * Rendering the timestamp verbatim would show "14:32 on 3 November" for a launch that
 * might slip four weeks, which is invented precision of exactly the kind this product
 * refuses everywhere else. So the formatting is chosen from the precision, and a launch
 * whose precision the provider did not state is shown as unknown rather than exact.
 */

type State =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | ({ readonly status: "ready" } & LaunchesResponse);

/** Launch schedules move constantly, but not by the second. */
const REFRESH_MS = 15 * 60_000;

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const monthFormat = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

/**
 * Render a T-0 to no more precision than the provider claims for it.
 *
 * The bands mirror Launch Library's own vocabulary. Anything coarser than a day drops
 * the clock entirely: showing a time at all would imply one is known.
 */
function formatLaunchTime(launch: Launch): { primary: string; qualifier: string | undefined } {
  const net = new Date(launch.net);
  const precision = launch.netPrecision;

  switch (precision) {
    case "Minute":
    case "Second":
      return { primary: `${dayFormat.format(net)}, ${timeFormat.format(net)}`, qualifier: undefined };
    case "Hour":
      return {
        primary: `${dayFormat.format(net)}, ${timeFormat.format(net)}`,
        qualifier: "±1 hour",
      };
    case "Day":
      return { primary: dayFormat.format(net), qualifier: "time not set" };
    case "Week":
      return { primary: `week of ${dayFormat.format(net)}`, qualifier: undefined };
    case "Month":
      return { primary: monthFormat.format(net), qualifier: undefined };
    case "Quarter":
    case "Year":
      return { primary: monthFormat.format(net), qualifier: `${precision.toLowerCase()} only` };
    default:
      // Not stated is not the same as exact. The date is shown; the clock is not.
      return { primary: dayFormat.format(net), qualifier: "precision unstated" };
  }
}

export function UpcomingLaunches() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const response = await fetchUpcomingLaunches(5);
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
      <section className="launches" data-testid="launches">
        <h2 className="telemetry-panel__section-heading">Next launches</h2>
        <p className="launches__note" data-testid="launches-error">
          Launch schedule could not be loaded.
        </p>
      </section>
    );
  }

  if (state.count === 0) {
    return (
      <section className="launches" data-testid="launches">
        <h2 className="telemetry-panel__section-heading">Next launches</h2>
        <p className="launches__note" data-testid="launches-empty">
          No upcoming launches are stored.
        </p>
      </section>
    );
  }

  return (
    <section className="launches" data-testid="launches">
      <h2 className="telemetry-panel__section-heading">Next launches</h2>

      <ol className="launches__list" aria-label="Upcoming launches">
        {state.launches.map((launch) => {
          const when = formatLaunchTime(launch);
          return (
            <li key={launch.id} className="launches__item" data-testid="launch">
              <span className="launches__when" data-testid="launch-when">
                {when.primary}
                {when.qualifier === undefined ? null : (
                  <span className="launches__qualifier" data-testid="launch-qualifier">
                    {" "}
                    {when.qualifier}
                  </span>
                )}
              </span>
              <span className="launches__name">{launch.name}</span>
              <span className="launches__detail">
                {[launch.serviceProvider, launch.padLocation].filter(Boolean).join(" · ")}
              </span>
            </li>
          );
        })}
      </ol>

      <p className="launches__attribution">{state.attribution}</p>
    </section>
  );
}
