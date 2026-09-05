import type { SatellitePass, VisibilityClassification } from "@orbitwatch/orbit-core";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALERT_PREFERENCES,
  alertId,
  isQuietHour,
  planAlerts,
  type AlertCandidate,
  type AlertPreferences,
  sanitiseAlertPreferences,
} from "./pass-alerts";

/**
 * Notification policy.
 *
 * The scheduling API is trivial and the policy is where every real bug lives, so the
 * policy is a pure function and this is where it is held to account. Each test below
 * corresponds to a way a pass alert can be actively harmful: waking someone at 3am,
 * firing for an invisible pass, firing after the event, or firing twice.
 */

const NOW = new Date("2026-09-02T08:00:00Z");

/**
 * A pass with the geometry the test cares about and nothing else invented.
 *
 * Only the fields the planner reads are populated; the rest would be noise. The
 * planner is deliberately narrow in what it touches, and this makes that visible.
 */
function passAt(
  aosIso: string,
  maxElevation: number,
  visibility: VisibilityClassification = "LIKELY_VISIBLE",
): SatellitePass {
  const aos = new Date(aosIso);
  const max = new Date(aos.getTime() + 3 * 60_000);
  const los = new Date(aos.getTime() + 6 * 60_000);
  return {
    aos: { time: aos, azimuth: 300, compass: "WNW", elevation: 10, range: 2000 },
    maximum: { time: max, azimuth: 45, compass: "NE", elevation: maxElevation, range: 500 },
    los: { time: los, azimuth: 120, compass: "ESE", elevation: 10, range: 2100 },
    durationSeconds: 360,
    minimumRange: 500,
    illumination: "SUNLIT",
    observerLighting: "DARK",
    visibility,
  } as SatellitePass;
}

function candidate(
  catalogId: string,
  name: string,
  aosIso: string,
  maxElevation: number,
  visibility: VisibilityClassification = "LIKELY_VISIBLE",
): AlertCandidate {
  return { catalogId, name, pass: passAt(aosIso, maxElevation, visibility) };
}

const ON: AlertPreferences = { ...DEFAULT_ALERT_PREFERENCES, enabled: true };

describe("isQuietHour", () => {
  it("covers a window that does not cross midnight", () => {
    const quiet = { startHour: 1, endHour: 6 };
    expect(isQuietHour(new Date(2026, 8, 2, 3), quiet)).toBe(true);
    expect(isQuietHour(new Date(2026, 8, 2, 6), quiet)).toBe(false);
    expect(isQuietHour(new Date(2026, 8, 2, 0), quiet)).toBe(false);
  });

  it("covers a window that crosses midnight", () => {
    // The case the naive comparison gets wrong for every hour it is meant to cover.
    const quiet = { startHour: 22, endHour: 7 };
    expect(isQuietHour(new Date(2026, 8, 2, 23), quiet)).toBe(true);
    expect(isQuietHour(new Date(2026, 8, 2, 3), quiet)).toBe(true);
    expect(isQuietHour(new Date(2026, 8, 2, 22), quiet)).toBe(true);
    expect(isQuietHour(new Date(2026, 8, 2, 7), quiet)).toBe(false);
    expect(isQuietHour(new Date(2026, 8, 2, 12), quiet)).toBe(false);
  });

  it("treats a zero-length window as silencing nothing", () => {
    const quiet = { startHour: 9, endHour: 9 };
    for (const hour of [0, 9, 15, 23]) {
      expect(isQuietHour(new Date(2026, 8, 2, hour), quiet)).toBe(false);
    }
  });
});

