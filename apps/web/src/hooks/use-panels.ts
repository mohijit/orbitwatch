"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Which side panels are open, and whether the rail itself is shown.
 *
 * INDEPENDENT TOGGLES, NOT AN ACCORDION
 * Someone deciding whether tonight's pass is worth going outside for wants the pass
 * list AND the space weather at once — one tells them where to look, the other tells
 * them whether a storm has been degrading the elements it was computed from. Forcing a
 * single panel would make the product worse at the question it exists to answer.
 *
 * THE GLOBE IS ALLOWED TO BE THE WHOLE SCREEN
 * Hiding the rail entirely is a first-class state, not a hidden power-user trick. A lot
 * of the time the honest answer to "what do you want" is "to look at the Earth", and an
 * instrument panel that cannot be put away is an instrument panel that gets in the way.
 *
 * PERSISTED, DEFENSIVELY
 * A layout choice that resets on every reload is not a choice. Storage is read inside
 * try/catch because it genuinely throws — Safari private mode, blocked site data — and
 * a corrupt or half-written value must produce the default rather than a crash on the
 * first paint.
 */

export const PANEL_IDS = ["weather", "solar", "launches", "tonight", "imagery"] as const;

export type PanelId = (typeof PANEL_IDS)[number];

export interface PanelState {
  readonly open: Readonly<Record<PanelId, boolean>>;
  /**
   * The one panel a single-column layout should show.
   *
   * Desktop ignores this entirely and renders every open panel side by side — the
   * argument above for independent toggles still holds where there is room for them.
   * A phone has one column, so it needs an answer to "which of these is in front",
   * and the most recently opened panel is that answer: it is the one the user just
   * asked for. Falls back to another still-open panel when that one is closed, and to
   * `undefined` only when nothing is open.
   */
  readonly activePanel: PanelId | undefined;
  /** False when the user has put the whole rail away. */
  readonly railVisible: boolean;
  readonly toggle: (id: PanelId) => void;
  /**
   * Move an already-open panel to the front without changing what is open.
   *
   * A single-column layout needs this and a wide one does not, which is exactly why it
   * is separate from `toggle`. In a tab bar, a panel can be open and behind another,
   * and tapping its tab plainly means "show me that one" — routing it through `toggle`
   * would close it instead, which is the opposite of what was asked for.
   */
  readonly bringToFront: (id: PanelId) => void;
  readonly setRailVisible: (visible: boolean) => void;
}

const STORAGE_KEY = "orbitwatch.panels.v1";

/**
 * Nothing open, rail shown.
 *
 * A first-time visitor gets the globe and the means to open anything, rather than four
 * panels of context they did not ask for over the thing they came to see.
 */
const DEFAULT_OPEN: Record<PanelId, boolean> = {
  weather: false,
  solar: false,
  launches: false,
  tonight: true,
  imagery: false,
};

interface Stored {
  readonly open?: Partial<Record<PanelId, unknown>>;
  readonly railVisible?: unknown;
}

function readStored(): { open: Record<PanelId, boolean>; railVisible: boolean } {
  const fallback = { open: { ...DEFAULT_OPEN }, railVisible: true };

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return fallback;

    const parsed = JSON.parse(raw) as Stored;
    const open = { ...DEFAULT_OPEN };
    for (const id of PANEL_IDS) {
      const value = parsed.open?.[id];
      // Only a real boolean overrides the default. A value of the wrong type is a
      // stored shape from an older version, not an instruction.
      if (typeof value === "boolean") open[id] = value;
    }

    return {
      open,
      railVisible: typeof parsed.railVisible === "boolean" ? parsed.railVisible : true,
    };
  } catch {
    return fallback;
  }
}

/** The first open panel in rail order, so the fallback is stable rather than arbitrary. */
function firstOpen(open: Readonly<Record<PanelId, boolean>>): PanelId | undefined {
  return PANEL_IDS.find((id) => open[id]);
}

interface PanelLayout {
  readonly open: Record<PanelId, boolean>;
  readonly activePanel: PanelId | undefined;
}

export function usePanels(): PanelState {
  /*
   * Started from the defaults, not from storage.
   *
   * This component renders on the server during prerender, where `window` does not
   * exist, and a first client render that disagreed with the server's HTML is a
   * hydration mismatch. The stored value is applied in an effect immediately after
   * mount instead — one frame of the default layout is a far smaller cost than a
   * hydration error.
   */
  /*
   * `open` and `activePanel` are one piece of state, not two.
   *
   * They are derived from the same event and read in the same render — the panel in
   * front must be one of the open ones — so holding them separately would mean a
   * transition where the pair disagreed and the sheet rendered a panel the tab bar said
   * was closed. It also keeps the updater pure: the alternative was calling
   * `setActivePanel` from inside the `setOpen` updater, which React is entitled to run
   * twice.
   */
  const [layout, setLayout] = useState<PanelLayout>(() => ({
    open: { ...DEFAULT_OPEN },
    activePanel: firstOpen(DEFAULT_OPEN),
  }));
  const { open, activePanel } = layout;
  const [railVisible, setRail] = useState(true);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    const stored = readStored();
    // Which panel was in front is deliberately NOT persisted. It is a "where am I right
    // now" detail, not a layout choice, and restoring it would mean a phone reopening on
    // whatever happened to be last tapped days ago rather than on its default.
    setLayout({ open: stored.open, activePanel: firstOpen(stored.open) });
    setRail(stored.railVisible);
    setRestored(true);
  }, []);

  useEffect(() => {
    // Not written until the stored value has been read, or the first render would
    // overwrite the user's saved layout with the defaults.
    if (!restored) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ open, railVisible }));
    } catch {
      // Storage being unavailable is not a reason to break the page. The layout simply
      // does not persist, which is the mild failure.
    }
  }, [open, railVisible, restored]);

  const toggle = useCallback((id: PanelId) => {
    setLayout((current) => {
      const open = { ...current.open, [id]: !current.open[id] };
      // Just opened: it is what the user asked for, so it goes in front. Just closed:
      // only the panel that WAS in front needs replacing, and the rail order gives a
      // stable answer rather than an arbitrary one.
      const activePanel = open[id]
        ? id
        : current.activePanel === id
          ? firstOpen(open)
          : current.activePanel;
      return { open, activePanel };
    });
  }, []);

  const bringToFront = useCallback((id: PanelId) => {
    // Only for a panel that is already open. Promoting a closed one would be `toggle`
    // wearing a different name, and would let a caller open something without the tab
    // state that says so.
    setLayout((current) => (current.open[id] ? { ...current, activePanel: id } : current));
  }, []);

  const setRailVisible = useCallback((visible: boolean) => {
    setRail(visible);
  }, []);

  return { open, activePanel, railVisible, toggle, bringToFront, setRailVisible };
}
