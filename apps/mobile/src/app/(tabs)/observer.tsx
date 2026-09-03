import * as Location from "expo-location";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { observerAt, type ObserverLocation } from "@orbitwatch/orbit-core";

import { clearObserver, loadObserver, saveObserver } from "@/lib/storage";
import { MONO, theme } from "@/lib/theme";

/**
 * Where the user is standing.
 *
 * NO GUESSED LOCATION, EVER
 * There is no default, no IP geolocation and no "nearest major city". Look angles and
 * pass times are the first outputs of this product that become wrong rather than
 * merely imprecise when the location is wrong, and they are wrong confidently — a
 * bearing and an elevation, stated to a tenth of a degree, for somewhere the user is
 * not. So the app asks, and says plainly when it has not been told.
 *
 * PERMISSION DENIAL IS A NORMAL OUTCOME
 * Refusing location access is a reasonable thing to do, and manual entry remains fully
 * functional afterwards. The denial path is a supported route through this screen, not
 * an error state.
 */

type GpsState =
  | { readonly status: "idle" }
  | { readonly status: "locating" }
  | { readonly status: "denied" }
  | { readonly status: "failed"; readonly message: string };

export default function ObserverScreen() {
  const router = useRouter();
  const [observer, setObserver] = useState<ObserverLocation | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [manualError, setManualError] = useState<string | undefined>(undefined);
  const [gps, setGps] = useState<GpsState>({ status: "idle" });

  useEffect(() => {
    void (async () => {
      const stored = await loadObserver();
      setObserver(stored);
      if (stored !== undefined) {
        setLatitude(stored.latitude.toFixed(4));
        setLongitude(stored.longitude.toFixed(4));
      }
      setLoaded(true);
    })();
  }, []);

  const commit = useCallback(async (next: ObserverLocation) => {
    setObserver(next);
    setManualError(undefined);
    await saveObserver(next);
  }, []);

  const useGps = useCallback(async () => {
    setGps({ status: "locating" });
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== Location.PermissionStatus.GRANTED) {
        setGps({ status: "denied" });
        return;
      }

      const fix = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      // Altitude is metres above the ellipsoid where the device reports it at all;
      // orbit-core takes kilometres. A missing altitude becomes sea level rather than
      // zero-by-accident, which is the conservative assumption documented in
      // `observerAt`.
      const altitudeKm =
        fix.coords.altitude === null || !Number.isFinite(fix.coords.altitude)
          ? 0
          : fix.coords.altitude / 1000;

      const next = observerAt(
        fix.coords.latitude,
        fix.coords.longitude,
        altitudeKm,
        "Current location",
      );
      setLatitude(next.latitude.toFixed(4));
      setLongitude(next.longitude.toFixed(4));
      await commit(next);
      setGps({ status: "idle" });
    } catch (error) {
      setGps({
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [commit]);

  const setManually = useCallback(() => {
    const lat = Number(latitude.trim());
    const lon = Number(longitude.trim());
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      setManualError("Enter both coordinates as decimal degrees, e.g. -33.8688.");
      return;
    }
    try {
      // `observerAt` range-checks and throws. Letting it do so, rather than clamping
      // here, keeps one definition of a valid coordinate across every platform.
      void commit(observerAt(lat, lon, 0, "Manual entry"));
    } catch (error) {
      setManualError(error instanceof Error ? error.message : String(error));
    }
  }, [latitude, longitude, commit]);

  const forget = useCallback(async () => {
    setObserver(undefined);
    setLatitude("");
    setLongitude("");
    await clearObserver();
  }, []);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.label}>Observing location</Text>
        <Text style={styles.value} accessibilityLabel="Current observing location">
          {!loaded
            ? "…"
            : observer === undefined
              ? "No location set"
              : `${Math.abs(observer.latitude).toFixed(4)}° ${observer.latitude < 0 ? "S" : "N"}  ` +
                `${Math.abs(observer.longitude).toFixed(4)}° ${observer.longitude < 0 ? "W" : "E"}`}
        </Text>
        {observer?.label === undefined ? null : (
          <Text style={styles.note}>{observer.label}</Text>
        )}
      </View>

      <Pressable
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        onPress={() => {
          void useGps();
        }}
        accessibilityRole="button"
      >
        <Text style={styles.buttonText}>
          {gps.status === "locating" ? "Locating…" : "Use my current location"}
        </Text>
      </Pressable>

      {gps.status === "denied" ? (
        <Text style={styles.note}>
          Location access was declined, which is fine — enter coordinates below
          instead. Nothing else in the app depends on the permission.
        </Text>
      ) : null}
      {gps.status === "failed" ? <Text style={styles.error}>{gps.message}</Text> : null}

      <View style={styles.card}>
        <Text style={styles.label}>Enter coordinates</Text>
        <TextInput
          style={styles.input}
          value={latitude}
          onChangeText={setLatitude}
          placeholder="Latitude, e.g. -33.8688"
          placeholderTextColor={theme.textMuted}
          keyboardType="numbers-and-punctuation"
          accessibilityLabel="Latitude in degrees"
        />
        <TextInput
          style={styles.input}
          value={longitude}
          onChangeText={setLongitude}
          placeholder="Longitude, e.g. 151.2093"
          placeholderTextColor={theme.textMuted}
          keyboardType="numbers-and-punctuation"
          accessibilityLabel="Longitude in degrees"
        />
        {manualError === undefined ? null : <Text style={styles.error}>{manualError}</Text>}
        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          onPress={setManually}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>Set location</Text>
        </Pressable>
      </View>

      {observer === undefined ? null : (
        <Pressable
          style={({ pressed }) => [styles.secondary, pressed && styles.buttonPressed]}
          onPress={() => {
            void forget();
          }}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryText}>Forget this location</Text>
        </Pressable>
      )}

      {/*
        Alerts live behind the observing location, because that is what they depend on:
        a pass is a fact about a place, and there is nothing to notify anyone about
        until this screen has been filled in.
      */}
      {observer === undefined ? null : (
        <Pressable
          style={({ pressed }) => [styles.secondary, pressed && styles.buttonPressed]}
          onPress={() => {
            router.push("/alerts");
          }}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryText}>Pass alerts…</Text>
        </Pressable>
      )}

      <Text style={styles.privacy}>
        Your location stays on this device. It is used to compute look angles and passes
        locally and is never sent to OrbitWatch or to any provider.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.background },
  content: { padding: 12, gap: 12 },
  card: {
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  label: { color: theme.textMuted, fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase" },
  value: { color: theme.text, fontSize: 17, fontFamily: MONO.default },
  note: { color: theme.textMuted, fontSize: 12, lineHeight: 17 },
  error: { color: theme.bad, fontSize: 12, lineHeight: 17 },
  input: {
    backgroundColor: theme.background,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 8,
    color: theme.text,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 15,
    fontFamily: MONO.default,
  },
  button: {
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: "center",
  },
  buttonPressed: { opacity: 0.7 },
  buttonText: { color: theme.background, fontSize: 15, fontWeight: "600" },
  secondary: {
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  secondaryText: { color: theme.textMuted, fontSize: 14 },
  privacy: { color: theme.textMuted, fontSize: 11, lineHeight: 16 },
});
