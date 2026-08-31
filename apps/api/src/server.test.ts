import { createMemoryCache, LayeredCache, type CacheDriver } from "@orbitwatch/cache";
import {
  elementHistoryResponseSchema,
  elementsResponseSchema,
  healthResponseSchema,
  providerStatusResponseSchema,
  satelliteListResponseSchema,
  catalogElementsResponseSchema,
} from "@orbitwatch/contracts";
import { InMemoryDatabase } from "@orbitwatch/database";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "./server.js";

/**
 * API surface tests.
 *
 * Run against `InMemoryDatabase` through Fastify's `inject()`: no network, no database,
 * no credentials. Every response is validated against the shared contract schema, so a
 * server change that breaks the web or mobile client fails here rather than on a device.
 */

const NOW = new Date("2026-03-01T12:00:00.000Z");

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

const SATELLITE = {
  catalogId: "25544",
  name: "ISS (ZARYA)",
  internationalDesignator: "1998-067A",
  objectType: "PAYLOAD" as const,
  operationalStatus: "OPERATIONAL",
  owner: "CIS",
  launchDate: new Date("1998-11-20T00:00:00.000Z"),
  launchSite: "TTMTR",
  decayDate: undefined,
  periodMinutes: 92.9,
  inclinationDegrees: 51.64,
  apogeeKm: 421,
  perigeeKm: 415,
  rcsSquareMetres: 399.05,
  orbitClass: "LEO" as const,
  metadata: { SECRET_INTERNAL_FIELD: "must not be served" },
  sourceProvider: "celestrak",
  updatedAt: NOW,
};

function elementSet(epoch: Date, overrides: Record<string, unknown> = {}) {
  return {
    catalogId: "25544",
    provider: "celestrak",
    format: "OMM_JSON" as const,
    epoch,
    retrievedAt: epoch,
    omm: { OBJECT_NAME: "ISS (ZARYA)" },
    tleLine1: undefined,
    tleLine2: undefined,
    meanMotion: 15.5,
    eccentricity: 0.0006,
    inclination: 51.64,
    bstar: 0.00012,
    ...overrides,
  };
}

