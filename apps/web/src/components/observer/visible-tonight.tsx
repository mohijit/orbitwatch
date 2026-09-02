"use client";

import { useMemo } from "react";

import { spokenBearing } from "../../lib/spoken";

import type { VisibleTonightState } from "../../hooks/use-catalog-positions";
import type { VisiblePass } from "../../workers/pass-messages";

/**
 * What is worth going outside for tonight.
 *
 * SCOPE, STATED RATHER THAN IMPLIED
 * This searches CelesTrak's `visual` group — roughly 157 objects the provider curates
 * as bright enough to see with the naked eye — not the whole catalog. That is a real
 * restriction and the panel says so, because the alternative is worse in both
 * directions. Searching all 16,500 objects and applying the same lighting rule yields
 * about 3,614 "optically favourable" passes a night over one location, nearly all of
 * them Starlink and debris that nobody can actually pick out. A list like that implies
 * a promise the data cannot support: GP elements carry no size, albedo, shape or
 * attitude, so there is no brightness to filter on. Group membership is the only
 * published statement about which objects can be seen, so it is what we use.
 *
 * SORTED BY WHEN, NOT BY RANK
 * A pass list is used by standing outside and waiting, so time order is the useful
 * order. There is deliberately no "best pass" score: ranking would need a brightness
 * model we do not have, and elevation alone would promote a high pass of a dim object
 * over a low pass of a bright one.
 */

export interface VisibleTonightPanelProps {
  readonly state: VisibleTonightState;
  readonly hasObserver: boolean;
  readonly groupUnavailable: boolean;
  readonly onRefresh: () => void;
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Only the two classifications that mean "you might see this" reach the list. */
function isWorthLookingFor(pass: VisiblePass): boolean {
  return pass.visibility === "LIKELY_VISIBLE" || pass.visibility === "POSSIBLY_VISIBLE";
}

export function VisibleTonightPanel({
  state,
  hasObserver,
  groupUnavailable,
  onRefresh,
}: VisibleTonightPanelProps) {
  const worthSeeing = useMemo(
    () => (state.status === "ready" ? state.passes.filter(isWorthLookingFor) : []),
    [state],
  );

  if (!hasObserver) {
    return (
      <p className="visible-tonight__empty" data-testid="visible-tonight-no-observer">
        Set an observing location to see what passes overhead tonight.
      </p>
    );
  }

  if (groupUnavailable) {
    return (
      <p className="visible-tonight__empty" data-testid="visible-tonight-no-group">
        The brightest-objects list has not been ingested, so there is nothing reliable
        to search. Rather than search the whole catalog and offer thousands of passes
        that cannot actually be seen, OrbitWatch shows nothing here.
      </p>
    );
  }

  return (
    <section className="visible-tonight" data-testid="visible-tonight">
      <header className="visible-tonight__header">
        <h2 className="telemetry-panel__section-heading">Visible tonight</h2>
        <button
          type="button"
          className="visible-tonight__refresh"
          onClick={onRefresh}
          disabled={state.status === "searching"}
          data-testid="visible-tonight-refresh"
        >
          {state.status === "searching" ? "Searching…" : "Refresh"}
        </button>
      </header>

      {state.status === "idle" || state.status === "searching" ? (
        <p className="visible-tonight__empty" data-testid="visible-tonight-status">
          {state.status === "searching" ? "Searching tonight's sky…" : "Not searched yet."}
        </p>
      ) : null}

      {state.status === "no-darkness" ? (
        <p className="visible-tonight__empty" data-testid="visible-tonight-no-darkness">
          The sky never gets dark at your location in the next day and a half, so there
          is no window for naked-eye observation.
        </p>
      ) : null}

      {state.status === "ready" ? (
        <>
          <p className="visible-tonight__window" data-testid="visible-tonight-window">
            {timeFormat.format(new Date(state.darkStart))} –{" "}
            {timeFormat.format(new Date(state.darkEnd))}, {state.searched} bright objects
            searched
          </p>

          {worthSeeing.length === 0 ? (
            <p className="visible-tonight__empty" data-testid="visible-tonight-none">
              No favourable passes tonight. The objects are up there; none of them is
              both sunlit and above 10° while your sky is dark.
            </p>
          ) : (
            <ol className="visible-tonight__list" aria-label="Passes visible tonight">
              {worthSeeing.map((pass) => (
                <li
                  className="visible-tonight__item"
                  key={`${pass.catalogId}-${pass.aos.time.toISOString()}`}
                  data-testid="visible-tonight-pass"
                  aria-label={
                    `${pass.name} at ${timeFormat.format(pass.aos.time)}, peak ` +
                    `${spokenBearing(pass.maximum.elevation, pass.maximum.compass)}, ` +
                    `lasting ${String(Math.round(pass.durationSeconds / 60))} minutes. ` +
                    `${pass.visibility === "LIKELY_VISIBLE" ? "Likely visible" : "Possibly visible"}.`
                  }
                >
                  <span className="visible-tonight__time">
                    {timeFormat.format(pass.aos.time)}
                  </span>
                  <span className="visible-tonight__name" data-testid="visible-tonight-name">
                    {pass.name}
                  </span>
                  <span className="visible-tonight__geometry">
                    {Math.round(pass.maximum.elevation)}° {pass.maximum.compass} ·{" "}
                    {Math.round(pass.durationSeconds / 60)} min
                  </span>
                  <span
                    className={`visible-tonight__grade visible-tonight__grade--${
                      pass.visibility === "LIKELY_VISIBLE" ? "likely" : "possible"
                    }`}
                  >
                    {pass.visibility === "LIKELY_VISIBLE" ? "Likely" : "Possible"}
                  </span>
                </li>
              ))}
            </ol>
          )}

          <p className="visible-tonight__method">
            Searched CelesTrak&rsquo;s <code>visual</code> group, not the full catalog.
            Orbital elements carry no brightness data, so this is the only published
            basis for saying an object can be seen.{" "}
            <a href="/methodology">How this is decided</a>.
          </p>
        </>
      ) : null}
    </section>
  );
}
