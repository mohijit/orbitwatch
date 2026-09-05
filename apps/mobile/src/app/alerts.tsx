import { useNavigation } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";

import { syncPassAlerts, type SyncOutcome } from "@/lib/alert-sync";
import { DEFAULT_ALERT_PREFERENCES, type AlertPreferences } from "@/lib/pass-alerts";
import { cancelAllAlerts, requestAlertPermission } from "@/lib/notifications";
import { loadAlertPreferences, saveAlertPreferences } from "@/lib/storage";
import { MONO, theme } from "@/lib/theme";

/**
 * When to be interrupted about a pass.
 *
 * Every control here makes the app QUIETER or noisier, and the screen says which. A
 * notification is a promise that something will be visible; two bad ones in a row and
 * the feature is turned off for good, so the defaults are conservative and the settings
 * explain what they cost rather than just what they do.
 *
 * The rules themselves are in `@/lib/pass-alerts`, pure and tested, including the
 * validation that runs on everything loaded from disk. This screen only edits values.
 */

const ELEVATION_STEPS = [10, 20, 30, 40, 50, 60, 70, 80] as const;
const LEAD_STEPS = [2, 5, 10, 15, 20, 30, 45, 60] as const;
const CAP_STEPS = [1, 2, 3, 5, 10] as const;

export default function AlertSettingsScreen() {
  const navigation = useNavigation();
  const [preferences, setPreferences] = useState<AlertPreferences>(DEFAULT_ALERT_PREFERENCES);
  const [loaded, setLoaded] = useState(false);
  const [denied, setDenied] = useState(false);
  const [outcome, setOutcome] = useState<SyncOutcome | undefined>(undefined);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    navigation.setOptions({ title: "Pass alerts" });
  }, [navigation]);

  useEffect(() => {
    void loadAlertPreferences().then((stored) => {
      setPreferences(stored);
      setLoaded(true);
    });
  }, []);

  /**
   * Save, then make the scheduled notifications match.
   *
   * Immediately, on every change, rather than behind a "save" button. A rule that has
   * been edited but not applied is a rule the user believes is in force and is not, and
   * the only evidence either way arrives at 3am.
   */
  const update = useCallback((next: AlertPreferences) => {
    setPreferences(next);
    void (async () => {
      await saveAlertPreferences(next);
      if (!next.enabled) {
        setOutcome(undefined);
        return;
      }
      setSyncing(true);
      try {
        setOutcome(await syncPassAlerts(next));
      } finally {
        setSyncing(false);
      }
    })();
  }, []);

  const toggleEnabled = useCallback(
    (enabled: boolean) => {
      void (async () => {
        if (!enabled) {
          // Switching off withdraws what is already scheduled. Leaving it in place
          // would fire notifications from a feature the user has just turned off.
          await cancelAllAlerts();
          update({ ...preferences, enabled: false });
          return;
        }

        /*
         * Permission is requested here and not on launch.
         *
         * Asking before the user has shown any interest is how an app collects a
         * permanent refusal from someone who would have said yes later.
         */
        const granted = await requestAlertPermission();
        setDenied(!granted);
        update({ ...preferences, enabled: granted });
      })();
    },
    [preferences, update],
  );

  if (!loaded) return <View style={styles.screen} />;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Row>
          <Text style={styles.rowLabel}>Alert me about passes</Text>
          <Switch
            value={preferences.enabled}
            onValueChange={toggleEnabled}
            trackColor={{ true: theme.accent, false: theme.border }}
          />
        </Row>
        <Text style={styles.note}>
          Alerts are scheduled on this device from elements already downloaded. Nothing is
          sent to a server, and no push service is involved.
        </Text>
        {denied ? (
          <Text style={styles.error}>
            Notifications are turned off for OrbitWatch in system settings, so nothing can be
            scheduled until that changes.
          </Text>
        ) : null}

        {/*
          What the rules above actually produced.
          
          Settings that describe themselves but never say what they did leave the user
          guessing until a notification arrives, or does not. This is the feedback loop:
          change a rule, see the count change.
        */}
        {preferences.enabled ? (
          <Text style={styles.outcome}>{describeOutcome(outcome, syncing)}</Text>
        ) : null}
      </View>

      <Text style={styles.section}>What is worth interrupting you for</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Minimum peak elevation</Text>
        <Steps
          options={ELEVATION_STEPS}
          value={preferences.minimumElevation}
          format={(value) => `${value}°`}
          onChange={(minimumElevation) => {
            update({ ...preferences, minimumElevation });
          }}
        />
        <Text style={styles.note}>
          A pass counts from 10°, but one peaking that low is behind whatever building or
          tree is in that direction. Higher means fewer alerts and better ones.
        </Text>
      </View>

      <View style={styles.card}>
        <Row>
          <Text style={styles.rowLabel}>Only passes you could actually see</Text>
          <Switch
            value={preferences.onlyVisiblePasses}
            onValueChange={(onlyVisiblePasses) => {
              update({ ...preferences, onlyVisiblePasses });
            }}
            trackColor={{ true: theme.accent, false: theme.border }}
          />
        </Row>
        <Text style={styles.note}>
          A satellite in the Earth&apos;s shadow passes straight overhead and is invisible.
          Turning this off will alert you to passes with nothing to see.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>At most, per night</Text>
        <Steps
          options={CAP_STEPS}
          value={preferences.maxPerNight}
          format={(value) => String(value)}
          onChange={(maxPerNight) => {
            update({ ...preferences, maxPerNight });
          }}
        />
        <Text style={styles.note}>
          When the cap bites, the highest passes survive rather than the earliest — the
          point of a cap is to spend your attention on the best of what is available.
        </Text>
      </View>

      <Text style={styles.section}>When</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Warning time</Text>
        <Steps
          options={LEAD_STEPS}
          value={preferences.leadTimeMinutes}
          format={(value) => `${value} min`}
          onChange={(leadTimeMinutes) => {
            update({ ...preferences, leadTimeMinutes });
          }}
        />
        <Text style={styles.note}>
          How long before the satellite rises to tell you. Long enough to get outside and
          let your eyes adjust; not so long that you forget.
        </Text>
      </View>

      <View style={styles.card}>
        <Row>
          <Text style={styles.rowLabel}>Stay quiet overnight</Text>
          <Switch
            value={preferences.quietHours !== undefined}
            onValueChange={(quiet) => {
              if (quiet) {
                update({ ...preferences, quietHours: { startHour: 23, endHour: 6 } });
                return;
              }
              // The key is removed rather than set to undefined: under
              // exactOptionalPropertyTypes those are different states, and "present but
              // undefined" is not a window at all.
              const { quietHours: _off, ...rest } = preferences;
              update(rest);
            }}
            trackColor={{ true: theme.accent, false: theme.border }}
          />
        </Row>
        {preferences.quietHours === undefined ? null : (
          <>
            <HourRow
              label="From"
              hour={preferences.quietHours.startHour}
              onChange={(startHour) => {
                update({
                  ...preferences,
                  quietHours: { startHour, endHour: preferences.quietHours?.endHour ?? 6 },
                });
              }}
            />
            <HourRow
              label="Until"
              hour={preferences.quietHours.endHour}
              onChange={(endHour) => {
                update({
                  ...preferences,
                  quietHours: { startHour: preferences.quietHours?.startHour ?? 23, endHour },
                });
              }}
            />
            <Text style={styles.note}>
              Some of the best passes are in the small hours. A pass inside this window is
              skipped entirely rather than delayed — a late alert about a pass that has
              already happened is worse than none.
            </Text>
          </>
        )}
      </View>
    </ScrollView>
  );
}