describe("OrbitWatch API", () => {
  let app: FastifyInstance;
  let database: InMemoryDatabase;

  beforeEach(async () => {
    database = new InMemoryDatabase({ now: () => NOW });
    app = await buildServer({
      database,
      cache: createMemoryCache(),
      now: () => NOW,
      version: "test",
      rateLimitPerMinute: 10_000,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  // ── health ───────────────────────────────────────────────────────────────

  describe("health", () => {
    it("reports ok when everything is configured and reachable", async () => {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      const body = healthResponseSchema.parse(response.json());
      expect(body.status).toBe("ok");
      expect(body.dependencies.database.healthy).toBe(true);
      expect(body.dependencies.cache.configured).toBe(true);
      expect(body.version).toBe("test");
    });

    it("reports degraded, not unhealthy, without a shared cache", async () => {
      // Running L1-only is a supported deployment. Calling it unhealthy would train
      // operators to ignore this endpoint.
      const l1Only = await buildServer({
        database,
        cache: new LayeredCache(),
        now: () => NOW,
      });

      const body = healthResponseSchema.parse(
        (await l1Only.inject({ method: "GET", url: "/health" })).json(),
      );
      expect(body.status).toBe("degraded");
      expect(body.dependencies.cache.configured).toBe(false);
      expect(body.dependencies.cache.healthy).toBe(true);

      await l1Only.close();
    });

    it("reports unhealthy and 503 from readiness when the database is down", async () => {
      const broken = new InMemoryDatabase({ now: () => NOW });
      Object.defineProperty(broken, "ping", {
        value: async () => {
          throw new Error("connection refused");
        },
      });

      const server = await buildServer({
        database: broken,
        cache: createMemoryCache(),
        now: () => NOW,
      });

      const health = await server.inject({ method: "GET", url: "/health" });
      // Still 200: a monitor must be able to read the body to learn WHAT is broken.
      expect(health.statusCode).toBe(200);
      expect(healthResponseSchema.parse(health.json()).status).toBe("unhealthy");

      const ready = await server.inject({ method: "GET", url: "/health/ready" });
      expect(ready.statusCode).toBe(503);

      await server.close();
    });

    it("does not leak a connection string when the database is unreachable", async () => {
      const broken = new InMemoryDatabase({ now: () => NOW });
      Object.defineProperty(broken, "ping", {
        value: async () => {
          throw new Error(
            "getaddrinfo ENOTFOUND postgresql://postgres:hunter2@db.example.supabase.co:5432",
          );
        },
      });

      const server = await buildServer({
        database: broken,
        cache: createMemoryCache(),
        now: () => NOW,
      });
      const body = JSON.stringify((await server.inject({ url: "/health" })).json());

      // The driver message is echoed as a detail, so it must not be able to carry a
      // password. This asserts the guarantee the health contract makes.
      expect(body).not.toContain("hunter2");

      await server.close();
    });

    it("answers liveness without touching dependencies", async () => {
      const response = await app.inject({ method: "GET", url: "/health/live" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
    });
  });

  // ── satellites ───────────────────────────────────────────────────────────

  describe("satellites", () => {
    beforeEach(async () => {
      await database.satellites.upsertMany([
        SATELLITE,
        {
          ...SATELLITE,
          catalogId: "44713",
          name: "STARLINK-1007",
          owner: "US",
          objectType: "PAYLOAD",
        },
        {
          ...SATELLITE,
          catalogId: "00900",
          name: "SPENT UPPER STAGE",
          objectType: "ROCKET BODY",
          owner: "US",
        },
        {
          ...SATELLITE,
          catalogId: "11111",
          name: "DECAYED OBJECT",
          decayDate: new Date("2020-01-01T00:00:00.000Z"),
        },
      ]);
    });

    it("lists the catalog, excluding decayed objects by default", async () => {
      const response = await app.inject({ method: "GET", url: "/satellites" });

      expect(response.statusCode).toBe(200);
      const body = satelliteListResponseSchema.parse(response.json());
      expect(body.total).toBe(3);
      expect(body.satellites.map((s) => s.catalogId)).not.toContain("11111");
    });

    it("includes decayed objects on request", async () => {
      const body = satelliteListResponseSchema.parse(
        (await app.inject({ url: "/satellites?includeDecayed=true" })).json(),
      );
      expect(body.total).toBe(4);
    });

    it("never serves internal storage fields", async () => {
      const body = satelliteListResponseSchema.parse(
        (await app.inject({ url: "/satellites" })).json(),
      );
      const raw = JSON.stringify(body);

      // Provider passthrough metadata is unvalidated and internal. Serialising storage
      // rows directly is how such fields escape.
      expect(raw).not.toContain("SECRET_INTERNAL_FIELD");
      expect(raw).not.toContain("sourceProvider");
    });

    it("searches by name", async () => {
      const body = satelliteListResponseSchema.parse(
        (await app.inject({ url: "/satellites?search=starlink" })).json(),
      );
      expect(body.satellites.map((s) => s.catalogId)).toEqual(["44713"]);
    });

    it("filters by repeated object type parameters", async () => {
      const body = satelliteListResponseSchema.parse(
        (await app.inject({ url: "/satellites?objectType=ROCKET%20BODY" })).json(),
      );
      expect(body.satellites.map((s) => s.catalogId)).toEqual(["00900"]);
    });

    it("reports the total independently of the page size", async () => {
      const body = satelliteListResponseSchema.parse(
        (await app.inject({ url: "/satellites?limit=1" })).json(),
      );
      expect(body.satellites).toHaveLength(1);
      // The total must describe the filter, not the page, or pagination controls lie.
      expect(body.total).toBe(3);
      expect(body.limit).toBe(1);
    });

    it("rejects a page size beyond the maximum", async () => {
      const response = await app.inject({ url: "/satellites?limit=100000" });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_REQUEST");
    });

    it("returns one satellite by catalog id", async () => {
      const response = await app.inject({ url: "/satellites/25544" });
      expect(response.statusCode).toBe(200);
      expect(response.json().satellite.name).toBe("ISS (ZARYA)");
    });

    it("returns 404 for an unknown catalog id", async () => {
      const response = await app.inject({ url: "/satellites/99999" });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("SATELLITE_NOT_FOUND");
    });

    it("rejects a malformed catalog id", async () => {
      const response = await app.inject({ url: "/satellites/..%2Fetc" });
      expect(response.statusCode).toBe(400);
    });
  });

  // ── elements ─────────────────────────────────────────────────────────────

  describe("elements", () => {
    beforeEach(async () => {
      await database.satellites.upsertMany([SATELLITE]);
    });

    it("serves the latest elements with a nominal accuracy assessment", async () => {
      await database.elements.insertMany([elementSet(hoursAgo(2))]);

      const response = await app.inject({ url: "/satellites/25544/elements" });
      expect(response.statusCode).toBe(200);

      const body = elementsResponseSchema.parse(response.json());
      expect(body.elements.epoch).toBe(hoursAgo(2).toISOString());
      expect(body.accuracy.confidence).toBe("NOMINAL");
      expect(body.accuracy.renderable).toBe(true);
      expect(body.accuracy.hoursFromEpoch).toBeCloseTo(2, 6);
    });

    it("keeps epoch and retrieval time as separate facts", async () => {
      // Elements retrieved minutes ago can describe an orbit from many hours ago.
      // Conflating the two is the commonest way a tracker misrepresents its liveness.
      await database.elements.insertMany([
        elementSet(hoursAgo(18), { retrievedAt: hoursAgo(0.5) }),
      ]);

      const body = elementsResponseSchema.parse(
        (await app.inject({ url: "/satellites/25544/elements" })).json(),
      );
      expect(body.elements.epoch).toBe(hoursAgo(18).toISOString());
      expect(body.elements.retrievedAt).toBe(hoursAgo(0.5).toISOString());
      expect(body.elements.epoch).not.toBe(body.elements.retrievedAt);
    });

    it("downgrades confidence for a stale element set", async () => {
      await database.elements.insertMany([elementSet(hoursAgo(24 * 5))]);

      const body = elementsResponseSchema.parse(
        (await app.inject({ url: "/satellites/25544/elements" })).json(),
      );
      // LEO decays fastest; five days from epoch is well past nominal.
      expect(body.accuracy.confidence).toBe("EXTRAPOLATED");
      expect(body.accuracy.warning).toBeDefined();
    });

    it("marks a wildly extrapolated position as not renderable", async () => {
      await database.elements.insertMany([elementSet(hoursAgo(24 * 400))]);

      const body = elementsResponseSchema.parse(
        (await app.inject({ url: "/satellites/25544/elements" })).json(),
      );
      expect(body.accuracy.confidence).toBe("UNRELIABLE");
      // An authoritative-looking wrong position is worse than an honest gap.
      expect(body.accuracy.renderable).toBe(false);
    });

    it("uses the element set current at the replayed time, not the newest", async () => {
      await database.elements.insertMany([
        elementSet(hoursAgo(48)),
        elementSet(hoursAgo(24)),
        elementSet(hoursAgo(1)),
      ]);

      const at = hoursAgo(20).toISOString();
      const body = elementsResponseSchema.parse(
        (
          await app.inject({
            url: `/satellites/25544/elements?at=${encodeURIComponent(at)}`,
          })
        ).json(),
      );

      // Not hoursAgo(1): replaying a past moment must use what was current THEN.
      expect(body.elements.epoch).toBe(hoursAgo(24).toISOString());
      expect(body.assessedFor).toBe(at);
    });

    it("distinguishes no-such-object from no-data-for-that-time", async () => {
      await database.elements.insertMany([elementSet(hoursAgo(1))]);

      const tooEarly = hoursAgo(100).toISOString();
      const response = await app.inject({
        url: `/satellites/25544/elements?at=${encodeURIComponent(tooEarly)}`,
      });

      expect(response.statusCode).toBe(404);
      // A client replaying history must be able to tell these apart.
      expect(response.json().error.code).toBe("ELEMENTS_NOT_FOUND");
    });

    it("rejects a malformed at parameter", async () => {
      const response = await app.inject({
        url: "/satellites/25544/elements?at=yesterday",
      });
      expect(response.statusCode).toBe(400);
    });

    it("returns history newest first", async () => {
      await database.elements.insertMany([
        elementSet(hoursAgo(48)),
        elementSet(hoursAgo(1)),
        elementSet(hoursAgo(24)),
      ]);

      const body = elementHistoryResponseSchema.parse(
        (await app.inject({ url: "/satellites/25544/elements/history" })).json(),
      );
      expect(body.history.map((entry) => entry.epoch)).toEqual([
        hoursAgo(1).toISOString(),
        hoursAgo(24).toISOString(),
        hoursAgo(48).toISOString(),
      ]);
    });

    it("serves current elements for the whole catalog", async () => {
      await database.satellites.upsertMany([{ ...SATELLITE, catalogId: "44713" }]);
      await database.elements.insertMany([
        elementSet(hoursAgo(3)),
        elementSet(hoursAgo(1)),
        elementSet(hoursAgo(2), { catalogId: "44713" }),
      ]);

      const body = catalogElementsResponseSchema.parse(
        (await app.inject({ url: "/catalog/elements" })).json(),
      );

      // One current set per object, not the whole history.
      expect(body.count).toBe(2);
      expect(body.elements.find((entry) => entry.catalogId === "25544")?.epoch).toBe(
        hoursAgo(1).toISOString(),
      );
    });
  });

  // ── providers ────────────────────────────────────────────────────────────

  describe("provider status", () => {
    it("reports never-succeeded before any ingestion has run", async () => {
      const body = providerStatusResponseSchema.parse(
        (await app.inject({ url: "/providers/status" })).json(),
      );

      const gp = body.providers.find((p) => p.provider === "celestrak-gp");
      expect(gp?.freshness).toBe("never-succeeded");
      expect(gp?.lastSuccessAt).toBeUndefined();
    });

    it("reports CelesTrak as verified", async () => {
      const body = providerStatusResponseSchema.parse(
        (await app.inject({ url: "/providers/status" })).json(),
      );

      // Verified from CI against a real production response (celestrak.org is
      // unreachable from the development network). Freshness and verification are
      // different questions and must not be conflated: this asserts only the latter.
      expect(body.providers.find((p) => p.provider === "celestrak-gp")?.verified).toBe(
        true,
      );
    });

    it("reports healthy after a recent successful run", async () => {
      const runId = await database.providerRuns.start("celestrak-gp", "group-active");
      await database.providerRuns.finish(runId, {
        status: "success",
        recordsFetched: 20_000,
        recordsInserted: 4,
      });

      const body = providerStatusResponseSchema.parse(
        (await app.inject({ url: "/providers/status" })).json(),
      );
      const gp = body.providers.find((p) => p.provider === "celestrak-gp");
      expect(gp?.freshness).toBe("healthy");
      expect(gp?.lastRun?.recordsInserted).toBe(4);
    });

    it("reports failing while still naming the last known good run", async () => {
      const good = await database.providerRuns.start("celestrak-gp", "group-active");
      await database.providerRuns.finish(good, { status: "success" });
      const bad = await database.providerRuns.start("celestrak-gp", "group-active");
      await database.providerRuns.finish(bad, {
        status: "failed",
        errorSummary: "connect ETIMEDOUT",
      });

      const body = providerStatusResponseSchema.parse(
        (await app.inject({ url: "/providers/status" })).json(),
      );
      const gp = body.providers.find((p) => p.provider === "celestrak-gp");

      // Both facts survive: it is broken now, AND there is a good state to fall back on.
      expect(gp?.freshness).toBe("failing");
      expect(gp?.lastRun?.status).toBe("failed");
      expect(gp?.lastSuccessAt).toBeDefined();
    });

    it("exposes the verification registry", async () => {
      const response = await app.inject({ url: "/providers/verification" });
      expect(response.statusCode).toBe(200);

      const providers = response.json().providers as {
        provider: string;
        status: string;
      }[];
      expect(providers.find((p) => p.provider === "noaa-swpc")?.status).toBe("VERIFIED");
      expect(providers.find((p) => p.provider === "celestrak-gp")?.status).toBe(
        "VERIFIED",
      );
    });
  });

  // ── resilience ───────────────────────────────────────────────────────────

  describe("resilience", () => {
    it("keeps serving stored elements when the cache layer is failing", async () => {
      // A cache outage must never become an application outage.
      const failing: CacheDriver = {
        get: async () => {
          throw new Error("redis unreachable");
        },
        set: async () => {
          throw new Error("redis unreachable");
        },
        delete: async () => undefined,
        ping: async () => {
          throw new Error("redis unreachable");
        },
        close: async () => undefined,
      };

      const server = await buildServer({
        database,
        cache: new LayeredCache({ driver: failing }),
        now: () => NOW,
      });

      await database.satellites.upsertMany([SATELLITE]);
      await database.elements.insertMany([elementSet(hoursAgo(1))]);

      const elements = await server.inject({ url: "/satellites/25544/elements" });
      expect(elements.statusCode).toBe(200);

      const health = healthResponseSchema.parse(
        (await server.inject({ url: "/health" })).json(),
      );
      // Reported honestly as degraded rather than hidden, but still serving.
      expect(health.status).toBe("degraded");
      expect(health.dependencies.cache.healthy).toBe(false);

      await server.close();
    });
  });

  // ── protocol ─────────────────────────────────────────────────────────────

  describe("protocol", () => {
    it("returns a structured 404 for an unknown route", async () => {
      const response = await app.inject({ url: "/no-such-route" });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("NOT_FOUND");
    });

    it("enforces the rate limit and exempts health checks", async () => {
      const limited = await buildServer({
        database,
        cache: createMemoryCache(),
        now: () => NOW,
        rateLimitPerMinute: 2,
      });

      await limited.inject({ url: "/satellites" });
      await limited.inject({ url: "/satellites" });
      const blocked = await limited.inject({ url: "/satellites" });

      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe("RATE_LIMITED");

      // A monitor being rate limited would report an outage that is not happening.
      expect((await limited.inject({ url: "/health" })).statusCode).toBe(200);

      await limited.close();
    });
  });
});
