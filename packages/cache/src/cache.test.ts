import { describe, expect, it, vi } from "vitest";

import { LayeredCache, MemoryCacheDriver } from "./index.js";
import { UpstashCacheDriver, UpstashError } from "./upstash.js";
import { createCacheFromEnv, hasSharedCacheConfig } from "./config.js";

describe("LayeredCache", () => {
  const build = (nowRef: { value: number }) =>
    new LayeredCache({
      driver: new MemoryCacheDriver({ now: () => nowRef.value }),
      now: () => nowRef.value,
      l1TtlMs: 1_000,
    });

  it("stores and retrieves a value", async () => {
    const now = { value: 1_000_000 };
    const cache = build(now);
    await cache.set("k", { hello: "world" }, { freshSeconds: 60 });

    const entry = await cache.get<{ hello: string }>("k");
    expect(entry?.value).toEqual({ hello: "world" });
    expect(entry?.stale).toBe(false);
  });

  it("reports a miss for an unknown key", async () => {
    const cache = build({ value: 0 });
    expect(await cache.get("absent")).toBeUndefined();
  });

  it("marks a value stale past its freshness window but still serves it", async () => {
    // The behaviour the product depends on: three-hour-old elements are still useful,
    // and the UI says so rather than showing an error.
    const now = { value: 1_000_000 };
    const cache = build(now);
    await cache.set("k", "value", { freshSeconds: 60, staleSeconds: 3_600 });

    now.value += 120_000;
    const entry = await cache.get<string>("k");

    expect(entry?.value).toBe("value");
    expect(entry?.stale).toBe(true);
  });

  it("drops a value once the stale window also expires", async () => {
    const now = { value: 1_000_000 };
    const cache = build(now);
    await cache.set("k", "value", { freshSeconds: 60, staleSeconds: 60 });

    now.value += 121_000;
    expect(await cache.get("k")).toBeUndefined();
  });

  it("serves from L1 without touching the shared layer", async () => {
    const now = { value: 1_000_000 };
    const driver = new MemoryCacheDriver({ now: () => now.value });
    const spy = vi.spyOn(driver, "get");
    const cache = new LayeredCache({ driver, now: () => now.value, l1TtlMs: 5_000 });

    await cache.set("k", "v", { freshSeconds: 60 });
    await cache.get("k");
    await cache.get("k");

    // Both reads hit L1, which is the point: a burst of identical requests should
    // cost one network round trip at most.
    expect(spy).not.toHaveBeenCalled();
  });

  it("falls through to the shared layer once L1 expires", async () => {
    const now = { value: 1_000_000 };
    const driver = new MemoryCacheDriver({ now: () => now.value });
    const cache = new LayeredCache({ driver, now: () => now.value, l1TtlMs: 1_000 });

    await cache.set("k", "v", { freshSeconds: 600 });
    now.value += 2_000;

    const entry = await cache.get<string>("k");
    expect(entry?.value).toBe("v");
    expect(entry?.layer).toBe("l2");
  });

  it("computes on a miss and caches the result", async () => {
    const cache = build({ value: 0 });
    const compute = vi.fn(async () => "computed");

    const first = await cache.readThrough("k", { freshSeconds: 60 }, compute);
    const second = await cache.readThrough("k", { freshSeconds: 60 }, compute);

    expect(first.value).toBe("computed");
    expect(second.value).toBe("computed");
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("returns stale data immediately and revalidates in the background", async () => {
    const now = { value: 1_000_000 };
    const cache = build(now);
    let version = 1;
    const compute = async () => `v${version}`;

    await cache.readThrough("k", { freshSeconds: 60, staleSeconds: 600 }, compute);
    now.value += 120_000;
    version = 2;

    // The user gets the stale value without waiting for the upstream fetch.
    const stale = await cache.readThrough(
      "k",
      { freshSeconds: 60, staleSeconds: 600 },
      compute,
    );
    expect(stale.value).toBe("v1");
    expect(stale.stale).toBe(true);

    await vi.waitFor(async () => {
      const refreshed = await cache.get<string>("k");
      expect(refreshed?.value).toBe("v2");
    });
  });

  it("keeps stale data when revalidation fails", async () => {
    // Last-known-good: an upstream outage must not remove data we already hold.
    const now = { value: 1_000_000 };
    const cache = build(now);

    await cache.readThrough("k", { freshSeconds: 60, staleSeconds: 600 }, async () => "good");
    now.value += 120_000;

    const result = await cache.readThrough(
      "k",
      { freshSeconds: 60, staleSeconds: 600 },
      async () => {
        throw new Error("upstream down");
      },
    );

    expect(result.value).toBe("good");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await cache.get<string>("k"))?.value).toBe("good");
  });

  it("survives a shared-layer outage without failing the request", async () => {
    // A cache outage must never become an application outage.
    const driver = new MemoryCacheDriver();
    vi.spyOn(driver, "get").mockRejectedValue(new Error("redis unreachable"));
    vi.spyOn(driver, "set").mockRejectedValue(new Error("redis unreachable"));
    const cache = new LayeredCache({ driver, l1TtlMs: 0 });

    await expect(cache.set("k", "v", { freshSeconds: 60 })).resolves.toBeUndefined();
    expect(await cache.get("k")).toBeUndefined();

    const result = await cache.readThrough("k", { freshSeconds: 60 }, async () => "fresh");
    expect(result.value).toBe("fresh");
  });

  it("works with no shared layer at all", async () => {
    // The app must run before Upstash is configured.
    const cache = new LayeredCache({ l1TtlMs: 10_000 });
    expect(cache.hasSharedLayer).toBe(false);

    await cache.set("k", "v", { freshSeconds: 60 });
    expect((await cache.get<string>("k"))?.value).toBe("v");
    expect(await cache.ping()).toBeUndefined();
  });

  it("namespaces keys so environments can share one store", async () => {
    const driver = new MemoryCacheDriver();
    const staging = new LayeredCache({ driver, namespace: "staging", l1TtlMs: 0 });
    const production = new LayeredCache({ driver, namespace: "prod", l1TtlMs: 0 });

    await staging.set("catalog", "staging-data", { freshSeconds: 60 });
    expect(await production.get("catalog")).toBeUndefined();
  });

  it("ignores a corrupt cached envelope rather than throwing", async () => {
    const driver = new MemoryCacheDriver();
    await driver.set("ow:k", "not json", 60);
    const cache = new LayeredCache({ driver, l1TtlMs: 0 });

    expect(await cache.get("k")).toBeUndefined();
  });

  it("tracks hit, miss and stale counts", async () => {
    const now = { value: 1_000_000 };
    const cache = build(now);

    await cache.get("absent");
    await cache.set("k", "v", { freshSeconds: 60, staleSeconds: 600 });
    await cache.get("k");
    now.value += 120_000;
    await cache.get("k");

    expect(cache.stats.misses).toBe(1);
    expect(cache.stats.hits).toBe(2);
    expect(cache.stats.staleHits).toBe(1);
  });
});

