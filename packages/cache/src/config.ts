import { z } from "zod";

import { LayeredCache, MemoryCacheDriver } from "./index.js";
import { UpstashCacheDriver } from "./upstash.js";

/**
 * Cache configuration.
 *
 * Deliberately OPTIONAL. The application must start and work without a shared cache:
 * a missing Redis should degrade throughput, not availability. When credentials are
 * absent the cache runs L1-only and `hasSharedLayer` reports false, which the health
 * endpoint surfaces honestly rather than pretending everything is configured.
 */

const cacheConfigSchema = z.object({
  /** Upstash REST endpoint, e.g. https://<name>-<id>.upstash.io */
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  /** Upstash REST token. Server-side only; never expose to a browser or app bundle. */
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
  /** L1 lifetime in milliseconds. Short by design; L2 is the real cache. */
  CACHE_L1_TTL_MS: z.coerce.number().int().positive().default(5_000),
  /** Namespace prefix, so several environments can share one Redis safely. */
  CACHE_NAMESPACE: z.string().default("ow"),
});

export type CacheConfig = z.infer<typeof cacheConfigSchema>;

export function loadCacheConfig(env: NodeJS.ProcessEnv = process.env): CacheConfig {
  const parsed = cacheConfigSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${String(issue.path[0])}: ${issue.message}`)
      .join("; ");
    // Names only, never values: a malformed token must not be echoed into a log.
    throw new Error(`Cache configuration is invalid. ${details}`);
  }
  return parsed.data;
}

/**
 * Build a cache from the environment.
 *
 * Both Upstash variables must be present together; one without the other is a
 * misconfiguration worth reporting rather than silently ignoring, because the operator
 * clearly intended a shared cache and will not get one.
 */
export function createCacheFromEnv(env: NodeJS.ProcessEnv = process.env): LayeredCache {
  const config = loadCacheConfig(env);

  const hasUrl = config.UPSTASH_REDIS_REST_URL !== undefined;
  const hasToken = config.UPSTASH_REDIS_REST_TOKEN !== undefined;

  if (hasUrl !== hasToken) {
    throw new Error(
      "Upstash is partially configured: UPSTASH_REDIS_REST_URL and " +
        "UPSTASH_REDIS_REST_TOKEN must both be set, or both be absent.",
    );
  }

  if (!hasUrl || !hasToken) {
    // L1-only. Correct and supported, not a fallback hack.
    return new LayeredCache({
      l1TtlMs: config.CACHE_L1_TTL_MS,
      namespace: config.CACHE_NAMESPACE,
    });
  }

  return new LayeredCache({
    driver: new UpstashCacheDriver({
      restUrl: config.UPSTASH_REDIS_REST_URL as string,
      restToken: config.UPSTASH_REDIS_REST_TOKEN as string,
    }),
    l1TtlMs: config.CACHE_L1_TTL_MS,
    namespace: config.CACHE_NAMESPACE,
  });
}

/** A cache backed by an in-process driver, for tests and local development. */
export function createMemoryCache(options: { now?: () => number } = {}): LayeredCache {
  return new LayeredCache({
    driver: new MemoryCacheDriver(options.now === undefined ? {} : { now: options.now }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/** Whether a shared cache is configured, without constructing one. */
export function hasSharedCacheConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    typeof env["UPSTASH_REDIS_REST_URL"] === "string" &&
    typeof env["UPSTASH_REDIS_REST_TOKEN"] === "string"
  );
}
