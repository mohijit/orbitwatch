"use client";

import { useEffect, useState } from "react";

import { SatelliteGlobe } from "@/components/globe/satellite-globe";
import { CommandPalette } from "@/components/search/command-palette";
import { TelemetryPanel } from "@/components/telemetry/telemetry-panel";
import { Timeline, type TimelineMode } from "@/components/timeline/timeline";
import { useCatalogPositions } from "@/hooks/use-catalog-positions";
import { useSelectedSatellite } from "@/hooks/use-selected-satellite";
import { BRANDING } from "@/lib/branding";

/**
 * The M3 web MVP: the live globe, search, selection, telemetry and the timeline.
 *
 * State lives here and flows one way down to the globe, panel and timeline — the
 * globe reports clicks up via `onSelectedCatalogId`, nothing lower owns app state.
 */
export default function HomePage() {
  const [time, setTime] = useState(() => Date.now());
  const [mode, setMode] = useState<TimelineMode>("live");
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | undefined>(undefined);

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

  const handleTimelineChange = (nextTime: number, nextMode: TimelineMode): void => {
    setTime(nextTime);
    setMode(nextMode);
  };

  return (
    <main className="shell">
      <header className="shell__bar">
        <span className="shell__brand">{BRANDING.name}</span>
        <CommandPalette onSelect={setSelectedCatalogId} />
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
      />

      <TelemetryPanel
        catalogId={selectedCatalogId}
        telemetry={telemetry}
        onClose={() => setSelectedCatalogId(undefined)}
      />

      <Timeline time={time} mode={mode} onChange={handleTimelineChange} />

      <footer className="shell__note">
        Positions in this product are calculated from published orbital elements using
        SGP4/SDP4. They are not continuous onboard GPS telemetry.
      </footer>
    </main>
  );
}
