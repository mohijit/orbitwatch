import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { DeviceMotion } from "expo-sensors";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import {
  lookAnglesAt,
  parseOmm,
  type LookAngles,
  type OMMJsonObject,
  type ObserverLocation,
  type SatRec,
} from "@orbitwatch/orbit-core";

import { fetchElements } from "@/lib/api";
import { parseCatalogId } from "@/lib/deep-links";
import {
  calibrationFrom,
  canAim,
  orientationFrom,
  sight,
  uncertaintyRadius,
  type Calibration,
  type CameraGeometry,
  type DeviceOrientation,
} from "@/lib/sky-finder";
import { loadObserver } from "@/lib/storage";
import { MONO, theme } from "@/lib/theme";

/**
 * Point the phone at the sky and find the satellite.
 *
 * WHAT THIS SCREEN PROMISES, AND WHAT IT REFUSES TO
 * It draws a circle, never a crosshair. A phone compass at its best reports better than
 * 20 degrees of uncertainty and no better, which is forty full moons across, so a point
 * would be a claim the hardware cannot support. The circle is the honest shape of the
 * answer, and it is still worth having: it reduces the whole sky to one patch of it.
 *
 * All the arithmetic and every decision about whether to aim at all live in
 * `@/lib/sky-finder`, which is pure and fully tested. This file subscribes to sensors,
 * asks that module what to draw, and draws it.
 *
 * NOT VERIFIED ON HARDWARE
 * There is no way to test a camera, a magnetometer and a sky in CI, and this has not yet
 * run on a device. The geometry underneath it is tested; the wiring is not. The known
 * unknown is the sign of the roll axis — see `orientationFrom`.
 */

/**
 * Nominal horizontal field of view for a phone's main camera, in degrees.
 *
 * expo-camera does not report the real one, and this is not worth agonising over: main
 * cameras cluster around 65-70 degrees, so the error here is a few degrees against a
 * compass uncertainty of at least twenty. The circle this screen draws is far larger
 * than the mistake this constant can cause.
 */
const NOMINAL_HORIZONTAL_FOV = 67;

/** Recompute the satellite's position this often. It moves; the sky does not wait. */
const TICK_MS = 500;

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly satrec: SatRec; readonly name: string };

