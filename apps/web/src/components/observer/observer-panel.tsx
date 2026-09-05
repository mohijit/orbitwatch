"use client";

import type { ObserverLighting } from "@orbitwatch/orbit-core";
import { useState } from "react";

import type { ObserverApi } from "../../hooks/use-observer";

/**
 * Setting and reviewing the observing location.
 *
 * Four ways in, because no single one works everywhere: a device fix needs permission
 * and a sensor, clicking the globe needs to know roughly where you are already, and
 * typing coordinates needs you to have them. The panel offers all of them and states
 * which one produced the current position, so a surprising pass time can be traced
 * back to a surprising location.
 *
 * There is deliberately no default location. A tracker that quietly assumes a city
 * will confidently tell you a satellite passes overhead when it passes over somewhere
 * else, and nothing on screen would reveal the assumption.
 */

export interface ObserverPanelProps {
  readonly observer: ObserverApi;
  /** Whether the globe is currently in "click to set my location" mode. */
  readonly picking: boolean;
  readonly onTogglePicking: () => void;
  readonly sunAltitude: number | undefined;
  readonly lighting: ObserverLighting | undefined;
}

const LIGHTING_LABEL: Record<ObserverLighting, string> = {
  DAYLIGHT: "Daylight",
  TWILIGHT: "Twilight",
  DARK: "Dark",
};

/** Degrees to a signed, hemisphere-labelled string. */
function formatLatitude(value: number): string {
  return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? "N" : "S"}`;
}

function formatLongitude(value: number): string {
  return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? "E" : "W"}`;
}

export function ObserverPanel({
  observer,
  picking,
  onTogglePicking,
  sunAltitude,
  lighting,
}: ObserverPanelProps) {
  const [open, setOpen] = useState(false);
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [altitude, setAltitude] = useState("");
  const [manualError, setManualError] = useState<string | undefined>(undefined);

  const { state } = observer;

  const submitManual = (event: React.FormEvent): void => {
    event.preventDefault();
    const lat = Number(latitude.trim());
    const lon = Number(longitude.trim());
    // Metres in the box, kilometres in the model: people know their elevation in
    // metres, and orbit-core works in kilometres. Converting here keeps the
    // conversion in one visible place rather than in the reader's head.
    const altitudeMetres = altitude.trim() === "" ? 0 : Number(altitude.trim());

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(altitudeMetres)) {
      setManualError("Latitude, longitude and elevation must be numbers.");
      return;
    }
    setManualError(undefined);
    observer.setLocation(
      { latitude: lat, longitude: lon, altitude: altitudeMetres / 1000 },
      "MANUAL",
    );
  };

  const summary =
    state.status === "set"
      ? `${formatLatitude(state.observer.latitude)}, ${formatLongitude(state.observer.longitude)}`
      : state.status === "locating"
        ? "Locating…"
        : "No location set";

  return (
    <section className="observer-panel" data-testid="observer-panel" aria-label="Observing location">
      <button
        type="button"
        className="observer-panel__summary"
        data-testid="observer-summary"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className="observer-panel__label">Observer</span>
        <span className="observer-panel__value">{summary}</span>
      </button>

      {state.status === "set" && lighting !== undefined ? (
        <div className="observer-panel__sky" data-testid="observer-sky">
          <span className={`observer-panel__lighting observer-panel__lighting--${lighting.toLowerCase()}`}>
            {LIGHTING_LABEL[lighting]}
          </span>
          {sunAltitude === undefined ? null : (
            <span className="observer-panel__sun" data-testid="observer-sun-altitude">
              sun {sunAltitude >= 0 ? "+" : "−"}
              {Math.abs(sunAltitude).toFixed(1)}°
            </span>
          )}
        </div>
      ) : null}

      {open ? (
        <div className="observer-panel__body">
          <div className="observer-panel__actions">
            <button
              type="button"
              onClick={observer.requestDeviceLocation}
              disabled={state.status === "locating"}
              data-testid="observer-use-device"
            >
              {state.status === "locating" ? "Locating…" : "Use my device"}
            </button>
            <button
              type="button"
              onClick={onTogglePicking}
              aria-pressed={picking}
              data-testid="observer-pick-globe"
            >
              {picking ? "Click the globe…" : "Pick on globe"}
            </button>
            {state.status === "set" ? (
              <button type="button" onClick={observer.clear} data-testid="observer-clear">
                Clear
              </button>
            ) : null}
          </div>

          {state.status === "denied" ? (
            <p className="observer-panel__error" role="alert" data-testid="observer-error">
              {state.message}
            </p>
          ) : null}

          <form className="observer-panel__manual" onSubmit={submitManual}>
            <label>
              Latitude
              <input
                type="text"
                inputMode="decimal"
                value={latitude}
                onChange={(event) => setLatitude(event.target.value)}
                placeholder="-33.8688"
                aria-label="Latitude in degrees"
              />
            </label>
            <label>
              Longitude
              <input
                type="text"
                inputMode="decimal"
                value={longitude}
                onChange={(event) => setLongitude(event.target.value)}
                placeholder="151.2093"
                aria-label="Longitude in degrees"
              />
            </label>
            <label>
              Elevation (m)
              <input
                type="text"
                inputMode="decimal"
                value={altitude}
                onChange={(event) => setAltitude(event.target.value)}
                placeholder="0"
                aria-label="Elevation above the ellipsoid, in metres"
              />
            </label>
            <button type="submit" data-testid="observer-set-manual">
              Set
            </button>
          </form>

          {manualError === undefined ? null : (
            <p className="observer-panel__error" role="alert">
              {manualError}
            </p>
          )}

          {state.status === "set" ? (
            <p className="observer-panel__provenance" data-testid="observer-provenance">
              {state.observer.source === "DEVICE"
                ? `From this device${
                    state.observer.accuracyMetres === undefined
                      ? ""
                      : `, accurate to about ${Math.round(state.observer.accuracyMetres)} m`
                  }.`
                : state.observer.source === "GLOBE"
                  ? "Picked on the globe. Accurate to roughly where you clicked."
                  : "Entered by hand."}{" "}
              Elevation {(state.observer.altitude * 1000).toFixed(0)} m. Stored only in
              this browser and never sent anywhere.
            </p>
          ) : (
            <p className="observer-panel__provenance">
              Pass times and look angles need a location. OrbitWatch will not guess one:
              an assumed city would produce confident, wrong answers.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
