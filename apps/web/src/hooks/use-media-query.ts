"use client";

import { useEffect, useState } from "react";

/**
 * Whether a CSS media query currently matches.
 *
 * CSS DECIDES WHERE THINGS GO; THIS DECIDES WHAT THEY DO
 * Every viewport renders the same components, and placement is media queries in
 * `globals.css`. This hook is for the things CSS genuinely cannot express: attaching
 * pointer listeners for the sheet drag, choosing a pick tolerance for Cesium, and
 * choosing which ONE of several already-open panels a single-column layout mounts.
 *
 * That last one does change the tree, so it is worth being exact about the line. What
 * this hook must never decide is whether a feature exists — only which of the things the
 * user has already asked for is in front. A panel the viewport hides is one the user can
 * still reach with a tap; a panel a media query deleted is one they cannot.
 *
 * FALSE ON THE SERVER, AND ON THE FIRST CLIENT RENDER
 * This page is statically prerendered. There is no viewport during prerender, so any
 * value other than `false` would be a guess, and a first client render that disagreed
 * with the server's HTML is a hydration mismatch. The real value is applied in an effect
 * immediately after mount — the same trade `usePanels` and the timeline clock already
 * make, for the same reason.
 *
 * Consequence: a component must be correct while this is `false`. That is why it gates
 * only enhancements. A sheet whose drag listeners attach one frame late is fine; a sheet
 * that does not exist until one frame late is not.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    // Guarded because `matchMedia` is absent in some test and SSR-adjacent environments,
    // and an absent API should mean "no match" rather than a crash on first paint.
    if (typeof window.matchMedia !== "function") return;

    const list = window.matchMedia(query);
    setMatches(list.matches);

    const onChange = (event: MediaQueryListEvent): void => {
      setMatches(event.matches);
    };
    list.addEventListener("change", onChange);
    return () => {
      list.removeEventListener("change", onChange);
    };
  }, [query]);

  return matches;
}

/**
 * The layout breakpoint, in one place so the CSS and the JS cannot drift apart.
 *
 * Width, not `pointer: coarse`: the constraint being solved is horizontal space, so a
 * narrow desktop window should get the same layout — and it is what lets Playwright
 * exercise the mobile shell by emulating a viewport.
 */
export const NARROW_VIEWPORT = "(max-width: 44rem)";

/**
 * Touch-class input, which is a different question from screen width.
 *
 * A 3-pixel satellite is unhittable with a fingertip on any size of screen, and a
 * 44-pixel target is wasted on a mouse. This is the query for target sizes and hit
 * tolerances; `NARROW_VIEWPORT` is the query for where things go.
 */
export const COARSE_POINTER = "(pointer: coarse)";