export default function SkyFinderScreen() {
  const params = useLocalSearchParams<{ catalogId?: string }>();
  const catalogId = parseCatalogId(params.catalogId ?? "");
  const navigation = useNavigation();
  const { width, height } = useWindowDimensions();

  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [observer, setObserver] = useState<ObserverLocation | undefined>(undefined);
  const [permission, requestPermission] = useCameraPermissions();
  const [now, setNow] = useState(() => new Date());

  const [heading, setHeading] = useState<Location.LocationHeadingObject | undefined>(undefined);
  const [rotation, setRotation] = useState<{ alpha: number; beta: number; gamma: number }>({
    alpha: 0,
    beta: Math.PI / 2,
    gamma: 0,
  });

  useEffect(() => {
    navigation.setOptions({ title: "Sky finder" });
  }, [navigation]);

  useEffect(() => {
    void loadObserver().then(setObserver);
  }, []);

  useEffect(() => {
    if (catalogId === undefined) {
      setState({ status: "failed", message: "That is not a catalog number." });
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchElements(catalogId);
        const omm = response.elements.omm as unknown as OMMJsonObject;
        const { satrec } = parseOmm(omm);
        if (cancelled) return;
        // The name lives in the OMM the position came from, not in a separate lookup:
        // same provenance as the elements beside it.
        const rawName = (omm as { OBJECT_NAME?: unknown }).OBJECT_NAME;
        setState({
          status: "ready",
          satrec,
          name: typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim() : catalogId,
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

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  /*
   * Heading comes from the location service rather than the magnetometer, because only
   * it knows the magnetic declination for where you are standing — and therefore only
   * it can give a heading from TRUE north, which is what satellite azimuths use.
   */
  useEffect(() => {
    let subscription: Location.LocationSubscription | undefined;
    let cancelled = false;

    void (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted" || cancelled) return;
      subscription = await Location.watchHeadingAsync(setHeading);
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, []);

  useEffect(() => {
    DeviceMotion.setUpdateInterval(100);
    const subscription = DeviceMotion.addListener((motion) => {
      if (motion.rotation !== undefined) setRotation(motion.rotation);
    });
    return () => {
      subscription.remove();
    };
  }, []);

  const camera: CameraGeometry = useMemo(() => {
    /*
     * The camera fills the screen, so the vertical field follows from the horizontal
     * one and the aspect ratio of the frame it is displayed in. Deriving it rather than
     * hard-coding a second constant keeps the projection consistent with what is
     * actually on screen when the phone is rotated.
     */
    const halfH = ((NOMINAL_HORIZONTAL_FOV / 2) * Math.PI) / 180;
    const halfV = Math.atan(Math.tan(halfH) * (height / width));
    return {
      horizontalFov: NOMINAL_HORIZONTAL_FOV,
      verticalFov: (halfV * 360) / Math.PI,
    };
  }, [width, height]);

  const calibration: Calibration = calibrationFrom(
    heading?.accuracy ?? 0,
    heading?.trueHeading ?? -1,
  );
  const orientation: DeviceOrientation = orientationFrom(heading?.trueHeading ?? 0, rotation);

  const lookAngles: LookAngles | undefined =
    state.status === "ready" && observer !== undefined
      ? lookAnglesAt(state.satrec, observer, now)
      : undefined;

  if (permission === null) return <Centered>{null}</Centered>;

  if (!permission.granted) {
    return (
      <Centered>
        <Text style={styles.heading}>Camera access</Text>
        <Text style={styles.body}>
          The sky finder overlays the satellite on the camera view, so it needs the camera.
          Nothing is recorded, stored or sent anywhere.
        </Text>
        <Pressable style={styles.button} onPress={() => void requestPermission()}>
          <Text style={styles.buttonText}>Allow camera</Text>
        </Pressable>
      </Centered>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView style={StyleSheet.absoluteFill} facing="back" />

      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Overlay
          state={state}
          observer={observer}
          lookAngles={lookAngles}
          orientation={orientation}
          calibration={calibration}
          camera={camera}
          width={width}
          height={height}
        />
      </View>
    </View>
  );
}

function Overlay({
  state,
  observer,
  lookAngles,
  orientation,
  calibration,
  camera,
  width,
  height,
}: {
  readonly state: LoadState;
  readonly observer: ObserverLocation | undefined;
  readonly lookAngles: LookAngles | undefined;
  readonly orientation: DeviceOrientation;
  readonly calibration: Calibration;
  readonly camera: CameraGeometry;
  readonly width: number;
  readonly height: number;
}) {
  if (state.status === "loading") return <Banner>Loading elements…</Banner>;
  if (state.status === "failed") return <Banner tone="bad">{state.message}</Banner>;
  if (observer === undefined) {
    return <Banner tone="bad">Set an observing location first — the sky depends on where you are.</Banner>;
  }
  if (lookAngles === undefined) {
    return <Banner tone="bad">This object cannot be propagated to the current time.</Banner>;
  }

  /*
   * The compass is not good enough to aim with, so the screen does not aim.
   *
   * A pointer drawn from an unusable compass is worse than none at all: it is
   * confidently wrong, and there is nothing on screen to suggest it might be. This is
   * also the branch that catches a missing location fix, where true north is unknowable
   * and using magnetic north would be wrong by the local declination.
   */
  if (!canAim(calibration)) {
    return (
      <Banner tone="bad">
        {calibration.reason}
        {"\n\n"}
        {state.name} is at {lookAngles.azimuth.toFixed(0)}° {lookAngles.compass},{" "}
        {lookAngles.elevation.toFixed(0)}° up.
      </Banner>
    );
  }

  const seen = sight(lookAngles, orientation, camera, calibration);

  if (seen.status === "below-horizon") {
    return (
      <Banner>
        {state.name} is {Math.abs(seen.elevation).toFixed(0)}° below the horizon. The Earth is in
        the way — there is nothing to point at from here yet.
      </Banner>
    );
  }

  if (seen.status === "off-screen") {
    const turn =
      Math.abs(seen.turn) < 5
        ? "straight ahead"
        : `${Math.abs(seen.turn).toFixed(0)}° to the ${seen.turn > 0 ? "right" : "left"}`;
    const tilt =
      Math.abs(seen.tilt) < 5
        ? ""
        : `, ${Math.abs(seen.tilt).toFixed(0)}° ${seen.tilt > 0 ? "up" : "down"}`;

    return (
      <Banner>
        {state.name} is {turn}
        {tilt}.{"\n"}
        {seen.separation.toFixed(0)}° away from where you are pointing.
      </Banner>
    );
  }

  // Screen space: x runs right, y runs UP in the geometry and DOWN on a screen.
  const left = width / 2 + (seen.x * width) / 2;
  const top = height / 2 - (seen.y * height) / 2;
  const radius = (uncertaintyRadius(seen.uncertaintyDegrees, camera) * width) / 2;

  return (
    <>
      <View
        style={[
          styles.cone,
          {
            left: left - radius,
            top: top - radius,
            width: radius * 2,
            height: radius * 2,
            borderRadius: radius,
          },
        ]}
      />
      <View style={[styles.centre, { left: left - 3, top: top - 3 }]} />
      <Banner>
        {state.name} is somewhere in this circle.{"\n"}
        The compass is accurate to about {seen.uncertaintyDegrees}°, so this is a region and
        not a point.
      </Banner>
    </>
  );
}

function Banner({
  children,
  tone = "info",
}: {
  readonly children: React.ReactNode;
  readonly tone?: "info" | "bad";
}) {
  return (
    <View style={[styles.banner, tone === "bad" ? styles.bannerBad : undefined]}>
      <Text style={styles.bannerText}>{children}</Text>
    </View>
  );
}

function Centered({ children }: { readonly children: React.ReactNode }) {
  return (
    <View style={styles.centered}>
      {children === null ? <ActivityIndicator color={theme.accent} /> : children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  centered: {
    flex: 1,
    backgroundColor: theme.background,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  heading: { color: theme.text, fontSize: 18, fontWeight: "600" },
  body: { color: theme.textMuted, fontSize: 14, lineHeight: 20, textAlign: "center" },
  button: {
    backgroundColor: theme.accent,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    marginTop: 8,
  },
  buttonText: { color: "#04121a", fontWeight: "600" },
  /*
   * The uncertainty cone. Deliberately the biggest thing on screen: it is the
   * measurement, not a decoration around a more precise answer that exists underneath.
   */
  cone: {
    position: "absolute",
    borderWidth: 2,
    borderColor: "rgba(53, 200, 245, 0.9)",
    backgroundColor: "rgba(53, 200, 245, 0.10)",
  },
  /* The centre of the circle, not the position of the satellite. */
  centre: {
    position: "absolute",
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(232, 238, 248, 0.9)",
  },
  banner: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 28,
    backgroundColor: "rgba(7, 11, 20, 0.86)",
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  bannerBad: { borderColor: "rgba(244, 165, 72, 0.6)" },
  bannerText: { color: theme.text, fontSize: 13, lineHeight: 19, fontFamily: MONO.default },
});
