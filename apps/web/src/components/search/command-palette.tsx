"use client";

import { useEffect, useRef, useState } from "react";

import { fetchSatellites } from "../../lib/api-client";
import type { Satellite } from "@orbitwatch/contracts";

/**
 * Cmd/Ctrl+K catalog search.
 *
 * Deliberately no external command-palette library: the feature is "type, see a
 * filtered list, press enter" — a dependency earns its place by replacing more code
 * than this.
 */

export interface CommandPaletteProps {
  readonly onSelect: (catalogId: string) => void;
}

const DEBOUNCE_MS = 200;

export function CommandPalette({ onSelect }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly Satellite[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /**
   * Whatever had focus when the dialog opened.
   *
   * A dialog that closes without restoring focus drops it onto `<body>`, and the next
   * Tab restarts from the top of the page — the standard way a modal strands a
   * keyboard user in a place they did not ask to be.
   */
  const returnFocusRef = useRef<HTMLElement | null>(null);

  /** The stable trigger node, which is what focus returns to. */
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  /**
   * Whether the dialog has actually been open yet.
   *
   * Without this, the effect below runs its "closed" branch on first mount and focuses
   * the trigger — so the page loads with the search button already focused, as though
   * the user had tabbed to it. Restoring focus is only correct when there was focus to
   * restore.
   */
  const hasOpenedRef = useRef(false);

  /*
   * Resolved after mount, never during render.
   *
   * `navigator` does not exist while the page is prerendered on the server, and a
   * value that differs between the server and the first client render is a hydration
   * mismatch. Ctrl+K is the safe first paint; a Mac corrects itself immediately.
   */
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/.test(navigator.userAgent));
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isCommandK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (isCommandK) {
        event.preventDefault();
        setOpen((wasOpen) => !wasOpen);
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (open) {
      hasOpenedRef.current = true;
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // Focus after the dialog paints, not before.
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery("");
      setResults([]);
      setActiveIndex(0);
      // Only restore if the element is still in the document; a stale reference would
      // silently do nothing, which is the same failure this exists to prevent.
      if (!hasOpenedRef.current) return;
      // Prefer whatever opened the dialog; fall back to the trigger, which is always
      // mounted and is the right place to land however the dialog was opened.
      const captured = returnFocusRef.current;
      returnFocusRef.current = null;
      const target = captured !== null && captured.isConnected ? captured : triggerRef.current;
      target?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();

    const timeout = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetchSatellites(trimmed.length > 0 ? trimmed : undefined);
          setResults(response.satellites);
          setActiveIndex(0);
        } catch {
          setResults([]);
        }
      })();
    }, DEBOUNCE_MS);

    return () => clearTimeout(timeout);
  }, [query, open]);

  const choose = (satellite: Satellite): void => {
    onSelect(satellite.catalogId);
    setOpen(false);
  };

  /*
   * The trigger stays mounted while the dialog is open.
   *
   * It used to be `if (!open) return <button/>`, which unmounts it — so closing the
   * dialog built a BRAND NEW button, and any saved reference to the old one pointed at
   * a node no longer in the document. Focus restoration then silently did nothing and
   * the keyboard user was returned to the top of the page. Keeping one stable node is
   * what makes returning to it possible at all; it is hidden from assistive technology
   * while the modal is up, so the dialog is not competing with a control behind it.
   */
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="command-trigger"
        onClick={() => setOpen(true)}
        aria-label="Search satellites"
        aria-haspopup="dialog"
        aria-expanded={open}
        inert={open}
      >
        Search satellites{" "}
        <kbd>{isMac ? "⌘K" : "Ctrl+K"}</kbd>
      </button>

      {open ? renderDialog() : null}
    </>
  );

  function renderDialog() {
    return (
    <div className="command-palette-overlay" role="presentation" onClick={() => setOpen(false)}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search satellites"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          className="command-palette__input"
          placeholder="Search by name, catalog id, owner…"
          // Combobox wiring: without it the highlighted row is a visual state only,
          // and arrowing through results announces nothing.
          role="combobox"
          aria-expanded
          aria-controls="command-palette-results"
          aria-activedescendant={
            results[activeIndex] === undefined
              ? undefined
              : `command-palette-option-${results[activeIndex].catalogId}`
          }
          aria-autocomplete="list"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((index) => Math.min(index + 1, results.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              const chosen = results[activeIndex];
              if (chosen !== undefined) choose(chosen);
            }
          }}
        />
        <ul
          className="command-palette__results"
          role="listbox"
          id="command-palette-results"
          aria-label="Search results"
        >
          {results.map((satellite, index) => (
            <li
              key={satellite.catalogId}
              id={`command-palette-option-${satellite.catalogId}`}
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "command-palette__result command-palette__result--active" : "command-palette__result"}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(satellite)}
            >
              <span className="command-palette__result-name">{satellite.name}</span>
              <span className="command-palette__result-id">#{satellite.catalogId}</span>
            </li>
          ))}
          {results.length === 0 ? (
            <li className="command-palette__empty">No matching satellites</li>
          ) : null}
        </ul>
      </div>
    </div>
    );
  }
}
