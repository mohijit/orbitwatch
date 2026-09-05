"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { NARROW_VIEWPORT, useMediaQuery } from "../../hooks/use-media-query";

/**
 * The narrow-viewport container for panels and telemetry.
 *
 * WHY A SHEET RATHER THAN A SMALLER FLOATING CARD
 * On a 390px screen a floating card IS the screen — there is no "beside the globe" to
 * float next to. A sheet is honest about that: it says how much of the globe it is
 * covering, and it lets the user change that with one gesture instead of opening and
 * closing panels to get a look at the Earth.
 *
 * THE HANDLE IS A BUTTON, NOT ONLY A DRAG TARGET
 * A drag is invisible, unannounced and unavailable to a keyboard. The handle is a real
 * button that cycles the detents, and the drag is an enhancement layered on top of it —
 * the same rule `panel-rail__restore` follows, because a gesture nobody was told about
 * is not an affordance.
 *
 * A PLAIN DIV, DELIBERATELY
 * This adds no landmark of its own. Its contents already carry their semantics — the
 * panel stack is an `<aside>`, the telemetry panel names itself — and wrapping them in
 * another named region would announce a container that, above the breakpoint, is an
 * invisible full-screen box that exists only to hold two absolutely positioned cards.
 *
 * ABOVE THE BREAKPOINT THIS IS INERT
 * CSS hides the handle and lays the wrapper out as a transparent, click-through box with
 * the same geometry as the shell, so the cards inside position exactly as they always
 * have. The drag listeners are never attached. One DOM, one accessibility tree.
 */

export type SheetDetent = "peek" | "half" | "full";

/** Low to high, which is also the order the handle button cycles through. */
const DETENT_ORDER: readonly SheetDetent[] = ["peek", "half", "full"];

/**
 * How far a drag must travel before it counts as one.
 *
 * Below this, a pointer-down-and-up is a tap on the handle button, which must keep
 * working: the button is the accessible path, and the drag must not swallow it.
 */
const DRAG_THRESHOLD_PX = 24;

export interface BottomSheetProps {
  readonly detent: SheetDetent;
  readonly onDetentChange: (detent: SheetDetent) => void;
  /** What the sheet is currently showing, so the handle can name what it expands. */
  readonly label: string;
  readonly children: React.ReactNode;
}

export function BottomSheet({ detent, onDetentChange, label, children }: BottomSheetProps) {
  const narrow = useMediaQuery(NARROW_VIEWPORT);
  const dragStartY = useRef<number | undefined>(undefined);
  /*
   * A completed drag suppresses the click that follows it.
   *
   * A drag that begins and ends inside the handle still dispatches a click, so a 30px
   * pull would settle the sheet one detent and then the button would cycle it another —
   * the sheet jumping two steps for one gesture. A short pull is the opposite case and
   * SHOULD fall through to the click, which is how an imprecise tap still works.
   */
  const draggedRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const cycle = useCallback(() => {
    const index = DETENT_ORDER.indexOf(detent);
    // Wraps: from full, the next press collapses. Three states need a way back, and a
    // button that does nothing at the end of its range reads as broken.
    onDetentChange(DETENT_ORDER[(index + 1) % DETENT_ORDER.length] ?? "peek");
  }, [detent, onDetentChange]);

  /*
   * Dragging is tracked on the window, not on the handle.
   *
   * A finger that starts on the handle and travels 200px is, by then, nowhere near the
   * handle. Listening on the element itself would lose the gesture the moment it left,
   * which reads as the sheet sticking halfway.
   */
  useEffect(() => {
    if (!narrow || !dragging) return;

    const settle = (clientY: number): void => {
      const start = dragStartY.current;
      dragStartY.current = undefined;
      setDragging(false);
      if (start === undefined) return;

      const travel = clientY - start;
      // Too small to be a drag. The click handler will treat it as the button press it
      // almost certainly was, so an imprecise tap still does something.
      if (Math.abs(travel) < DRAG_THRESHOLD_PX) return;
      draggedRef.current = true;

      // One step per drag, down to close and up to open. Snapping straight to full on a
      // long drag makes the gesture feel like it overshot.
      const index = DETENT_ORDER.indexOf(detent);
      const next =
        DETENT_ORDER[travel > 0 ? Math.max(0, index - 1) : Math.min(DETENT_ORDER.length - 1, index + 1)];
      if (next !== undefined && next !== detent) onDetentChange(next);
    };

    // Not passive: this is the one gesture that must stop the page rubber-banding behind
    // a sheet the user is deliberately dragging.
    const onPointerMove = (event: PointerEvent): void => {
      event.preventDefault();
    };
    const onPointerUp = (event: PointerEvent): void => {
      settle(event.clientY);
    };
    const onPointerCancel = (): void => {
      dragStartY.current = undefined;
      setDragging(false);
    };

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [narrow, dragging, detent, onDetentChange]);

  return (
    <div
      className={`bottom-sheet bottom-sheet--${detent}`}
      data-testid="bottom-sheet"
      data-detent={detent}
    >
      <button
        type="button"
        className="bottom-sheet__handle"
        onClick={() => {
          if (draggedRef.current) {
            draggedRef.current = false;
            return;
          }
          cycle();
        }}
        onPointerDown={(event) => {
          if (!narrow) return;
          draggedRef.current = false;
          dragStartY.current = event.clientY;
          setDragging(true);
        }}
        // States the outcome, not the gesture: "drag to resize" is useless to someone
        // who is about to press Enter, and the current size is not otherwise announced.
        aria-label={`${nextAction(detent)}. ${label}, currently ${detent}`}
        data-testid="bottom-sheet-handle"
      >
        <span className="bottom-sheet__grip" aria-hidden="true" />
      </button>

      <div className="bottom-sheet__body" data-testid="bottom-sheet-body">
        {children}
      </div>
    </div>
  );
}

/** What pressing the handle will do next, said as an action. */
function nextAction(detent: SheetDetent): string {
  switch (detent) {
    case "peek":
      return "Expand";
    case "half":
      return "Expand fully";
    case "full":
      return "Collapse";
  }
}
