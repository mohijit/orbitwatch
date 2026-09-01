"use client";

import { useEffect, useState } from "react";

import { SatelliteGlobe } from "@/components/globe/satellite-globe";
import { LookAnglesInstrument } from "@/components/observer/look-angles";
import { ObserverPanel } from "@/components/observer/observer-panel";
import { PassList } from "@/components/observer/pass-list";
import { CommandPalette } from "@/components/search/command-palette";
import { TelemetryPanel } from "@/components/telemetry/telemetry-panel";
import { Timeline, type TimelineMode } from "@/components/timeline/timeline";
import { useCatalogPositions } from "@/hooks/use-catalog-positions";
import { useObserver } from "@/hooks/use-observer";
import { useObserverTelemetry } from "@/hooks/use-observer-telemetry";
import { useSelectedSatellite } from "@/hooks/use-selected-satellite";
import { BRANDING } from "@/lib/branding";

/**
 * The web app: the live globe, search, selection, telemetry, timeline, and — from M4 —
 * the observer.
 *
 * State lives here and flows one way down to the globe, panels and timeline — the
 * globe reports clicks up via `onSelect` and `onPickLocation`, nothing lower owns app
 * state.
 */
export default function HomePage() {
  const [time, setTime] = useState(() => Date.now());
  const [mode, setMode] = useState<TimelineMode>("live");
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | undefined>(undefined);
  const [pickingLocation, setPickingLocation] = useState(false);

  // LIVE mode means "now, continuously": advance the clock every second, which
  // matches the worker's default 1 Hz tick rate. SIMULATION freezes it at whatever
  // instant the timeline scrubbed to.
  useEffect(() => {
    if (mode !== "live") return;
    const interval = setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [mode]);

  const catalogState = useCatalogPositions(time);
  const telemetry = useSelectedSatellite(selectedCatalogId, time, mode);
  const observer = useObserver();

  // Look angles and passes are relative to the SELECTED object, so they follow the
  // selection rather than being computed for the whole catalog.
  const observerTelemetry = useObserverTelemetry(
    telemetry.status === "ready" ? telemetry.satrec : undefined,
    observer.location,
    time,
  );

  const handleTimelineChange = (nextTime: number, nextMode: TimelineMode): void => {
    setTime(nextTime);
    setMode(nextMode);
  };

  const handlePickLocation = (latitude: number, longitude: number): void => {
    // Altitude is deliberately not inferred from the click. The globe knows the
    // ellipsoid, not the terrain, so it would be zero dressed up as a measurement.
    observer.setLocation({ latitude, longitude }, "GLOBE");
    setPickingLocation(false);
  };

  return (
    <main className="shell">
      <header className="shell__bar">
        <span className="shell__brand">{BRANDING.name}</span>
        <CommandPalette onSelect={setSelectedCatalogId} />
        <ObserverPanel
          observer={observer}
          picking={pickingLocation}
          onTogglePicking={() => setPickingLocation((wasPicking) => !wasPicking)}
          sunAltitude={observerTelemetry.sunAltitude}
          lighting={observerTelemetry.lighting}
        />
        <span className="shell__badge" data-testid="catalog-count">
          {catalogState.status === "ready" ? `${catalogState.count.toLocaleString()} OBJECTS` : "LOADING…"}
        </span>
      </header>

      <SatelliteGlobe
        catalogState={catalogState}
        selectedCatalogId={selectedCatalogId}
        onSelect={setSelectedCatalogId}
        telemetry={telemetry}
        live={mode === "live"}
        observer={observer.location}
        pickingLocation={pickingLocation}
        onPickLocation={handlePickLocation}
      />

      {pickingLocation ? (
        <div className="shell__picking" role="status" data-testid="picking-hint">
          Click anywhere on the globe to set your observing location.
        </div>
      ) : null}

      <TelemetryPanel
        catalogId={selectedCatalogId}
        telemetry={telemetry}
        onClose={() => setSelectedCatalogId(undefined)}
      >
        <LookAnglesInstrument
          lookAngles={observerTelemetry.lookAngles}
          hasObserver={observer.location !== undefined}
        />
        <PassList
          passes={observerTelemetry.passes}
          hasObserver={observer.location !== undefined}
        />
      </TelemetryPanel>

      <Timeline time={time} mode={mode} onChange={handleTimelineChange} />

      <footer className="shell__note">
        Positions in this product are calculated from published orbital elements using
        SGP4/SDP4. They are not continuous onboard GPS telemetry.
      </footer>
    </main>
  );
}
