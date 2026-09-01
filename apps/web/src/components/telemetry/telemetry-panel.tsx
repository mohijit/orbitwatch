"use client";

import { describeOrbitClass } from "@orbitwatch/orbit-core";

import type { SelectedTelemetryState } from "../../hooks/use-selected-satellite";

/**
 * The selected satellite's telemetry panel.
 *
 * Surfaces the distinction the whole product is built around: POSITION TIME, ELEMENT
 * EPOCH and RETRIEVAL TIME are three different facts, routinely conflated by other
 * trackers. Showing all three, plus the accuracy classification, is what makes a
 * displayed position an honest claim rather than an implied one.
 *
 * IDENTITY, NOT JUST A NUMBER
 * The header carries the object's name, its NORAD catalog number and its international
 * designator. The number alone is what this panel used to show, which is precise and
 * unhelpful: "#67714" identifies the object exactly and tells a person nothing, when
 * the name — STARLINK-36702 — was already sitting in the element set being displayed.
 * All three stay visible because they answer different questions: the name is what you
 * recognise, the catalog number is what you search other catalogues with, and the
 * designator says which launch it came from.
 */

export interface TelemetryPanelProps {
  readonly catalogId: string | undefined;
  readonly telemetry: SelectedTelemetryState;
  readonly onClose: () => void;
  /**
   * Observer-relative sections: look angles and upcoming passes.
   *
   * Passed in rather than computed here, because they depend on a location this
   * component has no business knowing about, and because they are only meaningful
   * once an object is selected — which is exactly when this panel exists.
   */
  readonly children?: React.ReactNode;
}

const CONFIDENCE_LABEL: Record<string, string> = {
  NOMINAL: "LIVE · PROPAGATED",
  DEGRADED: "PROPAGATED · AGING",
  EXTRAPOLATED: "EXTRAPOLATED",
  UNRELIABLE: "UNRELIABLE",
};

export function TelemetryPanel({ catalogId, telemetry, onClose, children }: TelemetryPanelProps) {
  if (catalogId === undefined) return null;

  return (
    <aside className="telemetry-panel" data-testid="telemetry-panel" aria-label="Satellite telemetry">
      <div className="telemetry-panel__header">
        <div className="telemetry-panel__identity">
          {/*
            The name leads, because that is what a person recognises. It appears only
            once the element set has arrived, since that record is where it comes from —
            there is nothing to show before then, and a placeholder that later turns
            into a different name reads as a correction rather than a load.
          */}
          {telemetry.status === "ready" ? (
            <h2 className="telemetry-panel__name" data-testid="satellite-name">
              {telemetry.name}
            </h2>
          ) : null}
          <p className="telemetry-panel__designators">
            <span
              className="telemetry-panel__catalog-id"
              data-testid="catalog-id"
              title="NORAD catalog number: the permanent identifier assigned when the object was catalogued"
            >
              #{catalogId}
            </span>
            {telemetry.status === "ready" && telemetry.internationalDesignator !== undefined ? (
              <span
                className="telemetry-panel__intl-id"
                data-testid="international-designator"
                title="International designator (COSPAR ID): launch year, launch of that year, and piece"
              >
                {telemetry.internationalDesignator}
              </span>
            ) : null}
          </p>
        </div>
        <button type="button" className="telemetry-panel__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {telemetry.status === "loading" ? <p className="telemetry-panel__status">Loading…</p> : null}

      {telemetry.status === "failed" ? (
        <p className="telemetry-panel__status telemetry-panel__status--error">
          {telemetry.message}
        </p>
      ) : null}

      {telemetry.status === "ready" ? (
        <div className="telemetry-panel__body" data-testid="telemetry-body">
          <div
            className={`telemetry-panel__badge telemetry-panel__badge--${telemetry.accuracy.confidence.toLowerCase()}`}
            data-testid="accuracy-badge"
          >
            {CONFIDENCE_LABEL[telemetry.accuracy.confidence] ?? telemetry.accuracy.confidence}
          </div>

          {!telemetry.accuracy.renderable ? (
            <p className="telemetry-panel__warning" role="alert">
              Position not shown: propagation is beyond a defensible limit for this
              element set.
            </p>
          ) : telemetry.accuracy.warning !== undefined ? (
            <p className="telemetry-panel__warning">{telemetry.accuracy.warning}</p>
          ) : null}

          <dl className="telemetry-panel__facts">
            <dt>Element epoch</dt>
            <dd data-testid="element-epoch">{telemetry.accuracy.label}</dd>
            <dt>Orbit</dt>
            <dd data-testid="orbit-class" title={describeOrbitClass(telemetry.orbitClass)}>
              {telemetry.orbitClass}
            </dd>
          </dl>

          <section className="telemetry-panel__observer" aria-label="From your location">
            <h2 className="telemetry-panel__section-heading">From your location</h2>
            {children}
          </section>
        </div>
      ) : null}
    </aside>
  );
}
