import type { HealthResponse } from "@orbitwatch/contracts";
import type { FastifyInstance } from "fastify";

import { safeDetail } from "../redact.js";
import type { ApiContext } from "../server.js";

/**
 * Health endpoints.
 *
 * Two distinct questions, deliberately not merged:
 *
 *   /health       Is this process serving correctly, including its dependencies?
 *                 Always 200 so a monitor can read the body; the body says the truth.
 *   /health/ready Should a load balancer send traffic here? Status code carries the
 *                 answer, because that is what orchestrators actually read.
 *
 * The distinction that matters most in this file: **configured** and **healthy** are
 * separate facts. An unconfigured shared cache is a supported deployment, not a fault.
 * Reporting it as unhealthy would teach operators to ignore this endpoint, which is how
 * a real outage gets missed.
 */

/** A dependency probe must never hang the health check itself. */
const PROBE_TIMEOUT_MS = 2000;

async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return { ok: true, value };
  } catch (error) {
    // Redacted here, at the boundary: a driver's connection error frequently contains
    // the DSN, password included, and this string is served to clients.
    return { ok: false, reason: safeDetail(error) ?? "unreachable" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  context: ApiContext,
): Promise<void> {
  const buildHealth = async (): Promise<HealthResponse> => {
    const databaseProbe = await withTimeout(
      () => context.database.ping(),
      PROBE_TIMEOUT_MS,
    );

    const cacheConfigured = context.cache.hasSharedLayer;
    const cacheProbe = cacheConfigured
      ? await withTimeout(() => context.cache.ping(), PROBE_TIMEOUT_MS)
      : undefined;

    const database = databaseProbe.ok
      ? { configured: true, healthy: true, latencyMs: databaseProbe.value }
      : { configured: true, healthy: false, detail: databaseProbe.reason };

    const cache = !cacheConfigured
      ? {
          configured: false,
          // Running L1-only is correct and supported, so it is not a failure. The
          // deployment is simply smaller than it could be.
          healthy: true,
          detail: "No shared cache configured; running with the in-process layer only.",
        }
      : cacheProbe?.ok === true
        ? { configured: true, healthy: true, latencyMs: cacheProbe.value ?? 0 }
        : {
            configured: true,
            healthy: false,
            detail: cacheProbe?.reason ?? "unreachable",
          };

    // The database is the durable record. Without it there is nothing honest to serve,
    // so it alone decides unhealthy; a failed cache only degrades.
    const status: HealthResponse["status"] = !database.healthy
      ? "unhealthy"
      : cache.healthy && cache.configured
        ? "ok"
        : "degraded";

    const nowMs = context.now().getTime();

    return {
      status,
      time: new Date(nowMs).toISOString(),
      uptimeSeconds: Math.max(0, (nowMs - context.startedAt.getTime()) / 1000),
      version: context.version,
      dependencies: { database, cache },
    };
  };

  /**
   * Always 200, even when unhealthy.
   *
   * A monitor needs to read the body to learn WHAT is broken. Returning 503 here would
   * make many HTTP clients discard it, leaving the operator with "the check failed" and
   * no idea why.
   */
  app.get("/health", async () => buildHealth());

  /**
   * Readiness. The status code is the answer.
   *
   * Degraded still means ready: an API serving correctly without a shared cache should
   * absolutely receive traffic, and pulling it from the pool would turn a performance
   * concern into an outage.
   */
  app.get("/health/ready", async (_request, reply) => {
    const health = await buildHealth();
    return reply.status(health.status === "unhealthy" ? 503 : 200).send(health);
  });

  /** Liveness: is the process running at all? No dependencies are touched. */
  app.get("/health/live", async () => ({ status: "ok" as const }));
}
