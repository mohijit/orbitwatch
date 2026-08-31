import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  noaaPlanetaryKIndexSchema,
  noaaScalesSchema,
  parseNoaaSolarWind,
} from "./noaa.js";
import {
  launchDetailedResponseSchema,
  launchListResponseSchema,
  toLaunchDetails,
  toLaunchSummaries,
} from "./launch-library.js";
import { toIssCrossCheck, whereTheIssSchema } from "./wheretheiss.js";

/**
 * Schema validation against REAL captured provider responses.
 *
 * Every fixture here is an unmodified production payload recorded by
 * `pnpm verify:providers`; provenance is in fixtures/manifest.json. The schemas were
 * written to match these responses — the fixtures were never edited to fit a schema.
 *
 * These tests are what makes "verified" mean something. A provider is only integrated
 * once its real response parses here.
 */

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "fixtures",
);

const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));

describe("fixture manifest", () => {
  it("records provenance for every committed fixture", () => {
    const manifest = loadFixture("manifest.json") as {
      fixtures: { file: string; endpoint: string; retrievedAt: string; purpose: string }[];
      blocked: { provider: string; status: string; reason: string }[];
    };

    expect(manifest.fixtures.length).toBeGreaterThan(0);
    for (const entry of manifest.fixtures) {
      expect(entry.endpoint).toMatch(/^https:\/\//);
      expect(entry.purpose.length).toBeGreaterThan(10);
      expect(Number.isNaN(Date.parse(entry.retrievedAt))).toBe(false);
      // The fixture it describes must actually exist.
      expect(() => loadFixture(entry.file)).not.toThrow();
    }

    // Blocked providers must be recorded as blocked, never quietly mocked.
    for (const entry of manifest.blocked) {
      expect(entry.status).toBe("BLOCKED");
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it("contains no credentials or tokens", () => {
    for (const name of [
      "manifest.json",
      "launch-library-upcoming.json",
      "launch-library-upcoming-detailed.json",
      "noaa-planetary-k-index.json",
      "noaa-propagated-solar-wind.json",
      "noaa-scales.json",
      "wheretheiss-iss.json",
    ]) {
      const raw = readFileSync(join(FIXTURE_DIR, name), "utf8");
      expect(raw).not.toMatch(/api[_-]?key\s*[":=]/i);
      expect(raw).not.toMatch(/\bbearer\s+[\w.-]{8,}/i);
      expect(raw).not.toMatch(/authorization\s*[":=]/i);
    }
  });
});

describe("NOAA planetary K index", () => {
  const fixture = loadFixture("noaa-planetary-k-index.json");

  it("parses the real response", () => {
    const parsed = noaaPlanetaryKIndexSchema.parse(fixture);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("reads timezone-less time_tag values as UTC", () => {
    // The raw fixture has "2026-08-24T00:00:00" with no designator. Parsed naively
    // this would land on the previous day in any positive-offset timezone.
    const raw = fixture as { time_tag: string }[];
    expect(raw[0]?.time_tag).not.toMatch(/Z$/);

    const parsed = noaaPlanetaryKIndexSchema.parse(fixture);
    const first = parsed[0];
    if (first === undefined) throw new Error("empty fixture");

    expect(first.time_tag.toISOString()).toBe(`${raw[0]?.time_tag}.000Z`);
  });

  it("keeps Kp within its defined 0-9 range", () => {
    for (const entry of noaaPlanetaryKIndexSchema.parse(fixture)) {
      expect(entry.Kp).toBeGreaterThanOrEqual(0);
      expect(entry.Kp).toBeLessThanOrEqual(9);
    }
  });

  it("rejects an out-of-range Kp rather than passing it through", () => {
    expect(() =>
      noaaPlanetaryKIndexSchema.parse([
        { time_tag: "2026-08-24T00:00:00", Kp: 42, a_running: 9, station_count: 8 },
      ]),
    ).toThrow();
  });
});

describe("NOAA propagated solar wind", () => {
  const fixture = loadFixture("noaa-propagated-solar-wind.json");

  it("parses the real header-row response", () => {
    const samples = parseNoaaSolarWind(fixture);
    expect(samples.length).toBeGreaterThan(0);
  });

  it("decodes physically plausible solar wind values", () => {
    const samples = parseNoaaSolarWind(fixture);
    for (const sample of samples) {
      // Solar wind speed is typically 250-800 km/s; extreme events reach ~2000.
      if (sample.speed !== undefined) {
        expect(sample.speed).toBeGreaterThan(100);
        expect(sample.speed).toBeLessThan(3000);
      }
      // IMF magnitude at 1 AU is a few nT, tens during a strong event.
      if (sample.bt !== undefined) {
        expect(Math.abs(sample.bt)).toBeLessThan(200);
      }
    }
  });

  it("reads timestamps as UTC", () => {
    const samples = parseNoaaSolarWind(fixture);
    const first = samples[0];
    if (first === undefined) throw new Error("empty fixture");
    expect(first.timeTag.getTime()).toBeGreaterThan(Date.UTC(2020, 0, 1));
  });

  it("refuses to guess when the column order changes", () => {
    // Guards against silently swapping speed and density if NOAA reorders columns.
    const reordered = [
      ["time_tag", "density", "speed", "temperature", "bx", "by", "bz", "bt", "vx", "vy", "vz", "propagated_time_tag"],
      ["2026-08-31T11:31:00Z", 3.01, 428.1, 112946, -3.37, -2.71, 1.18, 4.58, -424.7, 26.3, -46.7, "2026-08-31T12:22:59Z"],
    ];
    expect(() => parseNoaaSolarWind(reordered)).toThrow(/column 1/);
  });
});

describe("NOAA scales", () => {
  const fixture = loadFixture("noaa-scales.json");

  it("parses the real response", () => {
    const parsed = noaaScalesSchema.parse(fixture);
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
  });

  it("exposes current conditions under the string key '0'", () => {
    const parsed = noaaScalesSchema.parse(fixture);
    const current = parsed["0"];
    expect(current).toBeDefined();
    expect(current?.DateStamp).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // R/S/G scale values are strings or null upstream, never numbers.
    expect(["string", "object"]).toContain(typeof current?.G.Scale);
  });

  it("tolerates null scale values in the forecast entries", () => {
    // Forecast days legitimately carry null Scale with only probabilities set.
    const parsed = noaaScalesSchema.parse(fixture);
    expect(() => noaaScalesSchema.parse(parsed)).not.toThrow();
  });
});

describe("Launch Library 2", () => {
  const fixture = loadFixture("launch-library-upcoming.json");

  it("parses the real paginated response", () => {
    const parsed = launchListResponseSchema.parse(fixture);
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.results.length).toBeGreaterThan(0);
  });

  it("normalises launches into typed summaries", () => {
    const summaries = toLaunchSummaries(fixture);
    expect(summaries.length).toBeGreaterThan(0);

    for (const summary of summaries) {
      expect(summary.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(summary.name.length).toBeGreaterThan(0);
      expect(Number.isNaN(summary.net.getTime())).toBe(false);
    }
  });

  it("preserves net_precision so the UI does not overstate certainty", () => {
    // A launch known only to the month must not be rendered with a second-accurate
    // countdown; keeping the precision is what makes that possible.
    const summaries = toLaunchSummaries(fixture);
    expect(summaries.some((s) => s.netPrecision !== undefined)).toBe(true);
  });

  it("rejects a response whose envelope is missing", () => {
    expect(() => launchListResponseSchema.parse({ results: [] })).toThrow();
  });
});

describe("Launch Library 2 detailed mode", () => {
  const fixture = loadFixture("launch-library-upcoming-detailed.json");

  it("parses the real detailed response", () => {
    const parsed = launchDetailedResponseSchema.parse(fixture);
    expect(parsed.results.length).toBeGreaterThan(0);
  });

  it("exposes the fields list mode omits", () => {
    // The whole point of verifying detailed mode: these four are absent from
    // mode=list, and the launches UI depends on all of them.
    const details = toLaunchDetails(fixture);
    expect(details.length).toBeGreaterThan(0);

    for (const detail of details) {
      expect(detail.providerName).toBeDefined();
      expect(detail.rocketName).toBeDefined();
      expect(detail.padName).toBeDefined();
      expect(detail.missionName).toBeDefined();
    }
  });

  it("reads launch_service_provider.type as an object, not a string", () => {
    // LL2 2.3.0 returns {id, name} here. Older versions returned a bare string, and
    // treating the object as one renders "[object Object]" in the UI.
    const raw = fixture as { results: { launch_service_provider: { type: unknown } }[] };
    expect(typeof raw.results[0]?.launch_service_provider.type).toBe("object");

    const details = toLaunchDetails(fixture);
    expect(details[0]?.providerType).toBe("Commercial");
  });

  it("yields usable pad coordinates for the launch-site layer", () => {
    const details = toLaunchDetails(fixture);
    for (const detail of details) {
      if (detail.padCoordinates === undefined) continue;
      expect(detail.padCoordinates.latitude).toBeGreaterThanOrEqual(-90);
      expect(detail.padCoordinates.latitude).toBeLessThanOrEqual(90);
      expect(detail.padCoordinates.longitude).toBeGreaterThanOrEqual(-180);
      expect(detail.padCoordinates.longitude).toBeLessThanOrEqual(180);
    }
    expect(details.some((d) => d.padCoordinates !== undefined)).toBe(true);
  });

  it("tolerates a null mission", () => {
    // LL2 legitimately returns null mission for some launches; the UI must not crash.
    const withNullMission = {
      ...(fixture as { count: number; next: null; previous: null; results: unknown[] }),
      results: [
        {
          ...((fixture as { results: Record<string, unknown>[] }).results[0] ?? {}),
          mission: null,
        },
      ],
    };
    const details = toLaunchDetails(withNullMission);
    expect(details[0]?.missionName).toBeUndefined();
    expect(details[0]?.rocketName).toBeDefined();
  });
});

describe("WhereTheISS.at", () => {
  const fixture = loadFixture("wheretheiss-iss.json");

  it("parses the real response", () => {
    const parsed = whereTheIssSchema.parse(fixture);
    expect(parsed.id).toBe(25544);
    expect(parsed.units).toBe("kilometers");
  });

  it("converts velocity from km/h to km/s", () => {
    // The raw value is ~27530 km/h. Treating it as km/s would be a 3600x error, and
    // would make the ISS appear to move at nearly 10% of light speed.
    const raw = fixture as { velocity: number };
    expect(raw.velocity).toBeGreaterThan(20000);

    const crossCheck = toIssCrossCheck(fixture);
    expect(crossCheck.speedKmPerSecond).toBeCloseTo(raw.velocity / 3600, 9);
    // Sanity: LEO orbital speed.
    expect(crossCheck.speedKmPerSecond).toBeGreaterThan(7.4);
    expect(crossCheck.speedKmPerSecond).toBeLessThan(7.9);
  });

  it("converts the unix-seconds timestamp to a real date", () => {
    const raw = fixture as { timestamp: number };
    const crossCheck = toIssCrossCheck(fixture);
    expect(crossCheck.time.getTime()).toBe(raw.timestamp * 1000);
    // Seconds mistaken for milliseconds would land in 1970.
    expect(crossCheck.time.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it("reports an ISS altitude consistent with its real orbit", () => {
    const crossCheck = toIssCrossCheck(fixture);
    expect(crossCheck.altitudeKm).toBeGreaterThan(370);
    expect(crossCheck.altitudeKm).toBeLessThan(470);
  });

  it("refuses the miles unit rather than converting untested", () => {
    expect(() => toIssCrossCheck({ ...(fixture as object), units: "miles" })).toThrow(
      /only "kilometers"/,
    );
  });
});
