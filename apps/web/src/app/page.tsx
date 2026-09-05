"use client";

import { useEffect, useState } from "react";

import { BottomSheet, type SheetDetent } from "@/components/shell/bottom-sheet";
import { SatelliteGlobe } from "@/components/globe/satellite-globe";
import { LookAnglesInstrument } from "@/components/observer/look-angles";
import { ObserverPanel } from "@/components/observer/observer-panel";
import { PassList } from "@/components/observer/pass-list";
import { VisibleTonightPanel } from "@/components/observer/visible-tonight";
import { RadioPanel } from "@/components/telemetry/radio-panel";
import { SpaceWeatherPanel } from "@/components/telemetry/space-weather";
import { ImageryPicker } from "@/components/globe/imagery-picker";
import { OfflineBanner } from "@/components/shell/offline-banner";
import { PANEL_DEFINITIONS, PanelRail } from "@/components/shell/panel-rail";
import { ServiceWorkerRegistration } from "@/components/shell/service-worker";
import { SolarEvents } from "@/components/telemetry/solar-events";
import { UpcomingLaunches } from "@/components/telemetry/upcoming-launches";
import { CommandPalette } from "@/components/search/command-palette";
import { TelemetryPanel } from "@/components/telemetry/telemetry-panel";
import { Timeline, type TimelineMode } from "@/components/timeline/timeline";
import { useCatalogPositions } from "@/hooks/use-catalog-positions";
import { NARROW_VIEWPORT, useMediaQuery } from "@/hooks/use-media-query";
import { useObserver } from "@/hooks/use-observer";
import { useObserverTelemetry } from "@/hooks/use-observer-telemetry";
import { useOnline } from "@/hooks/use-online";
import { PANEL_IDS, usePanels, type PanelId } from "@/hooks/use-panels";
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
  const [imageryLayerId, setImageryLayerId] = useState<string | undefined>(undefined);
  const [detent, setDetent] = useState<SheetDetent>("peek");
  const panels = usePanels();
  const online = useOnline();

  /*
   * Narrow means one column, which forces two questions the wide layout never has to
   * answer: which open panel is in front, and how much of the globe is covered.
   *
   * `false` until the first effect runs, so the prerendered HTML and the first client
   * render agree. Everything below must therefore be correct in the wide arrangement
   * first and adapt afterwards — which is the right default anyway.
   */
  const narrow = useMediaQuery(NARROW_VIEWPORT);

  /**
   * Whether a panel is mounted at all.
   *
   * Wide: every open panel, side by side. Narrow: only the one in front — because each
   * of these fetches on mount and refreshes on a timer, and the point of unmounting a
   * closed panel is that it stops polling. A phone on a metered connection should be
   * talking to one provider, not five.
   */
  const shows = (id: PanelId): boolean =>
    panels.open[id] && (!narrow || panels.activePanel === id);

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

  /*
   * Selecting an object raises the sheet.
   *
   * On a wide screen the telemetry panel appears in a corner and the globe is otherwise
   * untouched. In one column there is nowhere for it to appear, so a selection that left
   * the sheet at peek would answer "which object is this" with a name and nothing else.
   * Raised to half rather than full: the user selected something ON the globe, and
   * covering the globe to describe it takes away what they were looking at.
   */
  useEffect(() => {
    if (selectedCatalogId === undefined) return;
    setDetent((current) => (current === "peek" ? "half" : current));
  }, [selectedCatalogId]);

  /**
   * What a rail button does — which is not the same thing in one column as in two.
   *
   * Wide, every open panel is on screen at once, so the only question a button answers
   * is open or closed, and it toggles.
   *
   * Narrow, a panel can be open and BEHIND another one. Tapping its tab there plainly
   * means "show me that one", and toggling would close it instead — which is how this
   * behaved when first written, and it is baffling: the tab you tap to see something
   * makes it disappear. So in one column a background tab is promoted, and only the tab
   * already in front toggles, which is what makes it the way back to the globe.
   */
  const handlePanelToggle = (id: PanelId): void => {
    const wasOpen = panels.open[id];
    const wasInFront = panels.activePanel === id;

    if (narrow && wasOpen && !wasInFront) {
      panels.bringToFront(id);
      setDetent((current) => (current === "peek" ? "half" : current));
      return;
    }

    panels.toggle(id);
    if (!wasOpen) setDetent((current) => (current === "peek" ? "half" : current));
    else if (wasInFront) setDetent("peek");
  };

  const handleTimelineChange = (nextTime: number, nextMode: TimelineMode): void => {
    setTime(nextTime);
    setMode(nextMode);
  };

  // What the sheet is showing, for the handle's accessible name. Selection wins over the
  // active panel, matching what the sheet actually renders first.
  const sheetLabel =
    selectedCatalogId !== undefined
      ? telemetry.status === "ready"
        ? telemetry.name
        : "Satellite details"
      : (PANEL_DEFINITIONS.find((panel) => panel.id === panels.activePanel)?.label ?? "Panels");

  const panelsShown = panels.railVisible && PANEL_IDS.some(shows);
  const sheetHasContent = selectedCatalogId !== undefined || panelsShown;

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

      <ServiceWorkerRegistration />

      {/*
        Below the header rather than above it, so appearing and disappearing does not
        shove the whole page down and back. It sits over the globe, which is the one
        thing on screen that keeps moving while offline and therefore the one thing
        most likely to be misread as a live feed.
      */}
      <OfflineBanner
        online={online}
        fromCache={catalogState.status === "ready" && catalogState.fromCache}
        retrievedAt={catalogState.status === "ready" ? catalogState.retrievedAt : undefined}
      />

      <SatelliteGlobe
        catalogState={catalogState}
        selectedCatalogId={selectedCatalogId}
        onSelect={setSelectedCatalogId}
        telemetry={telemetry}
        live={mode === "live"}
        observer={observer.location}
        pickingLocation={pickingLocation}
        onPickLocation={handlePickLocation}
        imageryLayerId={imageryLayerId}
      />

      {pickingLocation ? (
        <div className="shell__picking" role="status" data-testid="picking-hint">
          Click anywhere on the globe to set your observing location.
        </div>
      ) : null}

      {/*
        One container for everything that is "not the globe".

        Wide, this is a transparent click-through box the size of the shell, and the two
        cards inside position themselves against it exactly as they did when they were
        siblings — the sheet chrome is hidden and nothing moves. Narrow, it becomes the
        bottom sheet and the cards flow into it. Same DOM either way, so there is one
        accessibility tree and the panels are mounted once, not twice.
      */}
      {sheetHasContent ? (
        <BottomSheet detent={detent} onDetentChange={setDetent} label={sheetLabel}>
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

          {/*
            Only the panels being shown are rendered, not merely hidden with CSS.

            Each of these fetches on mount and refreshes on a timer, so keeping a closed
            panel mounted would poll four providers for a user looking at the globe. It
            also means the stack has no height when nothing is open, which is what makes
            "just show me the Earth" actually show them the Earth. In one column `shows`
            narrows this further to the single panel in front, for the same reason.
          */}
          {panelsShown ? (
            <aside className="panel-stack" aria-label="Information panels">
              {shows("tonight") ? (
                <div className="panel-stack__panel">
                  <VisibleTonightPanel
                    state={worker.visibleTonight}
                    hasObserver={observer.location !== undefined}
                    groupUnavailable={visualGroup.status === "unavailable"}
                    onRefresh={refreshVisibleTonight}
                  />
                </div>
              ) : null}

              {shows("weather") ? (
                <div className="panel-stack__panel">
                  <SpaceWeatherPanel />
                </div>
              ) : null}

              {shows("solar") ? (
                <div className="panel-stack__panel">
                  <SolarEvents />
                </div>
              ) : null}

              {shows("launches") ? (
                <div className="panel-stack__panel">
                  <UpcomingLaunches />
                </div>
              ) : null}

              {shows("imagery") ? (
                <div className="panel-stack__panel">
                  <ImageryPicker selected={imageryLayerId} onSelect={setImageryLayerId} />
                </div>
              ) : null}
            </aside>
          ) : null}
        </BottomSheet>
      ) : null}

      <PanelRail
        open={panels.open}
        // Only meaningful in one column; wide, every open panel is already on screen.
        activePanel={narrow ? panels.activePanel : undefined}
        visible={panels.railVisible}
        onToggle={handlePanelToggle}
        onSetVisible={panels.setRailVisible}
      />

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

      {/*
        The link is not decoration. This strip is one line on a phone, which is not
        enough room to qualify a claim properly, and the full account of how a position
        is derived and what it is worth already exists on /methodology. Everything else
        here is `pointer-events: none` — the paragraph was intercepting clicks meant for
        the panels behind it.
      */}
      <footer className="shell__note">
        Positions in this product are calculated from published orbital elements using
        SGP4/SDP4. They are not continuous onboard GPS telemetry.{" "}
        <a href="/methodology">How this is derived</a>.
      </footer>
    </main>
  );
}
