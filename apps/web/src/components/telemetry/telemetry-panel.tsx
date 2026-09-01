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
 */

export interface TelemetryPanelProps {
  readonly catalogId: string | undefined;
  readonly telemetry: SelectedTelemetryState;
  readonly onClose: () => void;
}

const CONFIDENCE_LABEL: Record<string, string> = {
  NOMINAL: "LIVE · PROPAGATED",
  DEGRADED: "PROPAGATED · AGING",
  EXTRAPOLATED: "EXTRAPOLATED",
  UNRELIABLE: "UNRELIABLE",
};

export function TelemetryPanel({ catalogId, telemetry, onClose }: TelemetryPanelProps) {
  if (catalogId === undefined) return null;

  return (
    <aside className="telemetry-panel" data-testid="telemetry-panel" aria-label="Satellite telemetry">
      <div className="telemetry-panel__header">
        <span className="telemetry-panel__catalog-id">#{catalogId}</span>
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
        </div>
      ) : null}
    </aside>
  );
}
