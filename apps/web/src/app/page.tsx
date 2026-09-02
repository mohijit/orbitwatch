"use client";

import { useEffect, useState } from "react";

import { SatelliteGlobe } from "@/components/globe/satellite-globe";
import { LookAnglesInstrument } from "@/components/observer/look-angles";
import { ObserverPanel } from "@/components/observer/observer-panel";
import { PassList } from "@/components/observer/pass-list";
import { VisibleTonightPanel } from "@/components/observer/visible-tonight";
import { RadioPanel } from "@/components/telemetry/radio-panel";
import { SpaceWeatherPanel } from "@/components/telemetry/space-weather";
import { CommandPalette } from "@/components/search/command-palette";
import { TelemetryPanel } from "@/components/telemetry/telemetry-panel";
import { Timeline, type TimelineMode } from "@/components/timeline/timeline";
import { useCatalogPositions } from "@/hooks/use-catalog-positions";
import { useObserver } from "@/hooks/use-observer";
import { useObserverTelemetry } from "@/hooks/use-observer-telemetry";
import { useVisualGroup } from "@/hooks/use-visual-group";
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

  const worker = useCatalogPositions(time);
  const catalogState = worker.catalog;
  const visualGroup = useVisualGroup();
  const telemetry = useSelectedSatellite(selectedCatalogId, time, mode);
  const observer = useObserver();

  // Look angles and passes are relative to the SELECTED object, so they follow the
  // selection rather than being computed for the whole catalog.
  const observerTelemetry = useObserverTelemetry(
    telemetry.status === "ready" ? telemetry.satrec : undefined,
    observer.location,
    time,
  );

  // Search once, when the observer, the group and the parsed catalog are all present.
  // Keyed on the observer's coordinates rather than the object identity, so a
  // re-render does not re-run seconds of SGP4 for the same location.
  const observerKey =
    observer.location === undefined
      ? undefined
      : `${observer.location.latitude},${observer.location.longitude},${observer.location.altitude}`;
  const catalogReady = catalogState.status === "ready";
  const groupIds = visualGroup.status === "ready" ? visualGroup.catalogIds : undefined;
  const { requestVisibleTonight } = worker;

  useEffect(() => {
    if (observer.location === undefined || groupIds === undefined || !catalogReady) return;
    requestVisibleTonight(
      {
        latitude: observer.location.latitude,
        longitude: observer.location.longitude,
        altitude: observer.location.altitude,
      },
      groupIds,
      Date.now(),
    );
    // `time` and `observer.location` are deliberately absent from the deps. The search
    // covers tonight, not this second, and re-running it every tick would burn seconds
    // of propagation to produce an identical list; `observerKey` stands in for the
    // location because it changes only when the coordinates do. Refresh is how a user
    // asks for it again.
  }, [observerKey, groupIds, catalogReady, requestVisibleTonight]);

  const refreshVisibleTonight = (): void => {
    if (observer.location === undefined || groupIds === undefined) return;
    requestVisibleTonight(
      {
        latitude: observer.location.latitude,
        longitude: observer.location.longitude,
        altitude: observer.location.altitude,
      },
      groupIds,
      Date.now(),
    );
  };

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
      {/*
        The globe is the product, and it is the LAST thing a keyboard user would reach
        by tabbing through a header of controls. This puts it one key away.
      */}
      <a className="shell__skip" href="#globe">
        Skip to the globe
      </a>

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
        {/*
          Three states, not two.

          This used to render "LOADING…" for everything that was not ready, so a
          catalog that had FAILED claimed to still be trying — indefinitely, and with
          no way for a user to tell the difference between a slow network and a dead
          one. The globe shows an error overlay behind it, but the badge is what
          people read, and it was the one part of the page still saying "wait".
        */}
        <span
          className={`shell__badge${catalogState.status === "failed" ? " shell__badge--error" : ""}`}
          data-testid="catalog-count"
        >
          {catalogState.status === "ready"
            ? `${catalogState.count.toLocaleString()} OBJECTS`
            : catalogState.status === "failed"
              ? "CATALOG UNAVAILABLE"
              : "LOADING…"}
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
        <RadioPanel catalogId={selectedCatalogId} />
        <PassList
          passes={observerTelemetry.passes}
          hasObserver={observer.location !== undefined}
          satrec={telemetry.status === "ready" ? telemetry.satrec : undefined}
          observer={observer.location}
        />
      </TelemetryPanel>

      <aside className="tonight-panel" aria-label="Visible tonight">
        <SpaceWeatherPanel />
        <VisibleTonightPanel
          state={worker.visibleTonight}
          hasObserver={observer.location !== undefined}
          groupUnavailable={visualGroup.status === "unavailable"}
          onRefresh={refreshVisibleTonight}
        />
      </aside>

      {/*
        Selecting a satellite opens a panel somewhere else on the page. A sighted user
        sees it appear; without this, a screen-reader user gets nothing at all, because
        focus has not moved and the change is off-screen. Polite rather than assertive:
        it should be spoken at the next pause, not cut off whatever is being read.
      */}
      <p
        className="shell__visually-hidden"
        role="status"
        aria-live="polite"
        data-testid="selection-status"
      >
        {selectedCatalogId === undefined
          ? "No satellite selected."
          : telemetry.status === "ready"
            ? `Selected ${telemetry.name}, catalog number ${selectedCatalogId}. ` +
              `Telemetry, look angles and passes are now shown.`
            : `Loading satellite ${selectedCatalogId}.`}
      </p>

      <Timeline time={time} mode={mode} onChange={handleTimelineChange} />

      <footer className="shell__note">
        Positions in this product are calculated from published orbital elements using
        SGP4/SDP4. They are not continuous onboard GPS telemetry.
      </footer>
    </main>
  );
}
