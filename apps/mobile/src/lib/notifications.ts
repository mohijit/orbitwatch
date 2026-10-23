import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { alertId, planAlerts, type AlertCandidate, type AlertPreferences } from "./pass-alerts";

/**
 * The thin layer between the alert rules and the operating system.
 *
 * Everything that decides WHAT to schedule is in `pass-alerts`, pure and tested. This
 * file exists to make the platform calls and nothing else, because platform calls are
 * the part that cannot be tested without a device — so there is as little of it as
 * possible, and no judgement in it.
 *
 * IDEMPOTENT, BECAUSE IT RUNS OFTEN
 * A sync happens on launch, when the observing location changes, when new elements
 * arrive and when preferences change. Without reconciling against what is already
 * scheduled, a user who opened the app four times would get four notifications for the
 * same pass. `alertId` derives a stable identity from the object and its acquisition
 * time, which is what makes that reconciliation possible at all.
 *
 * CANCELLING IS AS IMPORTANT AS SCHEDULING
 * Elements are republished every couple of hours and a predicted pass moves. A
 * notification scheduled from yesterday's elements, for a pass that has since shifted
 * by two minutes or stopped being visible, is a promise this app can no longer keep, so
 * anything not in the current plan is withdrawn.
 */

/**
 * The channel Android delivers pass alerts on.
 *
 * Android has required one since API 26, and expo-notifications will invent a fallback
 * rather than fail. That fallback appears in the system settings under a generic name,
 * so a user who wants to silence pass alerts without silencing the app has nothing to
 * aim at. A named channel is the difference between a setting they can find and one
 * they cannot.
 */
const ANDROID_CHANNEL_ID = "pass-alerts";

/**
 * Show the notification even when the app is in the foreground.
 *
 * WITHOUT THIS, NOTHING IS DISPLAYED WHILE THE APP IS OPEN — on either platform, and
 * silently. The notification still fires and still appears in the tray afterwards,
 * which makes the failure look like a scheduling bug rather than a missing handler.
 *
 * Foreground delivery matters for this feature specifically. A pass alert fires minutes
 * before an object rises, which is exactly when someone is likely to be holding the
 * phone with the app open, waiting for it.
 */
Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      // iOS only, and there is no count this app maintains to put on an icon.
      shouldSetBadge: false,
    }),
});

/** Create the channel if it does not exist. Idempotent, and a no-op off Android. */
async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name: "Pass alerts",
    description: "Fires shortly before a tracked satellite rises above your horizon.",
    // HIGH so it arrives as a heads-up banner. A pass alert that waits quietly in the
    // tray has missed the pass it was scheduled for.
    importance: Notifications.AndroidImportance.HIGH,
  });
}

/** Notifications this app scheduled, keyed by the alert id they were scheduled under. */
async function scheduledByAlertId(): Promise<Map<string, string>> {
  const existing = await Notifications.getAllScheduledNotificationsAsync();
  const byAlertId = new Map<string, string>();

  for (const request of existing) {
    const id = request.content.data?.["alertId"];
    // Only ours, and only ones we can identify. A notification without our marker
    // belongs to something else and must not be cancelled from here.
    if (typeof id === "string") byAlertId.set(id, request.identifier);
  }

  return byAlertId;
}

export interface SyncResult {
  readonly scheduled: number;
  readonly cancelled: number;
  readonly kept: number;
}

/**
 * Ask for permission, but only when there is a reason to.
 *
 * Prompting on launch, before the user has expressed any interest in being notified, is
 * how an app gets a permanent "no". This is called when alerts are switched on.
 */
export async function requestAlertPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;

  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

/**
 * Make the scheduled notifications match the plan.
 *
 * @param candidates passes worth considering, already narrowed to what the user tracks
 */
export async function syncAlerts(
  candidates: readonly AlertCandidate[],
  preferences: AlertPreferences,
  now: Date,
): Promise<SyncResult> {
  const existing = await scheduledByAlertId();

  /*
   * Planned WITHOUT the already-scheduled set.
   *
   * The plan has to describe everything that should be scheduled, not just what is
   * missing, or there would be no way to tell an alert that is deliberately absent from
   * one that is merely already there — and the cancel pass below would withdraw every
   * notification it had just decided to keep.
   */
  const plan = planAlerts(candidates, preferences, now);
  const wanted = new Set(plan.scheduled.map((alert) => alert.id));

  let cancelled = 0;
  for (const [id, identifier] of existing) {
    if (wanted.has(id)) continue;
    await Notifications.cancelScheduledNotificationAsync(identifier);
    cancelled += 1;
  }

  let scheduled = 0;
  let kept = 0;
  if (plan.scheduled.length > 0) await ensureAndroidChannel();
  for (const alert of plan.scheduled) {
    if (existing.has(alert.id)) {
      kept += 1;
      continue;
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title: alert.title,
        body: alert.body,
        data: { alertId: alert.id, catalogId: alert.catalogId },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: alert.fireAt,
        channelId: ANDROID_CHANNEL_ID,
      },
    });
    scheduled += 1;
  }

  return { scheduled, cancelled, kept };
}

/** Withdraw everything this app scheduled. Used when alerts are switched off. */
export async function cancelAllAlerts(): Promise<number> {
  const existing = await scheduledByAlertId();
  for (const identifier of existing.values()) {
    await Notifications.cancelScheduledNotificationAsync(identifier);
  }
  return existing.size;
}

/** Re-exported so callers do not reach past this module into the rules. */
export { alertId };