describe("UpstashCacheDriver", () => {
  const okResponse = (result: unknown) =>
    new Response(JSON.stringify({ result }), { status: 200 });

  it("sends the token as a bearer header", async () => {
    const fetchImpl = vi.fn(async () => okResponse("stored"));
    const driver = new UpstashCacheDriver({
      restUrl: "https://example.upstash.io/",
      restToken: "secret-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await driver.get("k");

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-token");
  });

  it("sets an expiry atomically with the write", async () => {
    // A separate EXPIRE would leave a window where a crash produces a key that
    // never expires.
    const fetchImpl = vi.fn(async () => okResponse("OK"));
    const driver = new UpstashCacheDriver({
      restUrl: "https://example.upstash.io",
      restToken: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await driver.set("k", "v", 90);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(["SET", "k", "v", "EX", "90"]);
  });

  it("maps a null result to undefined", async () => {
    const driver = new UpstashCacheDriver({
      restUrl: "https://example.upstash.io",
      restToken: "t",
      fetchImpl: (async () => okResponse(null)) as unknown as typeof fetch,
    });
    expect(await driver.get("missing")).toBeUndefined();
  });

  it("never leaks the token into an error message", async () => {
    // If a credential reaches a log store it is effectively public and must be
    // rotated, so error text is scrubbed before it can escape.
    const token = "super-secret-token";
    const driver = new UpstashCacheDriver({
      restUrl: "https://example.upstash.io",
      restToken: token,
      fetchImpl: (async () =>
        new Response(`unauthorized for ${token}`, { status: 401 })) as unknown as typeof fetch,
    });

    await expect(driver.get("k")).rejects.toThrow(UpstashError);
    await expect(driver.get("k")).rejects.toThrow(/\[REDACTED\]/);
    await driver.get("k").catch((error: unknown) => {
      expect(String(error)).not.toContain(token);
    });
  });

  it("rejects a response with no result field", async () => {
    const driver = new UpstashCacheDriver({
      restUrl: "https://example.upstash.io",
      restToken: "t",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ unexpected: true }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(driver.get("k")).rejects.toThrow(/result field/);
  });
});

describe("cache configuration", () => {
  it("runs L1-only when Upstash is not configured", () => {
    const cache = createCacheFromEnv({});
    expect(cache.hasSharedLayer).toBe(false);
    expect(hasSharedCacheConfig({})).toBe(false);
  });

  it("uses Upstash when both variables are present", () => {
    const cache = createCacheFromEnv({
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "token",
    });
    expect(cache.hasSharedLayer).toBe(true);
  });

  it("rejects partial Upstash configuration", () => {
    // Half-configured means the operator wanted a shared cache and will not get one;
    // failing loudly beats silently running L1-only in production.
    expect(() =>
      createCacheFromEnv({ UPSTASH_REDIS_REST_URL: "https://example.upstash.io" }),
    ).toThrow(/partially configured/);

    expect(() => createCacheFromEnv({ UPSTASH_REDIS_REST_TOKEN: "token" })).toThrow(
      /partially configured/,
    );
  });

  it("treats empty variables as absent, not as invalid configuration", () => {
    // `cp .env.example .env.local` produces exactly this, and it used to crash the API
    // at boot: the optional shared cache had effectively become mandatory. Caught by
    // starting the real server rather than by any test that injected a cache directly.
    const env = { UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" };

    expect(() => createCacheFromEnv(env)).not.toThrow();
    expect(createCacheFromEnv(env).hasSharedLayer).toBe(false);
    expect(hasSharedCacheConfig(env)).toBe(false);
  });

  it("treats one empty and one set variable as partial configuration", () => {
    // Still an operator mistake worth reporting: they clearly intended a shared cache.
    expect(() =>
      createCacheFromEnv({
        UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "",
      }),
    ).toThrow(/partially configured/);
  });

  it("rejects a malformed URL without echoing the value", () => {
    let message = "";
    try {
      createCacheFromEnv({
        UPSTASH_REDIS_REST_URL: "not-a-url",
        UPSTASH_REDIS_REST_TOKEN: "super-secret",
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/UPSTASH_REDIS_REST_URL/);
    expect(message).not.toContain("super-secret");
  });
});
