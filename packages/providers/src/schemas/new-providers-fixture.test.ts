import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DONKI_MESSAGE_TYPES,
  donkiNotificationsResponseSchema,
  summariseDonkiBody,
  toSolarEvents,
} from "./nasa-donki.js";
import {
  satnogsStationsResponseSchema,
  toGroundStations,
} from "./satnogs-network.js";

/**
 * Schemas checked against the real captured responses.
 *
 * This is the step that makes a schema mean anything. A schema written from
 * documentation is a guess about a third party; a schema that parses bytes the provider
 * actually sent is evidence. Both fixtures here were captured through the same
 * FetchGuard production uses, with one request each, and their provenance is recorded
 * in `fixtures/manifest.json`.
 */

const repoRoot = resolve(process.cwd(), "..", "..");
const read = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(repoRoot, "fixtures", name), "utf8"));

describe("NASA DONKI, against a real response", () => {
  const payload = read("nasa-donki-notifications.json");

  it("parses every notification in the captured window", () => {
    const parsed = donkiNotificationsResponseSchema.parse(payload);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("covers the message types NASA actually sent", () => {
    const events = toSolarEvents(payload);
    const types = new Set(events.map((event) => event.type));

    // The captured August 2026 window contained CME, GST, FLR, SEP, RBE, IPS, MPC and
    // Report. Geomagnetic storms are the ones that matter most to this product: they
    // are what expands the thermosphere and degrades propagation from ageing elements.
    expect(types.has("CME")).toBe(true);
    expect(types.has("GST")).toBe(true);

    // Every observed type is one the product can explain.
    for (const type of types) {
      expect(DONKI_MESSAGE_TYPES as readonly string[]).toContain(type);
    }
  });

  it("marks an unrecognised type as unknown instead of rejecting it", () => {
    // NASA adds message types. A new one must not fail an ingestion that could store
    // it, so the enum is open at the bottom and the record says which it is.
    const events = toSolarEvents([
      {
        messageType: "XYZ",
        messageID: "20260901-AL-999",
        messageURL: "https://example.invalid/1",
        messageIssueTime: "2026-09-01T00:00Z",
        messageBody: "## Message Type: Something new\n\nA new kind of notification.",
      },
    ]);

    expect(events[0]?.known).toBe(false);
    expect(events[0]?.type).toBe("XYZ");
  });

  it("parses the minute-precision issue time NASA publishes", () => {
    // "2026-08-31T16:51Z" — no seconds. Valid ISO, and worth pinning: anything
    // reconstructing the string by formatting the Date will not round trip.
    const events = toSolarEvents(payload);
    for (const event of events) {
      expect(Number.isNaN(event.issuedAt.getTime())).toBe(false);
    }
  });

  it("summarises past the boilerplate header, not into it", () => {
    // Every body opens with several ## lines naming the database, the type, the date
    // and the id. A summary made of those would be identical for every event.
    const events = toSolarEvents(payload);
    for (const event of events) {
      expect(event.summary.startsWith("##")).toBe(false);
    }
    expect(events.some((event) => event.summary.length > 0)).toBe(true);
  });

  it("returns an empty summary rather than inventing one", () => {
    expect(summariseDonkiBody("## Only\n## Headers\n")).toBe("");
  });

  it("refuses a notification whose time cannot be ordered", () => {
    // DONKI is one curated NASA service, not a community database. A time that will
    // not parse means the format changed, and silently dropping records would leave an
    // event list quietly incomplete — a missing geomagnetic storm is worse than an
    // ingestion that failed and said so.
    expect(() =>
      toSolarEvents([
        {
          messageType: "CME",
          messageID: "bad",
          messageURL: "https://example.invalid/2",
          messageIssueTime: "not a date",
          messageBody: "body",
        },
      ]),
    ).toThrow();
  });
});

describe("SatNOGS Network, against a real response", () => {
  const payload = read("satnogs-network-stations.json");

  it("parses every station in the captured subset", () => {
    const parsed = satnogsStationsResponseSchema.parse(payload);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("carries status through rather than counting it away", () => {
    // 4,119 of the 4,452 stations in the full listing were Offline. Presenting the
    // total as receiving capacity would overstate coverage tenfold.
    const stations = toGroundStations(payload);
    const statuses = new Set(stations.map((station) => station.status));
    expect(statuses.has("Offline")).toBe(true);
    expect(statuses.has("Online")).toBe(true);
  });

  it("keeps each station's own horizon", () => {
    // Genuinely per-station: a site in a valley may not observe below 40 degrees, which
    // is why "above 10 degrees" is not the same question for every receiver.
    const stations = toGroundStations(payload);
    const horizons = new Set(stations.map((station) => station.minHorizonDegrees));
    expect(horizons.size).toBeGreaterThan(1);
    for (const station of stations) {
      expect(station.minHorizonDegrees).toBeGreaterThanOrEqual(0);
      expect(station.minHorizonDegrees).toBeLessThan(90);
    }
  });

  it("deduplicates bands, so four UHF antennas are one band", () => {
    const stations = toGroundStations(payload);
    for (const station of stations) {
      expect(new Set(station.bands).size).toBe(station.bands.length);
    }
    expect(stations.some((station) => station.bands.includes("UHF"))).toBe(true);
  });

  it("accepts a station with no antennas rather than rejecting it", () => {
    // A registered site not yet equipped is real.
    const stations = toGroundStations([
      {
        id: 9999,
        name: "Unequipped",
        altitude: 10,
        lat: 0,
        lng: 0,
        min_horizon: 10,
        status: "Testing",
        antenna: [],
        last_seen: null,
        observations: 0,
      },
    ]);
    expect(stations[0]?.bands).toEqual([]);
    expect(stations[0]?.lastSeen).toBeUndefined();
  });

  it("keeps positions inside real bounds", () => {
    const stations = toGroundStations(payload);
    for (const station of stations) {
      expect(Math.abs(station.latitude)).toBeLessThanOrEqual(90);
      expect(Math.abs(station.longitude)).toBeLessThanOrEqual(180);
    }
  });
});
