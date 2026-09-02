import type { SatellitePass } from "@orbitwatch/orbit-core";

/**
 * Which passes are worth interrupting someone for.
 *
 * This is policy, not orbital mechanics, which is why it lives here and not in
 * `@orbitwatch/orbit-core`. It is also the part of a notification feature that actually
 * goes wrong: the scheduling API is a few lines, and every real bug is in deciding what
 * to schedule. So the decision is a pure function of its inputs — passes in, plan out —
 * with no clock of its own, no storage and no platform calls, and every rejection
 * carries the reason it was rejected.
 *
 * A NOTIFICATION IS A PROMISE
 * "Look up in ten minutes" is a claim that something will be visible. Getting it wrong
 * sends someone outside into the cold for nothing, and two of those in a row is an
 * uninstall. That is why the defaults are conservative, why a pass that is merely
 * geometrically good is not enough, and why nothing is scheduled that the caller has
 * already scheduled.
 */

export interface QuietHours {
  /** Local hour when quiet time begins, 0-23. */
  readonly startHour: number;
  /** Local hour when quiet time ends, 0-23. May be less than `startHour`. */
  readonly endHour: number;
}

export interface AlertPreferences {
  readonly enabled: boolean;
  /**
   * Minimum peak elevation to bother alerting about.
   *
   * Higher than the 10° that counts as a pass at all. A pass peaking at 12° is real,
   * and is also behind whatever building or tree is in that direction; alerting on it
   * spends the user's attention on something they will probably not see.
   */
  readonly minimumElevation: number;
  /** How long before acquisition to fire, in minutes. */
  readonly leadTimeMinutes: number;
  /**
   * Require the pass to be optically favourable, not merely overhead.
   *
   * On by default. A satellite in Earth's shadow passes directly overhead and is
   * invisible; alerting on it is the single most common way a tracker teaches its users
   * that its notifications are worthless.
   */
  readonly onlyVisiblePasses: boolean;
  readonly quietHours?: QuietHours;
  /**
   * Cap on alerts per rolling night.
   *
   * Notification fatigue is the failure mode of this feature. When the cap bites, the
   * HIGHEST passes survive rather than the earliest — the cap exists to protect
   * attention, so it should spend it on the best passes available, not on whichever
   * happened to come first.
   */
  readonly maxPerNight: number;
}

export const DEFAULT_ALERT_PREFERENCES: AlertPreferences = {
  enabled: false,
  minimumElevation: 30,
  leadTimeMinutes: 10,
  onlyVisiblePasses: true,
  maxPerNight: 3,
};

export interface AlertCandidate {
  readonly catalogId: string;
  readonly name: string;
  readonly pass: SatellitePass;
}

export interface ScheduledAlert {
  /**
   * Stable identity of this alert.
   *
   * Derived from the object and its acquisition time, so the same pass produces the
   * same id on every planning run. That is what makes re-planning idempotent: an app
   * that re-plans on launch, on a location change and on new elements would otherwise
   * schedule the same notification several times over.
   */
  readonly id: string;
  readonly catalogId: string;
  readonly name: string;
  readonly fireAt: Date;
  readonly aos: Date;
  readonly maxElevation: number;
  readonly compass: string;
  readonly title: string;
  readonly body: string;
}

export type SkipReason =
  | "alerts-disabled"
  | "already-scheduled"
  | "too-low"
  | "not-visible"
  | "in-the-past"
  | "quiet-hours"
  | "nightly-cap";

export interface SkippedAlert {
  readonly catalogId: string;
  readonly aos: Date;
  readonly reason: SkipReason;
}

export interface AlertPlan {
  readonly scheduled: readonly ScheduledAlert[];
  readonly skipped: readonly SkippedAlert[];
}

export function alertId(catalogId: string, aos: Date): string {
  return `pass:${catalogId}:${aos.toISOString()}`;
}

/**
 * Is this instant inside the user's quiet hours, in their local time?
 *
 * The wrap-around case is the whole reason this is a named function with its own tests.
 * Quiet hours are usually something like 22:00 to 07:00, which is not an interval on
 * the number line — the naive `hour >= start && hour < end` is false for every hour of
 * the night it is meant to cover.
 */
