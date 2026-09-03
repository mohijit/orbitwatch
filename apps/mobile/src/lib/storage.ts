import AsyncStorage from "@react-native-async-storage/async-storage";

import { observerAt, type ObserverLocation } from "@orbitwatch/orbit-core";

import { sanitiseAlertPreferences, type AlertPreferences } from "./pass-alerts";

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
const ALERTS_KEY = "orbitwatch.alerts.v1";
const SYNC_CODE_KEY = "orbitwatch.sync-code.v1";

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

/**
 * Notification preferences.
 *
 * The validation is `sanitiseAlertPreferences`, which is pure and lives with the rules
 * it protects. Everything unreadable here — a missing key, invalid JSON, a shape from
 * an older version — ends at the same place: the defaults, with alerts OFF. These
 * settings decide when to wake somebody up, so the failure direction is silence.
 */
export async function loadAlertPreferences(): Promise<AlertPreferences> {
  try {
    const raw = await AsyncStorage.getItem(ALERTS_KEY);
    if (raw === null) return sanitiseAlertPreferences(undefined);
    return sanitiseAlertPreferences(JSON.parse(raw));
  } catch {
    return sanitiseAlertPreferences(undefined);
  }
}

export async function saveAlertPreferences(preferences: AlertPreferences): Promise<void> {
  // Sanitised on the way in as well as on the way out. A caller passing something the
  // rules cannot act on should not be able to persist it and find out later.
  await AsyncStorage.setItem(ALERTS_KEY, JSON.stringify(sanitiseAlertPreferences(preferences)));
}

/**
 * The watchlist pairing code, if this device has one.
 *
 * A bearer secret, kept in the same place as everything else because there is nowhere
 * better on a device: the OS keychain is for credentials that unlock something worth
 * stealing, and this unlocks a list of satellite numbers. Anyone who can read this app's
 * storage can already read the watchlist itself.
 */
export async function loadSyncCode(): Promise<string | undefined> {
  try {
    const raw = await AsyncStorage.getItem(SYNC_CODE_KEY);
    return raw === null || raw.trim() === "" ? undefined : raw;
  } catch {
    return undefined;
  }
}

export async function saveSyncCode(code: string): Promise<void> {
  await AsyncStorage.setItem(SYNC_CODE_KEY, code);
}

export async function clearSyncCode(): Promise<void> {
  await AsyncStorage.removeItem(SYNC_CODE_KEY);
}
