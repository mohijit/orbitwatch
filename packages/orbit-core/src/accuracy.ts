import type { OrbitClass } from "./types.js";

/**
 * Propagation confidence and extrapolation limits.
 *
 * WHY THIS EXISTS
 * SGP4 will happily return a position for any time you ask for. It will not tell you
 * that the answer is meaningless. Propagating a single element set a year forward
 * produces a confident-looking latitude and longitude that can be thousands of
 * kilometres wrong — and, for deep-space objects, takes ~3x longer to compute while
 * being far less trustworthy (see docs/adr/0002-propagation-strategy.md).
 *
 * A general-perturbations element set describes the orbit AT ITS EPOCH. Accuracy
 * decays away from that epoch in both directions, dominated by atmospheric drag in
 * LEO and by unmodelled manoeuvres everywhere. There is no single correct cutoff, so
 * this module states its bands explicitly and the UI surfaces them rather than
 * silently presenting extrapolation as fact.
 *
 * HISTORICAL REPLAY
 * Replaying the past must use the element set that was current AT THAT TIME, drawn
 * from stored history — not today's elements propagated backwards. Backwards
 * propagation across a manoeuvre is simply wrong, and no accuracy band can rescue it.
 * `selectBestElements` implements that choice; the ingestion history in M2 is what
 * makes it possible.
 */

/** How far the requested time is from the element epoch, and what that implies. */
export type PropagationConfidence =
  /** Within the element set's design window. Positions are as good as SGP4 gets. */
  | "NOMINAL"
  /** Usable, but error is growing noticeably. Worth a quiet indicator. */
  | "DEGRADED"
  /** Far enough out that the position is indicative only. Needs a visible warning. */
  | "EXTRAPOLATED"
  /** Beyond any defensible limit. The UI should refuse rather than mislead. */
  | "UNRELIABLE";

export interface AccuracyAssessment {
  readonly confidence: PropagationConfidence;
  /** Signed hours from epoch to the requested time. Negative means before epoch. */
  readonly hoursFromEpoch: number;
  /** True when propagating backwards, which risks crossing an unmodelled manoeuvre. */
  readonly backwards: boolean;
  /** Short label for a badge, e.g. "EXTRAPOLATED · 6d". */
  readonly label: string;
  /** One sentence explaining the limitation, or undefined when nominal. */
  readonly warning: string | undefined;
  /** Whether the UI should still render a position at all. */
  readonly renderable: boolean;
}

/**
 * Confidence bands, in hours from epoch.
 *
 * LEO decays fastest because atmospheric drag dominates and is the least predictable
 * term in the model; a LEO element set more than a few days old can be tens of
 * kilometres out along-track. Higher orbits experience negligible drag, so their
 * elements stay usable far longer — but manoeuvres remain unmodelled at any altitude,
 * which is why even GEO has a limit.
 *
 * These are deliberately conservative. Being told "extrapolated" slightly too early
 * costs a user nothing; being shown a confident wrong position costs them trust.
 */
interface ConfidenceBands {
  readonly nominalHours: number;
  readonly degradedHours: number;
  readonly extrapolatedHours: number;
}

const BANDS_BY_ORBIT: Readonly<Record<OrbitClass, ConfidenceBands>> = {
  // Drag-dominated. CelesTrak republishes roughly every 2 hours for a reason.
  LEO: { nominalHours: 24, degradedHours: 72, extrapolatedHours: 24 * 14 },
  // Above the atmosphere; the limiting factor is manoeuvres, not drag.
  MEO: { nominalHours: 72, degradedHours: 24 * 14, extrapolatedHours: 24 * 60 },
  GEO: { nominalHours: 72, degradedHours: 24 * 14, extrapolatedHours: 24 * 60 },
  GSO: { nominalHours: 72, degradedHours: 24 * 14, extrapolatedHours: 24 * 60 },
  // Spends most of its time high but dips through the upper atmosphere at perigee.
  HEO: { nominalHours: 48, degradedHours: 24 * 7, extrapolatedHours: 24 * 30 },
  HIGH: { nominalHours: 72, degradedHours: 24 * 14, extrapolatedHours: 24 * 60 },
  // Unknown regime: use the most conservative bands.
  UNKNOWN: { nominalHours: 24, degradedHours: 72, extrapolatedHours: 24 * 14 },
};

/**
 * Backward propagation is held to a tighter limit than forward.
 *
 * Going backwards from current elements crosses any manoeuvre that happened in
 * between, and the resulting position is not merely imprecise but describes an orbit
 * the spacecraft was never in. Historical replay should use stored historical
 * elements instead; this factor makes the fallback visibly worse so the correct path
 * is the attractive one.
 */
const BACKWARD_TOLERANCE_FACTOR = 0.5;

const HOUR_MS = 3_600_000;