describe("planAlerts", () => {
  it("schedules nothing at all when alerts are off", () => {
    const plan = planAlerts(
      [candidate("25544", "ISS (ZARYA)", "2026-09-02T20:00:00Z", 70)],
      DEFAULT_ALERT_PREFERENCES,
      NOW,
    );
    expect(plan.scheduled).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("alerts-disabled");
  });

  it("is off by default", () => {
    // A tracker that starts notifying without being asked is a tracker people mute.
    expect(DEFAULT_ALERT_PREFERENCES.enabled).toBe(false);
  });

  it("fires at the lead time before acquisition, not at acquisition", () => {
    const plan = planAlerts(
      [candidate("25544", "ISS (ZARYA)", "2026-09-02T20:00:00Z", 70)],
      ON,
      NOW,
    );
    expect(plan.scheduled).toHaveLength(1);
    expect(plan.scheduled[0]?.fireAt.toISOString()).toBe("2026-09-02T19:50:00.000Z");
    expect(plan.scheduled[0]?.aos.toISOString()).toBe("2026-09-02T20:00:00.000Z");
  });

  it("refuses a pass whose lead time has already elapsed", () => {
    // Delivering "passes in 10 minutes" while it is overhead is wrong, not merely late.
    const plan = planAlerts(
      [candidate("25544", "ISS (ZARYA)", "2026-09-02T08:05:00Z", 70)],
      ON,
      NOW,
    );
    expect(plan.scheduled).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("in-the-past");
  });

  it("refuses a pass that is overhead but not visible", () => {
    // An 85-degree pass in Earth's shadow is invisible. Alerting on geometry alone is
    // how a tracker teaches people its notifications are worthless.
    const plan = planAlerts(
      [candidate("25544", "ISS (ZARYA)", "2026-09-02T20:00:00Z", 85, "SATELLITE_IN_SHADOW")],
      ON,
      NOW,
    );
    expect(plan.scheduled).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("not-visible");
  });

  it("refuses a pass that is too low to be worth going outside for", () => {
    const plan = planAlerts(
      [candidate("25544", "ISS (ZARYA)", "2026-09-02T20:00:00Z", 12)],
      ON,
      NOW,
    );
    expect(plan.skipped[0]?.reason).toBe("too-low");
  });

  it("does not schedule a pass the caller already holds", () => {
    // Re-planning happens on launch, on a location change and on new elements. Without
    // this, one pass becomes three notifications.
    const one = candidate("25544", "ISS (ZARYA)", "2026-09-02T20:00:00Z", 70);
    const held = new Set([alertId("25544", one.pass.aos.time)]);

    const plan = planAlerts([one], ON, NOW, held);
    expect(plan.scheduled).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("already-scheduled");
  });

  it("gives the same pass the same id every time it is planned", () => {
    const one = candidate("25544", "ISS (ZARYA)", "2026-09-02T20:00:00Z", 70);
    const first = planAlerts([one], ON, NOW);
    const second = planAlerts([one], ON, NOW);
    expect(first.scheduled[0]?.id).toBe(second.scheduled[0]?.id);
  });

  it("stays silent during quiet hours that cross midnight", () => {
    // Local hours: the pass is built to fire at 02:50 in whatever zone the test runs
    // in, so the assertion does not depend on the machine's timezone.
    const localAos = new Date(2026, 8, 3, 3, 0, 0);
    const plan = planAlerts(
      [{ catalogId: "25544", name: "ISS (ZARYA)", pass: passAt(localAos.toISOString(), 70) }],
      { ...ON, quietHours: { startHour: 22, endHour: 7 } },
      NOW,
    );
    expect(plan.scheduled).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("quiet-hours");
  });

  it("judges quiet hours at the moment the phone buzzes, not at the pass", () => {
    // A pass at 07:05 with a 10-minute lead fires at 06:55, which is still quiet.
    // Checking the pass time instead would wake the user five minutes early.
    const localAos = new Date(2026, 8, 3, 7, 5, 0);
    const plan = planAlerts(
      [{ catalogId: "25544", name: "ISS (ZARYA)", pass: passAt(localAos.toISOString(), 70) }],
      { ...ON, quietHours: { startHour: 22, endHour: 7 } },
      NOW,
    );
    expect(plan.skipped[0]?.reason).toBe("quiet-hours");
  });

  it("keeps the best passes when the nightly cap bites, not the earliest", () => {
    const plan = planAlerts(
      [
        candidate("1", "LOW EARLY", "2026-09-02T19:00:00Z", 35),
        candidate("2", "HIGH LATE", "2026-09-02T23:00:00Z", 88),
        candidate("3", "MID", "2026-09-02T21:00:00Z", 60),
        candidate("4", "ALSO LOW", "2026-09-02T20:00:00Z", 31),
      ],
      { ...ON, maxPerNight: 2 },
      NOW,
    );

    expect(plan.scheduled).toHaveLength(2);
    expect(plan.scheduled.map((alert) => alert.catalogId).sort()).toEqual(["2", "3"]);
    expect(plan.skipped.filter((one) => one.reason === "nightly-cap")).toHaveLength(2);
  });

  it("returns the schedule in time order, however it was ranked", () => {
    // Ranked by elevation to apply the cap; delivered in the order they happen,
    // because that is the order a person experiences them in.
    const plan = planAlerts(
      [
        candidate("1", "LATER BUT HIGHER", "2026-09-02T23:00:00Z", 88),
        candidate("2", "EARLIER", "2026-09-02T19:00:00Z", 45),
      ],
      ON,
      NOW,
    );
    expect(plan.scheduled.map((alert) => alert.catalogId)).toEqual(["2", "1"]);
  });

  it("says where to look, and never promises the sky is clear", () => {
    const plan = planAlerts(
      [candidate("25544", "ISS (ZARYA)", "2026-09-02T20:00:00Z", 70)],
      ON,
      NOW,
    );
    const alert = plan.scheduled[0];

    expect(alert?.title).toContain("ISS (ZARYA)");
    expect(alert?.title).toContain("10 min");
    expect(alert?.body).toContain("WNW");
    expect(alert?.body).toContain("70°");
    expect(alert?.body).toContain("NE");

    // The weather is not modelled and the text must not imply otherwise.
    expect(alert?.body).toContain("if the sky is clear");
    expect(alert?.body).not.toMatch(/you will see|guaranteed|definitely/i);
  });

  it("marks a marginal pass as marginal", () => {
    const plan = planAlerts(
      [candidate("25544", "ISS (ZARYA)", "2026-09-02T20:00:00Z", 70, "POSSIBLY_VISIBLE")],
      ON,
      NOW,
    );
    expect(plan.scheduled[0]?.body).toContain("Marginal");
  });

  it("accounts for every candidate, scheduled or not", () => {
    // A pass that vanished without a reason is the failure this makes impossible.
    const candidates = [
      candidate("1", "A", "2026-09-02T19:00:00Z", 35),
      candidate("2", "B", "2026-09-02T20:00:00Z", 12),
      candidate("3", "C", "2026-09-02T21:00:00Z", 88, "DAYLIGHT"),
      candidate("4", "D", "2026-09-02T08:01:00Z", 60),
    ];
    const plan = planAlerts(candidates, ON, NOW);
    expect(plan.scheduled.length + plan.skipped.length).toBe(candidates.length);
  });
});

