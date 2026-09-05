"use client";

import { useEffect, useRef, useState } from "react";

/**
 * LIVE / SIMULATION time control.
 *
 * LIVE means "now, continuously" — the parent's `time` prop tracks `Date.now()` on an
 * interval. SIMULATION means "a time I chose" — scrubbing hands a fixed instant to the
 * parent, which both the catalog worker and the selected-satellite hook then propagate
 * to. Historical replay (using the element set that was current at that instant,
 * never today's propagated backwards) is implemented server-side; this component only
 * chooses the instant.
 *
 * The slider's onChange is debounced before it reaches the parent: every pixel of drag
 * would otherwise fire a fetch against `/satellites/:id/elements?at=...` for the
 * selected object.
 */

export type TimelineMode = "live" | "simulation";

export interface TimelineProps {
  readonly time: number;
  readonly mode: TimelineMode;
  readonly onChange: (time: number, mode: TimelineMode) => void;
}

const SCRUB_DEBOUNCE_MS = 150;
const SCRUB_RANGE_HOURS = 48; // ±48h around the moment simulation mode was entered

export function Timeline({ time, mode, onChange }: TimelineProps) {
  const anchorRef = useRef(time);
  const [sliderValue, setSliderValue] = useState(0.5);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /**
   * The clock renders only after mount.
   *
   * This page is statically prerendered, so anything derived from `Date.now()` during
   * render is frozen at BUILD time. Emitting it into the HTML would ship a timestamp
   * that is stale by however long ago the deploy happened, and then disagree with the
   * client on hydration (React error #418). A product whose entire premise is being
   * precise about which instant a position refers to must not display a fabricated one,
   * so the server renders a placeholder and the real clock appears on the first client
   * render.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mode === "simulation") anchorRef.current = time;
  }, [mode, time]);

  const returnToLive = (): void => {
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    setSliderValue(0.5);
    onChange(Date.now(), "live");
  };

  const scrub = (fraction: number): void => {
    setSliderValue(fraction);
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const rangeMs = SCRUB_RANGE_HOURS * 3600_000;
      const offsetMs = (fraction - 0.5) * 2 * rangeMs;
      onChange(anchorRef.current + offsetMs, "simulation");
    }, SCRUB_DEBOUNCE_MS);
  };

  /*
   * The scrubber is a disclosure on a narrow screen, and always present on a wide one.
   *
   * A 48-hour range across ~350 pixels is roughly eight minutes per pixel — a precision
   * control, and a thumb is the least precise pointer there is. On a phone it also sits
   * in the single most valuable strip of screen, permanently, to serve an action almost
   * nobody takes. What people do read constantly is which instant is on screen and
   * whether it is live, so that stays; the control that changes it is one tap away.
   *
   * SIMULATION forces it open regardless. A user who has left live time must always be
   * able to see the way back, and hiding "Return to live" behind a disclosure would
   * strand them in a state they may not have entered deliberately.
   *
   * Both parts stay in the DOM on a wide screen, so this is presentation, not a second
   * component: the CSS decides which of the two arrangements applies.
   */
  const [scrubOpen, setScrubOpen] = useState(false);
  const controlsOpen = scrubOpen || mode === "simulation";

  return (
    <div className="timeline" data-testid="timeline" data-controls={controlsOpen ? "open" : "closed"}>
      <div className="timeline__mode" data-testid="timeline-mode">
        {mode === "live" ? (
          <span className="timeline__live-badge">LIVE</span>
        ) : (
          <span className="timeline__sim-badge">SIMULATION</span>
        )}
        {mounted ? (
          <time className="timeline__clock" dateTime={new Date(time).toISOString()}>
            {new Date(time).toUTCString()}
          </time>
        ) : (
          <span className="timeline__clock" aria-hidden="true">
            &mdash;
          </span>
        )}

        <button
          type="button"
          className="timeline__disclosure"
          aria-expanded={controlsOpen}
          onClick={() => setScrubOpen((open) => !open)}
          data-testid="timeline-disclosure"
        >
          {controlsOpen ? "Hide time controls" : "Change time"}
        </button>
      </div>

      <div className="timeline__controls">
        <input
          type="range"
          className="timeline__scrubber"
          min={0}
          max={1}
          step={0.001}
          value={sliderValue}
          aria-label="Scrub time"
          onChange={(event) => scrub(Number(event.target.value))}
        />

        <button
          type="button"
          className="timeline__live-button"
          onClick={returnToLive}
          disabled={mode === "live"}
          data-testid="return-to-live"
        >
          Return to live
        </button>
      </div>
    </div>
  );
}
