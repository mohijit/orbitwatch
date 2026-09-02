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
  /** False when the user has put the whole rail away. */
  readonly railVisible: boolean;
  readonly toggle: (id: PanelId) => void;
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
  const [open, setOpen] = useState<Record<PanelId, boolean>>(() => ({ ...DEFAULT_OPEN }));
  const [railVisible, setRail] = useState(true);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    const stored = readStored();
    setOpen(stored.open);
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
    setOpen((current) => ({ ...current, [id]: !current[id] }));
  }, []);

  const setRailVisible = useCallback((visible: boolean) => {
    setRail(visible);
  }, []);

  return { open, railVisible, toggle, setRailVisible };
}