/** Plain language for what the last reconciliation did. */
function describeOutcome(outcome: SyncOutcome | undefined, syncing: boolean): string {
  if (syncing) return "Checking the next 24 hours…";
  if (outcome === undefined) return "";

  switch (outcome.status) {
    case "no-observer":
      return "Set an observing location first — a pass is a fact about a place.";
    case "empty-watchlist":
      // Not an error. Alerting on the whole catalog would mean something bright
      // overhead at all hours, which is the fastest way to have alerts switched off.
      return "Nothing on your watchlist yet. Follow a satellite and its passes appear here.";
    case "failed":
      return `Could not schedule: ${outcome.message}`;
    case "synced": {
      const total = outcome.scheduled + outcome.kept;
      if (total === 0) {
        return "No passes in the next 24 hours meet these rules. Loosening them will find more.";
      }
      return `${total} alert${total === 1 ? "" : "s"} set for the next 24 hours.`;
    }
  }
}

function Row({ children }: { readonly children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

function Steps<T extends number>({
  options,
  value,
  format,
  onChange,
}: {
  readonly options: readonly T[];
  readonly value: number;
  readonly format: (value: T) => string;
  readonly onChange: (value: T) => void;
}) {
  return (
    <View style={styles.steps}>
      {options.map((option) => {
        const selected = option === value;
        return (
          <Pressable
            key={option}
            style={[styles.step, selected ? styles.stepOn : undefined]}
            onPress={() => {
              onChange(option);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
          >
            <Text style={[styles.stepText, selected ? styles.stepTextOn : undefined]}>
              {format(option)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function HourRow({
  label,
  hour,
  onChange,
}: {
  readonly label: string;
  readonly hour: number;
  readonly onChange: (hour: number) => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.stepper}>
        <Pressable
          style={styles.stepperButton}
          onPress={() => {
            onChange((hour + 23) % 24);
          }}
          accessibilityLabel={`${label} one hour earlier`}
        >
          <Text style={styles.stepperText}>−</Text>
        </Pressable>
        <Text style={styles.hour}>{String(hour).padStart(2, "0")}:00</Text>
        <Pressable
          style={styles.stepperButton}
          onPress={() => {
            onChange((hour + 1) % 24);
          }}
          accessibilityLabel={`${label} one hour later`}
        >
          <Text style={styles.stepperText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.background },
  content: { padding: 12, gap: 12, paddingBottom: 40 },
  card: {
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 10,
  },
  section: {
    color: theme.textMuted,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginTop: 6,
  },
  label: { color: theme.textMuted, fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  rowLabel: { color: theme.text, fontSize: 14, flexShrink: 1 },
  note: { color: theme.textMuted, fontSize: 12, lineHeight: 17 },
  error: { color: theme.bad, fontSize: 12, lineHeight: 17 },
  outcome: { color: theme.accent, fontSize: 12, lineHeight: 17 },
  steps: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  step: {
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  stepOn: { borderColor: theme.accent, backgroundColor: "rgba(53, 200, 245, 0.12)" },
  stepText: { color: theme.textMuted, fontSize: 13, fontFamily: MONO.default },
  stepTextOn: { color: theme.accent },
  stepper: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepperButton: {
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 7,
    width: 36,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperText: { color: theme.text, fontSize: 17 },
  hour: { color: theme.text, fontSize: 15, fontFamily: MONO.default, minWidth: 58, textAlign: "center" },
});
