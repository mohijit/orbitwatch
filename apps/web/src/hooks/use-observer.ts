"use client";

import { storedObserverSchema, type ObserverSource, type StoredObserver } from "@orbitwatch/contracts";
import { degrees, kilometers, type ObserverLocation } from "@orbitwatch/orbit-core";
import { useCallback, useEffect, useState } from "react";

/**
 * Where the user is observing from.
 *
 * Everything in M4 — look angles, pass times, whether a pass is visible at all —
 * is meaningless without this, and wrong rather than merely imprecise if it is wrong.
 * So the observer is never guessed: there is no default location, no IP geolocation,
 * and no silent fallback to a city. Until someone sets one, the app says it does not
 * know where they are.
 *
 * PERSISTENCE
 * Kept in localStorage so the app does not ask again on every visit. It is validated
 * on read with the same schema the rest of the system uses, because a value written
 * by an older version of the app — or edited by hand — is untrusted input like any
 * other. A stored value that no longer parses is discarded rather than repaired: a
 * half-understood coordinate is worse than asking again.
 *
 * PRIVACY
 * The location never leaves the device. Pass prediction runs locally against locally
 * propagated elements, so there is no request to send it in, and nothing here writes
 * it anywhere but this browser's own storage.
 */

const STORAGE_KEY = "orbitwatch.observer.v1";

export type ObserverState =
  | { readonly status: "unset" }
  | { readonly status: "locating" }
  | { readonly status: "denied"; readonly message: string }
  | { readonly status: "set"; readonly observer: StoredObserver };

export interface ObserverApi {
  readonly state: ObserverState;
  /** The value orbit-core wants, or undefined when no location is set. */
  readonly location: ObserverLocation | undefined;
  /** Ask the browser for a device fix. Requires a user gesture on most platforms. */
  requestDeviceLocation: () => void;
  /** Set from a coordinate the user supplied or picked off the globe. */
  setLocation: (
    input: { latitude: number; longitude: number; altitude?: number; label?: string },
    source: ObserverSource,
  ) => void;
  clear: () => void;
}

function read(): StoredObserver | undefined {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return undefined;
    const parsed = storedObserverSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Storage can throw outright, not merely return null: Safari private mode and
    // browsers configured to block site data both do. An unavailable store is not an
    // error worth surfacing — the app simply asks for a location again.
    return undefined;
  }
}

function write(observer: StoredObserver | undefined): void {
  try {
    if (observer === undefined) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(observer));
  } catch {
    // Losing persistence is survivable; losing the session is not.
  }
}

/** Translate a GeolocationPositionError into something a person can act on. */
function explainGeolocationError(error: GeolocationPositionError): string {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return "Location permission was denied. You can still set a location by entering coordinates or clicking the globe.";
    case error.POSITION_UNAVAILABLE:
      return "Your device could not determine a position. Try entering coordinates or clicking the globe.";
    case error.TIMEOUT:
      return "Getting a position timed out. Try again, or set a location manually.";
    default:
      return "Could not get a position from this device.";
  }
}

export function useObserver(): ObserverApi {
  // Starts unset on both server and client and is filled in after mount. This page is
  // statically prerendered, so reading localStorage during render would either crash
  // on the server or produce markup the client disagrees with.
  const [state, setState] = useState<ObserverState>({ status: "unset" });

  useEffect(() => {
    const stored = read();
    if (stored !== undefined) setState({ status: "set", observer: stored });
  }, []);

  const store = useCallback((observer: StoredObserver): void => {
    write(observer);
    setState({ status: "set", observer });
  }, []);

  const setLocation = useCallback<ObserverApi["setLocation"]>(
    (input, source) => {
      const candidate = {
        latitude: input.latitude,
        longitude: input.longitude,
        altitude: input.altitude ?? 0,
        ...(input.label === undefined ? {} : { label: input.label }),
        source,
        savedAt: new Date().toISOString(),
      };

      // Validated even though it came from our own UI: the globe hands back whatever
      // the camera was pointing at, and manual entry is free text.
      const parsed = storedObserverSchema.safeParse(candidate);
      if (!parsed.success) {
        setState({
          status: "denied",
          message: parsed.error.issues[0]?.message ?? "That is not a valid location.",
        });
        return;
      }
      store(parsed.data);
    },
    [store],
  );

  const requestDeviceLocation = useCallback((): void => {
    if (typeof navigator === "undefined" || navigator.geolocation === undefined) {
      setState({
        status: "denied",
        message: "This browser does not offer location services. Enter coordinates instead.",
      });
      return;
    }

    setState({ status: "locating" });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, altitude, accuracy } = position.coords;
        store({
          latitude,
          longitude,
          // The Geolocation API reports metres above the ellipsoid, and null when it
          // has no altitude fix at all. Zero is the honest substitute: it is what an
          // unknown height is treated as everywhere else, rather than a guess.
          altitude: altitude === null ? 0 : altitude / 1000,
          source: "DEVICE",
          ...(Number.isFinite(accuracy) ? { accuracyMetres: accuracy } : {}),
          savedAt: new Date().toISOString(),
        });
      },
      (error) => {
        setState({ status: "denied", message: explainGeolocationError(error) });
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }, [store]);

  const clear = useCallback((): void => {
    write(undefined);
    setState({ status: "unset" });
  }, []);

  return {
    state,
    // Branded at this boundary, and only here: the contract schema validates plain
    // numbers off the wire and out of storage, orbit-core takes tagged units, and this
    // hook is the one place that knows both.
    location:
      state.status === "set"
        ? {
            latitude: degrees(state.observer.latitude),
            longitude: degrees(state.observer.longitude),
            altitude: kilometers(state.observer.altitude),
            ...(state.observer.label === undefined ? {} : { label: state.observer.label }),
          }
        : undefined,
    requestDeviceLocation,
    setLocation,
    clear,
  };
}
