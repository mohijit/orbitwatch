import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { InMemoryDatabase } from "@orbitwatch/database";
import { GuardedHttpClient, type GuardedFetchResult } from "@orbitwatch/providers";
import { beforeEach, describe, expect, it } from "vitest";

import { ingestSpaceWeather } from "./ingest-space-weather.js";

/**
 * Space weather ingestion, replayed through the real pipeline with real responses.
 *
 * All three fixtures are unmodified captures of production NOAA SWPC endpoints, taken
 * during M0 and recorded in `fixtures/manifest.json`. Only the network call is
 * replaced; parsing, validation, normalisation and the upsert run exactly as they do
 * in production.
 */

const repoRoot = resolve(process.cwd(), "..", "..");
const read = (name: string): string =>
  readFileSync(resolve(repoRoot, "fixtures", name), "utf8");

const BODIES: Record<string, string> = {
  "noaa-planetary-k-index.json": read("noaa-planetary-k-index.json"),
  "propagated-solar-wind-1-hour.json": read("noaa-propagated-solar-wind.json"),
  "noaa-scales.json": read("noaa-scales.json"),
};

const FETCHED_AT = new Date("2026-08-31T12:31:00.000Z");

/** Routes each product URL to its captured body. */
class FixtureHttpClient extends GuardedHttpClient {
  constructor(private readonly overrides: Record<string, string | Error> = {}) {
    super();
  }

  override get(url: string): Promise<GuardedFetchResult> {
    const key = Object.keys(BODIES).find((name) => url.includes(name.replace(".json", "")));
    const override = key === undefined ? undefined : this.overrides[key];
    if (override instanceof Error) return Promise.reject(override);

    const body = override ?? (key === undefined ? undefined : BODIES[key]);
    if (body === undefined) return Promise.reject(new Error(`No fixture for ${url}`));

    return Promise.resolve({
      status: "fetched",
      body,
      contentType: "application/json",
      fetchedAt: FETCHED_AT,
    });
  }
}

