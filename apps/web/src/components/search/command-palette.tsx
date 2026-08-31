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
      // Focus after the dialog paints, not before.
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery("");
      setResults([]);
      setActiveIndex(0);
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

  if (!open) {
    return (
      <button
        type="button"
        className="command-trigger"
        onClick={() => setOpen(true)}
        aria-label="Search satellites"
      >
        Search satellites{" "}
        <kbd>{typeof navigator !== "undefined" && navigator.platform.includes("Mac") ? "⌘K" : "Ctrl+K"}</kbd>
      </button>
    );
  }

  const choose = (satellite: Satellite): void => {
    onSelect(satellite.catalogId);
    setOpen(false);
  };

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
        <ul className="command-palette__results" role="listbox">
          {results.map((satellite, index) => (
            <li
              key={satellite.catalogId}
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
