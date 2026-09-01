import { useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import {
  assessAccuracy,
  deriveOrbitGeometry,
  lookAnglesAt,
  parseOmm,
  predictPasses,
  type AccuracyAssessment,
  type LookAngles,
  type OMMJsonObject,
  type ObserverLocation,
  type OrbitClass,
  type SatRec,
  type SatellitePass,
} from "@orbitwatch/orbit-core";

import { fetchElements } from "@/lib/api";
import { loadObserver, loadWatchlist, saveWatchlist } from "@/lib/storage";
import { MONO, theme } from "@/lib/theme";

/**
 * One satellite, in detail.
 *
 * THE THREE TIMES ARE ALL SHOWN
 * Position time, element epoch and retrieval time are three different facts. Other
 * trackers routinely collapse them into a single "live" claim; this screen keeps them
 * apart, and states the confidence in the propagation alongside, because the honest
 * answer to "where is it" is a position AND how much to trust it.
 *
 * PROPAGATION IS LOCAL
 * The server sends elements, not positions. Everything below — the sub-satellite
 * point, the look angles, the passes — is computed on the device by the same
 * `@orbitwatch/orbit-core` that the web app uses, which is what makes the M6
 * cross-platform agreement tests meaningful rather than tautological.
 */

const TICK_MS = 1000;
const PASS_WINDOW_HOURS = 24;

interface Loaded {
  readonly satrec: SatRec;
  readonly epoch: Date;
  readonly retrievedAt: Date;
  readonly name: string;
  readonly orbitClass: OrbitClass;
}

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | ({ readonly status: "ready" } & Loaded);

const CONFIDENCE_LABEL: Record<string, string> = {
  NOMINAL: "LIVE · PROPAGATED",
  DEGRADED: "PROPAGATED · AGING",
  EXTRAPOLATED: "EXTRAPOLATED",
  UNRELIABLE: "UNRELIABLE",
};

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export default function SatelliteDetailScreen() {
  const { catalogId } = useLocalSearchParams<{ catalogId: string }>();
  const navigation = useNavigation();

  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [observer, setObserver] = useState<ObserverLocation | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [watched, setWatched] = useState(false);

  useEffect(() => {
    void (async () => {
      setObserver(await loadObserver());
      setWatched((await loadWatchlist()).includes(catalogId));
    })();
  }, [catalogId]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    void (async () => {
      try {
        const response = await fetchElements(catalogId);
        if (cancelled) return;
        const omm = response.elements.omm as OMMJsonObject;
        const { satrec } = parseOmm(omm);
        const rawName = (omm as { OBJECT_NAME?: unknown }).OBJECT_NAME;
        const { orbitClass } = deriveOrbitGeometry(satrec);

        setState({
          status: "ready",
          satrec,
          epoch: new Date(response.elements.epoch),
          retrievedAt: new Date(response.elements.retrievedAt),
          name: typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim() : catalogId,
          orbitClass,
        });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [catalogId]);

  // The clock drives re-render; elements are fetched once. Propagating locally every
  // second costs one SGP4 call, where refetching would be a request per second for
  // elements that change roughly every two hours.
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (state.status === "ready") navigation.setOptions({ title: state.name });
  }, [state, navigation]);

  const toggleWatch = useCallback(async () => {
    const current = await loadWatchlist();
    const next = current.includes(catalogId)
      ? current.filter((entry) => entry !== catalogId)
      : [...current, catalogId];
    await saveWatchlist(next);
    setWatched(next.includes(catalogId));
  }, [catalogId]);

  if (state.status === "loading") {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  if (state.status === "failed") {
    return (
      <View style={styles.centre}>
        <Text style={styles.error}>{state.message}</Text>
      </View>
    );
  }

  const at = new Date(now);
  const accuracy: AccuracyAssessment = assessAccuracy(state.epoch, at, state.orbitClass);
  const lookAngles: LookAngles | undefined =
    observer === undefined ? undefined : lookAnglesAt(state.satrec, observer, at);
  const passes: readonly SatellitePass[] =
    observer === undefined
      ? []
      : predictPasses(
          state.satrec,
          observer,
          at,
          new Date(now + PASS_WINDOW_HOURS * 3_600_000),
        );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <Text style={styles.name}>{state.name}</Text>
          <Text style={styles.ids}>
            #{catalogId} · {state.orbitClass}
          </Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.watch, watched && styles.watchOn, pressed && styles.pressed]}
          onPress={() => {
            void toggleWatch();
          }}
          accessibilityRole="button"
          accessibilityLabel={watched ? "Remove from watchlist" : "Add to watchlist"}
        >
          <Text style={[styles.watchText, watched && styles.watchTextOn]}>
            {watched ? "Watching" : "Watch"}
          </Text>
        </Pressable>
      </View>

      <Text style={[styles.badge, badgeStyle(accuracy.confidence)]}>
        {CONFIDENCE_LABEL[accuracy.confidence] ?? accuracy.confidence}
      </Text>

      {!accuracy.renderable ? (
        <Text style={styles.warning}>
          Position not shown: propagating this element set to now is beyond a defensible
          limit. An authoritative-looking wrong answer is worse than an honest gap.
        </Text>
      ) : accuracy.warning === undefined ? null : (
        <Text style={styles.warning}>{accuracy.warning}</Text>
      )}

      <View style={styles.card}>
        <Fact label="Position time" value={at.toISOString().replace("T", " ").slice(0, 19) + "Z"} />
        <Fact label="Element epoch" value={accuracy.label} />
        <Fact
          label="Retrieved"
          value={state.retrievedAt.toISOString().replace("T", " ").slice(0, 19) + "Z"}
        />
      </View>

      <Text style={styles.section}>Look angles</Text>
      {observer === undefined ? (
        <Text style={styles.note}>
          Set an observing location to see where to point. The Observer tab does this.
        </Text>
      ) : lookAngles === undefined ? (
        <Text style={styles.note}>This object cannot be propagated to the current time.</Text>
      ) : (
        <View style={styles.card}>
          <Fact
            label="Azimuth"
            value={`${lookAngles.azimuth.toFixed(1)}° ${lookAngles.compass}`}
          />
          <Fact label="Elevation" value={`${lookAngles.elevation.toFixed(1)}°`} />
          <Fact label="Range" value={`${Math.round(lookAngles.range).toLocaleString()} km`} />
          <Fact
            label="Horizon"
            value={lookAngles.elevation >= 0 ? "Above the horizon" : "Below the horizon"}
          />
        </View>
      )}

      <Text style={styles.section}>Next 24 hours</Text>
      {observer === undefined ? (
        <Text style={styles.note}>Set an observing location to see passes.</Text>
      ) : passes.length === 0 ? (
        <Text style={styles.note}>
          No passes above 10° in the next 24 hours from your location.
        </Text>
      ) : (
        <View style={styles.card}>
          {passes.map((pass) => (
            <View key={pass.aos.time.toISOString()} style={styles.passRow}>
              <Text style={styles.passTime}>
                {timeFormat.format(pass.aos.time)} → {timeFormat.format(pass.los.time)}
              </Text>
              <Text style={styles.passGeometry}>
                max {pass.maximum.elevation.toFixed(0)}° {pass.maximum.compass}
              </Text>
            </View>
          ))}
        </View>
      )}

      <Text style={styles.footnote}>
        Position calculated on this device from published orbital elements using
        SGP4/SDP4. It is not continuous onboard GPS telemetry.
      </Text>
    </ScrollView>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

function badgeStyle(confidence: string) {
  switch (confidence) {
    case "NOMINAL":
      return { color: theme.good, borderColor: theme.good };
    case "DEGRADED":
      return { color: theme.warn, borderColor: theme.warn };
    default:
      return { color: theme.bad, borderColor: theme.bad };
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.background },
  content: { padding: 12, gap: 10 },
  centre: { flex: 1, backgroundColor: theme.background, alignItems: "center", justifyContent: "center", padding: 20 },
  headerRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  headerText: { flex: 1 },
  name: { color: theme.text, fontSize: 19, fontWeight: "600" },
  ids: { color: theme.textMuted, fontSize: 12, fontFamily: MONO.default, marginTop: 2 },
  watch: { borderColor: theme.border, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  watchOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  watchText: { color: theme.textMuted, fontSize: 12 },
  watchTextOn: { color: theme.background, fontWeight: "600" },
  pressed: { opacity: 0.7 },
  badge: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    fontSize: 10,
    letterSpacing: 1,
    fontFamily: MONO.default,
  },
  warning: { color: theme.warn, fontSize: 12, lineHeight: 17 },
  card: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: 10, padding: 12, gap: 8 },
  fact: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  factLabel: { color: theme.textMuted, fontSize: 12 },
  factValue: { color: theme.text, fontSize: 12, fontFamily: MONO.default, flexShrink: 1, textAlign: "right" },
  section: { color: theme.textMuted, fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase", marginTop: 6 },
  note: { color: theme.textMuted, fontSize: 12, lineHeight: 17 },
  error: { color: theme.bad, fontSize: 13, textAlign: "center", lineHeight: 18 },
  passRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  passTime: { color: theme.text, fontSize: 12, fontFamily: MONO.default },
  passGeometry: { color: theme.textMuted, fontSize: 12, fontFamily: MONO.default },
  footnote: { color: theme.textMuted, fontSize: 11, lineHeight: 16, marginTop: 6 },
});
