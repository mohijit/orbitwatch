"use client";

import type { PanelId } from "../../hooks/use-panels";

/**
 * The left-hand rail: one toggle per panel, and a way to put the whole thing away.
 *
 * WHY A RAIL RATHER THAN ONE STACKED PANEL
 * The four context panels used to be a single scrolling column, which meant a user who
 * wanted the pass list also got space weather, solar activity and launches above it —
 * and had to scroll past all of them. They answer different questions and are wanted at
 * different times, so they are independent.
 *
 * HIDING IS A REAL STATE, WITH A REAL WAY BACK
 * "Show the Earth and nothing else" is a legitimate thing to want. But a control that
 * removes every control is a trap, so hiding the rail leaves one small button behind —
 * always focusable, always in the same place — rather than relying on a gesture or a
 * shortcut nobody was told about.
 */

export interface PanelDefinition {
  readonly id: PanelId;
  readonly label: string;
  /** Short glyph for the rail. Decorative: the label is the accessible name. */
  readonly glyph: string;
}

export const PANEL_DEFINITIONS: readonly PanelDefinition[] = [
  { id: "tonight", label: "Visible tonight", glyph: "◆" },
  { id: "weather", label: "Space weather", glyph: "≈" },
  { id: "solar", label: "Solar activity", glyph: "☉" },
  { id: "launches", label: "Next launches", glyph: "↑" },
  { id: "imagery", label: "Imagery", glyph: "▦" },
];

export interface PanelRailProps {
  readonly open: Readonly<Record<PanelId, boolean>>;
  /**
   * Which panel is in front, when only one can be.
   *
   * Undefined in the wide layout, and that is not an oversight: there, every open panel
   * is on screen simultaneously, so there is no "in front" and claiming one would be
   * false. In one column two tabs can both be pressed — both panels are open — while
   * only one is in the sheet, and `aria-pressed` alone cannot tell those apart. This is
   * what distinguishes them, for a reader who cannot see which card is showing.
   */
  readonly activePanel?: PanelId | undefined;
  readonly visible: boolean;
  readonly onToggle: (id: PanelId) => void;
  readonly onSetVisible: (visible: boolean) => void;
}

export function PanelRail({
  open,
  activePanel,
  visible,
  onToggle,
  onSetVisible,
}: PanelRailProps) {
  if (!visible) {
    return (
      <button
        type="button"
        className="panel-rail__restore"
        onClick={() => {
          onSetVisible(true);
        }}
        // The one control left when everything is hidden. Its name says what it brings
        // back, because a lone glyph in a corner is not a discoverable affordance.
        aria-label="Show panel controls"
        data-testid="panel-rail-restore"
      >
        ☰
      </button>
    );
  }

  const openCount = PANEL_DEFINITIONS.filter((panel) => open[panel.id]).length;

  return (
    <nav className="panel-rail" aria-label="Information panels" data-testid="panel-rail">
      {PANEL_DEFINITIONS.map((panel) => (
        <button
          key={panel.id}
          type="button"
          className={`panel-rail__button${open[panel.id] ? " panel-rail__button--on" : ""}`}
          // aria-pressed, not aria-expanded: these are toggle buttons whose panels are
          // siblings rather than children, so "pressed" is the accurate relationship.
          aria-pressed={open[panel.id]}
          // Only ever set where an "in front" genuinely exists. Omitted entirely rather
          // than set to false, because `aria-current="false"` on four of five tabs is
          // noise in a place that should carry one fact.
          {...(activePanel === panel.id ? { "aria-current": true as const } : {})}
          onClick={() => {
            onToggle(panel.id);
          }}
          data-testid={`panel-toggle-${panel.id}`}
        >
          <span className="panel-rail__glyph" aria-hidden="true">
            {panel.glyph}
          </span>
          <span className="panel-rail__label">{panel.label}</span>
        </button>
      ))}

      <button
        type="button"
        className="panel-rail__hide"
        onClick={() => {
          onSetVisible(false);
        }}
        aria-label={
          openCount === 0
            ? "Hide panel controls"
            : `Hide panel controls and ${String(openCount)} open panel${openCount === 1 ? "" : "s"}`
        }
        data-testid="panel-rail-hide"
      >
        <span className="panel-rail__glyph" aria-hidden="true">
          ✕
        </span>
        <span className="panel-rail__label">Hide all</span>
      </button>
    </nav>
  );
}
