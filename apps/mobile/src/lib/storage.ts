import AsyncStorage from "@react-native-async-storage/async-storage";

import { observerAt, type ObserverLocation } from "@orbitwatch/orbit-core";

/**
 * On-device persistence: the watchlist, and the observing location.
 *
 * WHY THIS IS NOT SYNCED
 * An observing location is the user's home address to within a few metres. It is
 * computed against on the device and stored on the device; nothing here reaches a
 * server. Optional cloud sync is an M9 decision, and it will be opt-in for this reason.
 *
 * WHY EVERY READ IS DEFENSIVE
 * Stored values outlive the code that wrote them. A shape that changed between app
 * versions, or a value corrupted by a crash mid-write, must produce "no stored value"
 * rather than a crash on launch or — worse — a location that is subtly wrong and
 * silently used to tell someone where to look in the sky.
 */

const OBSERVER_KEY = "orbitwatch.observer.v1";
const WATCHLIST_KEY = "orbitwatch.watchlist.v1";

interface StoredObserver {
  readonly latitude: number;
  readonly longitude: number;
  readonly altitude: number;
  readonly label?: string;
}

function isValidObserver(value: unknown): value is StoredObserver {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const { latitude, longitude, altitude } = candidate;
  return (
    typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    Math.abs(latitude) <= 90 &&
    typeof longitude === "number" &&
    Number.isFinite(longitude) &&
    Math.abs(longitude) <= 180 &&
    typeof altitude === "number" &&
    Number.isFinite(altitude)
  );
}

export async function loadObserver(): Promise<ObserverLocation | undefined> {
  try {
    const raw = await AsyncStorage.getItem(OBSERVER_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidObserver(parsed)) {
      // Discarded, not repaired. A half-valid coordinate is a wrong answer with a
      // confident presentation, which is the failure this product exists to avoid.
      await AsyncStorage.removeItem(OBSERVER_KEY);
      return undefined;
    }
    return observerAt(parsed.latitude, parsed.longitude, parsed.altitude, parsed.label);
  } catch {
    return undefined;
  }
}

export async function saveObserver(observer: ObserverLocation): Promise<void> {
  const stored: StoredObserver = {
    latitude: observer.latitude,
    longitude: observer.longitude,
    altitude: observer.altitude,
    ...(observer.label === undefined ? {} : { label: observer.label }),
  };
  await AsyncStorage.setItem(OBSERVER_KEY, JSON.stringify(stored));
}

export async function clearObserver(): Promise<void> {
  await AsyncStorage.removeItem(OBSERVER_KEY);
}

export async function loadWatchlist(): Promise<readonly string[]> {
  try {
    const raw = await AsyncStorage.getItem(WATCHLIST_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

export async function saveWatchlist(catalogIds: readonly string[]): Promise<void> {
  await AsyncStorage.setItem(WATCHLIST_KEY, JSON.stringify(catalogIds));
}
