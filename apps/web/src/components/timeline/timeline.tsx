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

  return (
    <div className="timeline" data-testid="timeline">
      <div className="timeline__mode" data-testid="timeline-mode">
        {mode === "live" ? (
          <span className="timeline__live-badge">LIVE</span>
        ) : (
          <span className="timeline__sim-badge">SIMULATION</span>
        )}
        <time className="timeline__clock" dateTime={new Date(time).toISOString()}>
          {new Date(time).toUTCString()}
        </time>
      </div>

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
  );
}
