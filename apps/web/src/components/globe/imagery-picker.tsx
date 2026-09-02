"use client";

import { GIBS_LAYERS, findGibsLayer, imageryDateFor } from "./imagery";

/**
 * Choose the globe's imagery, and say what choosing it means.
 *
 * MOVED OUT OF THE GLOBE ON PURPOSE
 * This used to be absolutely positioned inside the globe component, where it sat
 * underneath the context panels and could not be clicked at all — a bug the E2E caught
 * by timing out on an element that was visible, enabled, stable and covered. It now
 * lives in the panel stack with everything else, and the globe takes the selected layer
 * as a prop rather than owning it. That also matches how the rest of this app works:
 * state lives in the page and flows one way down.
 *
 * THE CAVEAT IS PART OF THE CONTROL
 * GIBS imagery is a daily composite; the satellites over it are where they are right
 * now. The date is shown next to the choice, not buried in a tooltip, because the
 * moment someone turns this on is the moment they need to know it is not live.
 */

export interface ImageryPickerProps {
  readonly selected: string | undefined;
  readonly onSelect: (id: string | undefined) => void;
}

export function ImageryPicker({ selected, onSelect }: ImageryPickerProps) {
  return (
    <section className="imagery-picker" data-testid="imagery-picker">
      <h2 className="telemetry-panel__section-heading">Imagery</h2>

      <fieldset className="imagery-picker__group">
        <legend className="shell__visually-hidden">Globe imagery</legend>

        {[{ id: "none", label: "Base map" }, ...GIBS_LAYERS].map((option) => {
          const isNone = option.id === "none";
          const isSelected = isNone ? selected === undefined : selected === option.id;
          const layer = isNone ? undefined : findGibsLayer(option.id);

          return (
            <label key={option.id} className="imagery-picker__option">
              <input
                type="radio"
                name="imagery"
                value={option.id}
                checked={isSelected}
                onChange={() => {
                  onSelect(isNone ? undefined : option.id);
                }}
              />
              <span className="imagery-picker__label">{option.label}</span>
              <span className="imagery-picker__description">
                {layer?.description ??
                  "Bundled Natural Earth. Undated, and works without a network."}
              </span>
            </label>
          );
        })}
      </fieldset>

      {selected === undefined ? null : (
        <p className="imagery-picker__date" data-testid="imagery-date">
          Imagery from {imageryDateFor(new Date())} · satellite positions are live
        </p>
      )}
    </section>
  );
}