export function isQuietHour(at: Date, quiet: QuietHours): boolean {
  const hour = at.getHours();
  if (quiet.startHour === quiet.endHour) return false; // a zero-length window silences nothing
  return quiet.startHour < quiet.endHour
    ? hour >= quiet.startHour && hour < quiet.endHour
    : hour >= quiet.startHour || hour < quiet.endHour;
}

function isOpticallyFavourable(pass: SatellitePass): boolean {
  return pass.visibility === "LIKELY_VISIBLE" || pass.visibility === "POSSIBLY_VISIBLE";
}

function describe(candidate: AlertCandidate, leadMinutes: number): { title: string; body: string } {
  const { pass, name } = candidate;
  const elevation = Math.round(pass.maximum.elevation);

  return {
    title: `${name} passes in ${String(leadMinutes)} min`,
    // States where to look and how good it is, and never promises it will be seen —
    // cloud is not modelled and cannot be. "Look" rather than "you will see".
    body:
      `Rises ${pass.aos.compass}, peaks ${String(elevation)}° ${pass.maximum.compass}, ` +
      `sets ${pass.los.compass}. ` +
      (pass.visibility === "LIKELY_VISIBLE"
        ? "Good conditions if the sky is clear."
        : "Marginal — low or entering shadow."),
  };
}

/**
 * Decide which candidate passes become notifications.
 *
 * `now` is a parameter rather than read from the clock so the decision is testable and
 * so a caller can plan for a window that is not the present. `alreadyScheduled` is the
 * set of ids the platform is already holding, which the caller owns because only it
 * knows what survived a reboot.
 */
export function planAlerts(
  candidates: readonly AlertCandidate[],
  preferences: AlertPreferences,
  now: Date,
  alreadyScheduled: ReadonlySet<string> = new Set(),
): AlertPlan {
  const scheduled: ScheduledAlert[] = [];
  const skipped: SkippedAlert[] = [];

  if (!preferences.enabled) {
    return {
      scheduled: [],
      skipped: candidates.map((candidate) => ({
        catalogId: candidate.catalogId,
        aos: candidate.pass.aos.time,
        reason: "alerts-disabled" as const,
      })),
    };
  }

  const leadMs = preferences.leadTimeMinutes * 60_000;

  // Sorted by elevation so the nightly cap keeps the best passes rather than the
  // earliest. The returned schedule is re-sorted into time order afterwards, because
  // that is the order a person experiences it in.
  const byQuality = [...candidates].sort(
    (a, b) => b.pass.maximum.elevation - a.pass.maximum.elevation,
  );

  for (const candidate of byQuality) {
    const aos = candidate.pass.aos.time;
    const id = alertId(candidate.catalogId, aos);
    const reject = (reason: SkipReason): void => {
      skipped.push({ catalogId: candidate.catalogId, aos, reason });
    };

    if (alreadyScheduled.has(id)) {
      reject("already-scheduled");
      continue;
    }
    if (candidate.pass.maximum.elevation < preferences.minimumElevation) {
      reject("too-low");
      continue;
    }
    if (preferences.onlyVisiblePasses && !isOpticallyFavourable(candidate.pass)) {
      reject("not-visible");
      continue;
    }

    const fireAt = new Date(aos.getTime() - leadMs);

    // A notification whose lead time has already elapsed must not fire immediately:
    // "passes in 10 min" delivered as the object crosses overhead is worse than
    // silence, because it is wrong rather than merely late.
    if (fireAt.getTime() <= now.getTime()) {
      reject("in-the-past");
      continue;
    }

    // Quiet hours are evaluated at the moment the phone would make a sound, not at the
    // pass itself. Those differ by the lead time, and it is the buzz that wakes people.
    if (preferences.quietHours !== undefined && isQuietHour(fireAt, preferences.quietHours)) {
      reject("quiet-hours");
      continue;
    }

    if (scheduled.length >= preferences.maxPerNight) {
      reject("nightly-cap");
      continue;
    }

    const { title, body } = describe(candidate, preferences.leadTimeMinutes);
    scheduled.push({
      id,
      catalogId: candidate.catalogId,
      name: candidate.name,
      fireAt,
      aos,
      maxElevation: candidate.pass.maximum.elevation,
      compass: candidate.pass.maximum.compass,
      title,
      body,
    });
  }

  return {
    scheduled: scheduled.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime()),
    skipped,
  };
}