/** Assess how much to trust a propagation of `epoch` to `targetTime`. */
export function assessAccuracy(
  epoch: Date,
  targetTime: Date,
  orbitClass: OrbitClass = "UNKNOWN",
): AccuracyAssessment {
  const hoursFromEpoch = (targetTime.getTime() - epoch.getTime()) / HOUR_MS;
  const backwards = hoursFromEpoch < 0;
  const magnitude = Math.abs(hoursFromEpoch);

  const bands = BANDS_BY_ORBIT[orbitClass];
  const scale = backwards ? BACKWARD_TOLERANCE_FACTOR : 1;

  const nominal = bands.nominalHours * scale;
  const degraded = bands.degradedHours * scale;
  const extrapolated = bands.extrapolatedHours * scale;

  let confidence: PropagationConfidence;
  if (magnitude <= nominal) confidence = "NOMINAL";
  else if (magnitude <= degraded) confidence = "DEGRADED";
  else if (magnitude <= extrapolated) confidence = "EXTRAPOLATED";
  else confidence = "UNRELIABLE";

  return {
    confidence,
    hoursFromEpoch,
    backwards,
    label: buildLabel(confidence, magnitude),
    warning: buildWarning(confidence, backwards, orbitClass),
    // An unreliable position is worse than none: it looks authoritative and is not.
    renderable: confidence !== "UNRELIABLE",
  };
}

function buildLabel(confidence: PropagationConfidence, magnitudeHours: number): string {
  return `${confidence} · ${formatDuration(magnitudeHours)}`;
}

/** Compact age formatting for telemetry badges. */
export function formatDuration(hours: number): string {
  const minutes = Math.round(hours * 60);
  if (minutes < 60) return `${minutes}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 365) return `${Math.round(days)}d`;
  return `${(days / 365).toFixed(1)}y`;
}

function buildWarning(
  confidence: PropagationConfidence,
  backwards: boolean,
  orbitClass: OrbitClass,
): string | undefined {
  if (confidence === "NOMINAL") return undefined;

  const direction = backwards ? "before" : "after";
  const historyHint = backwards
    ? " Historical replay should use element sets published at that time, not current elements propagated backwards."
    : "";

  switch (confidence) {
    case "DEGRADED":
      return (
        `This position is propagated well ${direction} the element epoch, so accuracy ` +
        `is reduced.${historyHint}`
      );
    case "EXTRAPOLATED":
      return (
        `This is an EXTRAPOLATION far ${direction} the element epoch. The position is ` +
        `indicative only and may be wrong by hundreds of kilometres` +
        `${orbitClass === "LEO" ? ", as atmospheric drag dominates in low Earth orbit" : ""}` +
        `. Unmodelled manoeuvres are not accounted for.${historyHint}`
      );
    case "UNRELIABLE":
      return (
        `The requested time is too far ${direction} the element epoch for SGP4 to give ` +
        `a meaningful answer. No position is shown.${historyHint}`
      );
  }
}

// --- Historical element selection -------------------------------------------

/** Minimal shape needed to choose between stored element sets. */
export interface DatedElementSet {
  readonly epoch: Date;
}

export interface ElementSelection<T extends DatedElementSet> {
  readonly elements: T;
  readonly assessment: AccuracyAssessment;
  /**
   * True when a set published BEFORE the requested time was available, which is the
   * correct basis for historical replay. False means we had to fall back to a later
   * set and propagate backwards.
   */
  readonly precedesTarget: boolean;
}

/**
 * Choose the stored element set that best describes `targetTime`.
 *
 * Prefers the most recent set whose epoch PRECEDES the requested time. That is what
 * an observer at that moment would have used, and it avoids propagating backwards
 * across manoeuvres.
 *
 * Falls back to the earliest available set only when the requested time predates all
 * stored history — the result is flagged so the UI can say it is reconstructing
 * rather than replaying.
 */
export function selectBestElements<T extends DatedElementSet>(
  available: readonly T[],
  targetTime: Date,
  orbitClass: OrbitClass = "UNKNOWN",
): ElementSelection<T> | undefined {
  if (available.length === 0) return undefined;

  const sorted = [...available].sort((a, b) => a.epoch.getTime() - b.epoch.getTime());
  const target = targetTime.getTime();

  let chosen: T | undefined;
  for (const candidate of sorted) {
    if (candidate.epoch.getTime() <= target) chosen = candidate;
    else break;
  }

  const precedesTarget = chosen !== undefined;
  // Nothing precedes the target: use the earliest set we have and propagate backwards,
  // which the assessment will mark down accordingly.
  chosen ??= sorted[0] as T;

  return {
    elements: chosen,
    assessment: assessAccuracy(chosen.epoch, targetTime, orbitClass),
    precedesTarget,
  };
}

/**
 * Whether a requested time is far enough from now to count as time travel.
 *
 * Used to switch the UI out of its LIVE state. Deliberately generous: clock skew and
 * animation lag should never flip a genuinely live view into "simulation".
 */
export function isEffectivelyLive(targetTime: Date, now: Date = new Date()): boolean {
  const LIVE_TOLERANCE_MS = 5_000;
  return Math.abs(targetTime.getTime() - now.getTime()) <= LIVE_TOLERANCE_MS;
}