describe("ingestSpaceWeather", () => {
  let database: InMemoryDatabase;

  beforeEach(() => {
    database = new InMemoryDatabase();
  });

  it("ingests all three NOAA products from real responses", async () => {
    const result = await ingestSpaceWeather({
      database,
      http: new FixtureHttpClient(),
      holder: "test",
    });

    expect(result.status).toBe("success");
    expect(result.inserted).toBeGreaterThan(0);
    expect(Object.keys(result.sources).sort()).toEqual([
      "planetary-k-index",
      "scales",
      "solar-wind",
    ]);
  });

  it("stores the Kp series with its real values", async () => {
    await ingestSpaceWeather({ database, http: new FixtureHttpClient(), holder: "test" });

    // 2026-08-24T00:00Z reads Kp 2.33 in the captured response — a real published value.
    const window = await database.spaceWeather.since(
      "planetary-k-index",
      new Date("2026-08-24T00:00:00Z"),
    );
    expect(window.length).toBeGreaterThan(0);
    expect(window[0]?.kp).toBe(2.33);
    expect(window[0]?.observedAt.toISOString()).toBe("2026-08-24T00:00:00.000Z");

    // Ascending, because the only consumer plots it left to right.
    for (let index = 1; index < window.length; index += 1) {
      expect(window[index]!.observedAt.getTime()).toBeGreaterThan(
        window[index - 1]!.observedAt.getTime(),
      );
    }
  });

  it("records solar wind at the instant it describes conditions at Earth", async () => {
    await ingestSpaceWeather({ database, http: new FixtureHttpClient(), holder: "test" });

    const latest = await database.spaceWeather.latest("solar-wind");
    expect(latest?.solarWindSpeedKmS).toBeGreaterThan(300);
    expect(latest?.bzNt).toBeDefined();

    // The sample is propagated from the spacecraft to Earth, roughly an hour downstream.
    // Storing the raw spacecraft time would place present conditions in the past.
    expect(latest?.observedAt.getTime()).toBeGreaterThan(
      new Date("2026-08-31T12:00:00Z").getTime(),
    );
  });

  it("reads the current scales, not the forecast days", async () => {
    await ingestSpaceWeather({ database, http: new FixtureHttpClient(), holder: "test" });

    const scales = await database.spaceWeather.latest("scales");
    // Key "0" in the captured document is current conditions and reads R0/S0/G0; the
    // other keys are forecasts, which this product does not claim to make.
    expect(scales?.radioBlackoutScale).toBe(0);
    expect(scales?.solarRadiationScale).toBe(0);
    expect(scales?.geomagneticScale).toBe(0);
    expect(scales?.observedAt.toISOString()).toBe("2026-08-31T12:31:00.000Z");
  });

  it("never turns a missing scale into an all-clear", async () => {
    // NOAA sends `null` when a level is not stated, and Number(null) is 0 — which reads
    // as "none" on these scales. A missing value silently becoming an all-clear during
    // a storm is the worst outcome available in this file.
    const scales = JSON.parse(BODIES["noaa-scales.json"]!) as Record<string, unknown>;
    const current = scales["0"] as Record<string, unknown>;
    current["G"] = { Scale: null, Text: null };

    await ingestSpaceWeather({
      database,
      http: new FixtureHttpClient({ "noaa-scales.json": JSON.stringify(scales) }),
      holder: "test",
    });

    const stored = await database.spaceWeather.latest("scales");
    expect(stored?.geomagneticScale).toBeUndefined();
    expect(stored?.radioBlackoutScale).toBe(0);
  });

  it("keeps the other products when one endpoint fails", async () => {
    // Losing a whole Kp series because a solar wind endpoint returned a 500 would be
    // trading useful data for tidiness.
    const result = await ingestSpaceWeather({
      database,
      http: new FixtureHttpClient({
        "propagated-solar-wind-1-hour.json": new Error("503 Service Unavailable"),
      }),
      holder: "test",
    });

    expect(result.status).toBe("partial");
    expect(result.sources["solar-wind"]).toContain("503");
    expect(await database.spaceWeather.latest("planetary-k-index")).toBeDefined();
    expect(await database.spaceWeather.latest("solar-wind")).toBeUndefined();
  });

  it("refuses to guess when NOAA reorders the solar wind columns", async () => {
    // The header is validated rather than assumed, so a reordering surfaces here
    // instead of silently swapping speed and density.
    const rows = JSON.parse(BODIES["propagated-solar-wind-1-hour.json"]!) as unknown[][];
    const header = [...(rows[0] as string[])];
    [header[1], header[2]] = [header[2]!, header[1]!];
    const reordered = [header, ...rows.slice(1)];

    const result = await ingestSpaceWeather({
      database,
      http: new FixtureHttpClient({
        "propagated-solar-wind-1-hour.json": JSON.stringify(reordered),
      }),
      holder: "test",
    });

    expect(result.status).toBe("partial");
    expect(result.sources["solar-wind"]).toContain("column");
    expect(await database.spaceWeather.latest("solar-wind")).toBeUndefined();
  });

  it("fails only when every product fails", async () => {
    const result = await ingestSpaceWeather({
      database,
      http: new FixtureHttpClient({
        "noaa-planetary-k-index.json": new Error("down"),
        "propagated-solar-wind-1-hour.json": new Error("down"),
        "noaa-scales.json": new Error("down"),
      }),
      holder: "test",
    });

    expect(result.status).toBe("failed");
    const run = await database.providerRuns.latestAttempt("noaa-swpc", "space-weather");
    expect(run?.status).toBe("failed");
  });

  it("is idempotent: republished instants refresh rather than duplicate", async () => {
    let now = new Date("2026-08-31T12:31:00Z");
    const clocked = new InMemoryDatabase({ now: () => now });

    const first = await ingestSpaceWeather({
      database: clocked,
      http: new FixtureHttpClient(),
      holder: "test",
      now: () => now,
    });

    // NOAA's policy is five minutes; an hour later is a genuine second run.
    now = new Date("2026-08-31T13:31:00Z");
    const second = await ingestSpaceWeather({
      database: clocked,
      http: new FixtureHttpClient(),
      holder: "test",
      now: () => now,
    });

    expect(first.inserted).toBeGreaterThan(0);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(first.inserted);
  });

  it("honours the durable rate policy", async () => {
    let now = new Date("2026-08-31T12:31:00Z");
    const clocked = new InMemoryDatabase({ now: () => now });

    await ingestSpaceWeather({
      database: clocked,
      http: new FixtureHttpClient(),
      holder: "test",
      now: () => now,
    });

    now = new Date("2026-08-31T12:32:00Z");
    const second = await ingestSpaceWeather({
      database: clocked,
      http: new FixtureHttpClient(),
      holder: "test",
      now: () => now,
    });

    expect(second.status).toBe("skipped");
    expect(second.errorSummary).toContain("provider rate policy");
  });
});