describe("sanitiseAlertPreferences", () => {
  it("returns the defaults for anything unreadable", () => {
    for (const value of [undefined, null, "nonsense", 42, []]) {
      expect(sanitiseAlertPreferences(value)).toEqual(DEFAULT_ALERT_PREFERENCES);
    }
  });

  it("never turns alerts on for someone who did not turn them on", () => {
    /*
     * The asymmetry that matters. A corrupt or unrecognised stored value must fail
     * towards silence: waking somebody at 4am because a JSON blob could not be read is
     * not a bug they will report, it is one they will uninstall over.
     */
    expect(sanitiseAlertPreferences({ enabled: "yes" }).enabled).toBe(false);
    expect(sanitiseAlertPreferences({}).enabled).toBe(false);
    expect(sanitiseAlertPreferences({ enabled: true }).enabled).toBe(true);
  });

  it("clamps a nonsense elevation instead of falling back to the default", () => {
    /*
     * Clamping keeps the direction of the intent. A stored 500 becomes 90 — still
     * "only the very best passes" — where resetting to the 30 degree default would make
     * the app noisier than the user last asked for.
     *
     * The lower bound is 10 because predictPasses does not report a pass below it at
     * all, so a smaller number is not a looser filter: it is one that never matches,
     * which reads as alerts being broken.
     */
    expect(sanitiseAlertPreferences({ minimumElevation: 500 }).minimumElevation).toBe(90);
    expect(sanitiseAlertPreferences({ minimumElevation: 2 }).minimumElevation).toBe(10);
    expect(sanitiseAlertPreferences({ minimumElevation: -40 }).minimumElevation).toBe(10);
    expect(sanitiseAlertPreferences({ minimumElevation: 45 }).minimumElevation).toBe(45);
  });

  it("keeps the safe side of the visibility rule when the value is missing", () => {
    // Defaulting this to false would promise sightings of satellites in Earth's shadow.
    expect(sanitiseAlertPreferences({}).onlyVisiblePasses).toBe(true);
    expect(sanitiseAlertPreferences({ onlyVisiblePasses: "no" }).onlyVisiblePasses).toBe(true);
    expect(sanitiseAlertPreferences({ onlyVisiblePasses: false }).onlyVisiblePasses).toBe(false);
  });

  it("takes both ends of a quiet window or neither", () => {
    // Half a window is not a window, and guessing the other end invents a silence the
    // user never asked for.
    expect(sanitiseAlertPreferences({ quietHours: { startHour: 22 } }).quietHours).toBeUndefined();
    expect(sanitiseAlertPreferences({ quietHours: { startHour: 22, endHour: 7 } })).toMatchObject({
      quietHours: { startHour: 22, endHour: 7 },
    });
    // 24 is not an hour of the day.
    expect(
      sanitiseAlertPreferences({ quietHours: { startHour: 22, endHour: 24 } }).quietHours,
    ).toBeUndefined();
  });

  it("does not let one bad field discard the rest of the configuration", () => {
    // Each field falls back on its own, so an unreadable value costs that setting and
    // not a configuration the user spent time on.
    const preferences = sanitiseAlertPreferences({
      enabled: true,
      minimumElevation: "high",
      leadTimeMinutes: 25,
      maxPerNight: 5,
    });

    expect(preferences.enabled).toBe(true);
    expect(preferences.leadTimeMinutes).toBe(25);
    expect(preferences.maxPerNight).toBe(5);
    expect(preferences.minimumElevation).toBe(DEFAULT_ALERT_PREFERENCES.minimumElevation);
  });
});
