"use client";

import { useEffect, useState } from "react";

import type { RadioTransmittersResponse } from "@orbitwatch/contracts";

import { fetchTransmitters } from "../../lib/api-client";

/**
 * What the selected object transmits.
 *
 * WHY THIS IS HERE AT ALL
 * A pass time is only actionable next to a frequency. For the amateur radio and ground
 * station audience — the people most likely to use a tracker seriously — the downlink
 * IS the answer, and orbital elements contain nothing about it. This is a genuinely
 * separate source, so it is fetched separately, credited separately, and dated
 * separately.
 *
 * FREQUENCIES ARE FORMATTED, NEVER RECOMPUTED
 * The API sends hertz and this divides for display only. Nothing here rounds a value
 * that will be typed into a radio: 145.825 MHz is shown to the kilohertz, because
 * someone is going to tune to it.
 *
 * DEAD TRANSMITTERS ARE NOT SHOWN
 * The API omits them by default and this does not ask for them. A ground station wants
 * what works now; "this used to transmit on 145.8" is a real question but a different
 * one, and mixing the two would have people tuning to silence.
 */

export interface RadioPanelProps {
  readonly catalogId: string | undefined;
}

type RadioState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | ({ readonly status: "ready" } & RadioTransmittersResponse);

/**
 * Hertz to a human frequency.
 *
 * Kilohertz precision, because that is the granularity a receiver is tuned at. Trailing
 * zeros are kept: "145.800" reads as a tuned frequency where "145.8" reads as an
 * approximation, and this is data someone acts on.
 */
function formatFrequency(hertz: number): string {
  return `${(hertz / 1_000_000).toFixed(3)} MHz`;
}

function describeRange(low: number | undefined, high: number | undefined): string | undefined {
  if (low === undefined) return undefined;
  return high === undefined || high === low
    ? formatFrequency(low)
    : `${formatFrequency(low)} – ${formatFrequency(high)}`;
}

export function RadioPanel({ catalogId }: RadioPanelProps) {
  const [state, setState] = useState<RadioState>({ status: "idle" });

  useEffect(() => {
    if (catalogId === undefined) {
      setState({ status: "idle" });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });

    void (async () => {
      try {
        const response = await fetchTransmitters(catalogId);
        if (!cancelled) setState({ status: "ready", ...response });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [catalogId]);

  if (state.status === "idle") return null;

  return (
    <section className="radio-panel" aria-labelledby="radio-heading" data-testid="radio-panel">
      <h3 id="radio-heading" className="telemetry-panel__section-heading">
        Radio
      </h3>

      {state.status === "loading" ? (
        <p className="radio-panel__note">Loading transmitters…</p>
      ) : null}

      {state.status === "failed" ? (
        // A failed lookup is not "no radio". Saying so would turn a network problem
        // into a false statement about the spacecraft.
        <p className="radio-panel__note radio-panel__note--error" data-testid="radio-error">
          Transmitter data could not be loaded. This is a lookup failure, not a
          statement that the object has no radio.
        </p>
      ) : null}

      {state.status === "ready" && state.count === 0 ? (
        <p className="radio-panel__note" data-testid="radio-empty">
          No active transmitters are published for this object.
        </p>
      ) : null}

      {state.status === "ready" && state.count > 0 ? (
        <>
          {/*
            Focusable because it scrolls.

            A region with its own scrollbar must be reachable by keyboard or its
            overflow is simply unreachable without a mouse — axe reports this as
            `scrollable-region-focusable`. The pass list next door needs no equivalent
            because every row in it is already a button. This one is plain text, so the
            list itself takes the tab stop and its label says what it is.
          */}
          <ul
            className="radio-panel__list"
            aria-label="Published transmitters"
            tabIndex={0}
          >
            {state.transmitters.map((transmitter) => {
              const downlink = describeRange(
                transmitter.downlinkLowHz,
                transmitter.downlinkHighHz,
              );
              const uplink = describeRange(transmitter.uplinkLowHz, transmitter.uplinkHighHz);

              return (
                <li
                  key={transmitter.uuid}
                  className="radio-panel__item"
                  data-testid="radio-transmitter"
                >
                  <span className="radio-panel__description">{transmitter.description}</span>
                  <span className="radio-panel__frequencies">
                    {downlink === undefined ? null : (
                      <span data-testid="radio-downlink" aria-label={`Downlink ${downlink}`}>
                        ↓ {downlink}
                      </span>
                    )}
                    {uplink === undefined ? null : (
                      <span className="radio-panel__uplink" aria-label={`Uplink ${uplink}`}>
                        ↑ {uplink}
                      </span>
                    )}
                  </span>
                  <span className="radio-panel__mode">
                    {[transmitter.mode, transmitter.type].filter(Boolean).join(" · ")}
                    {transmitter.baud === undefined
                      ? ""
                      : ` · ${String(Math.round(transmitter.baud))} baud`}
                  </span>
                </li>
              );
            })}
          </ul>

          {/*
            Attribution travels with the data from the API rather than being written
            here, so a licence requirement cannot be lost by editing a component.
          */}
          <p className="radio-panel__attribution" data-testid="radio-attribution">
            {state.attribution}
          </p>
        </>
      ) : null}
    </section>
  );
}
