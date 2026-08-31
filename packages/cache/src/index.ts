import { z } from "zod";

/**
 * Layered cache.
 *
 * L1 is an in-process map with a short TTL: it absorbs the burst of identical requests
 * that arrive when many users load the globe at once, and costs nothing.
 * L2 is a shared store (Upstash Redis in production) so that cost is paid once across
 * every server instance rather than once per instance.
 * L3 is Postgres, which is not part of this abstraction — it is the durable record, and
 * a cache miss falls through to a repository, not to another cache.
 *
 * STALE-WHILE-REVALIDATE
 * Orbital data has an unusual property: stale data is genuinely useful. Elements from
 * three hours ago still propagate to a good position, and CelesTrak only publishes
 * every two hours anyway. So a miss on freshness is not a miss on usefulness, and the
 * cache reports staleness rather than hiding it. That is what lets the UI say
 * "using cached elements from 1h 42m ago" instead of showing an error.
 */

export interface CacheEntry<T> {
  readonly value: T;
  /** When the value was stored. */
  readonly storedAt: Date;
  /** True once past its freshness window but still within its serve window. */
  readonly stale: boolean;
  /** Which layer answered. Useful in diagnostics and the health endpoint. */
  readonly layer: "l1" | "l2";
}

export interface CacheSetOptions {
  /** Seconds the value is considered fresh. */
  readonly freshSeconds: number;
  /**
   * Additional seconds the value may still be served while stale.
   *
   * This is the outage budget: if upstream is down, how long are we willing to keep
   * showing clearly-labelled old data rather than nothing? For orbital elements the
   * honest answer is a long time.
   */
  readonly staleSeconds?: number;
}

/** Backing store for the shared layer. Implemented by Redis, or by memory in tests. */
export interface CacheDriver {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Round-trip latency in milliseconds, for /health. Throws when unreachable. */
  ping(): Promise<number>;
  close(): Promise<void>;
}

/** Envelope stored in L2 so staleness survives a process restart. */
const envelopeSchema = z.object({
  v: z.unknown(),
  storedAt: z.number(),
  freshSeconds: z.number(),
});

export class LayeredCache {
  readonly #driver: CacheDriver | undefined;
  readonly #l1 = new Map<string, { raw: string; expiresAt: number }>();
  readonly #l1TtlMs: number;
  readonly #now: () => number;
  readonly #namespace: string;

  #hits = 0;
  #misses = 0;
  #staleHits = 0;

  constructor(options: {
    /** Omit to run L1-only. The app must work without a shared cache configured. */
    readonly driver?: CacheDriver;
    /** How long L1 holds a value. Deliberately short; L2 is the real cache. */
    readonly l1TtlMs?: number;
    readonly namespace?: string;
    readonly now?: () => number;
  } = {}) {
    this.#driver = options.driver;
    this.#l1TtlMs = options.l1TtlMs ?? 5_000;
    this.#namespace = options.namespace ?? "ow";
    this.#now = options.now ?? (() => Date.now());
  }

  get stats(): { hits: number; misses: number; staleHits: number; l1Size: number } {
    return {
      hits: this.#hits,
      misses: this.#misses,
      staleHits: this.#staleHits,
      l1Size: this.#l1.size,
    };
  }

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const namespaced = this.#key(key);
    const now = this.#now();

    const local = this.#l1.get(namespaced);
    if (local !== undefined && local.expiresAt > now) {
      const entry = this.#decode<T>(local.raw, now, "l1");
      if (entry !== undefined) {
        this.#hits += 1;
        if (entry.stale) this.#staleHits += 1;
        return entry;
      }
    }

    if (this.#driver === undefined) {
      this.#misses += 1;
      return undefined;
    }

    let raw: string | undefined;
    try {
      raw = await this.#driver.get(namespaced);
    } catch {
      // A cache outage must never become an application outage. Fall through to the
      // caller, which will hit the durable store instead.
      this.#misses += 1;
      return undefined;
    }

    if (raw === undefined) {
      this.#misses += 1;
      return undefined;
    }

    // Populate L1 so the next request in this burst does not cross the network.
    this.#l1.set(namespaced, { raw, expiresAt: now + this.#l1TtlMs });

    const entry = this.#decode<T>(raw, now, "l2");
    if (entry === undefined) {
      this.#misses += 1;
      return undefined;
    }

    this.#hits += 1;
    if (entry.stale) this.#staleHits += 1;
    return entry;
  }

  async set<T>(key: string, value: T, options: CacheSetOptions): Promise<void> {
    const namespaced = this.#key(key);
    const now = this.#now();

    const raw = JSON.stringify({
      v: value,
      storedAt: now,
      freshSeconds: options.freshSeconds,
    });

    this.#l1.set(namespaced, { raw, expiresAt: now + this.#l1TtlMs });

    if (this.#driver === undefined) return;

    // The L2 TTL covers fresh AND stale, because a stale-but-servable value is the
    // whole point: expiring at the freshness boundary would throw away exactly the
    // data we want during an upstream outage.
    const ttlSeconds = options.freshSeconds + (options.staleSeconds ?? 0);
    try {
      await this.#driver.set(namespaced, raw, ttlSeconds);
    } catch {
      // Writing to a shared cache is best-effort; failing to cache is not failing.
    }
  }

  /**
   * Read through the cache, computing the value on a miss.
   *
   * On a stale hit the stale value is returned immediately and revalidation happens in
   * the background, so a user never waits for an upstream fetch. If revalidation
   * fails, the stale value simply remains — which is the last-known-good behaviour the
   * product requires.
   */
  async readThrough<T>(
    key: string,
    options: CacheSetOptions,
    compute: () => Promise<T>,
  ): Promise<CacheEntry<T>> {
    const existing = await this.get<T>(key);

    if (existing !== undefined && !existing.stale) return existing;

    if (existing !== undefined && existing.stale) {
      void this.#revalidate(key, options, compute);
      return existing;
    }

    const value = await compute();
    await this.set(key, value, options);
    return { value, storedAt: new Date(this.#now()), stale: false, layer: "l1" };
  }

  async delete(key: string): Promise<void> {
    const namespaced = this.#key(key);
    this.#l1.delete(namespaced);
    if (this.#driver === undefined) return;
    try {
      await this.#driver.delete(namespaced);
    } catch {
      // Best-effort.
    }
  }

  /** Whether a shared cache is configured, for the health endpoint. */
  get hasSharedLayer(): boolean {
    return this.#driver !== undefined;
  }

  async ping(): Promise<number | undefined> {
    if (this.#driver === undefined) return undefined;
    return this.#driver.ping();
  }

  async close(): Promise<void> {
    this.#l1.clear();
    await this.#driver?.close();
  }

  async #revalidate<T>(
    key: string,
    options: CacheSetOptions,
    compute: () => Promise<T>,
  ): Promise<void> {
    try {
      const value = await compute();
      await this.set(key, value, options);
    } catch {
      // Leave the stale value in place. This is the whole point of stale-while-
      // revalidate: an upstream failure must not remove data we already have.
    }
  }

  #decode<T>(raw: string, now: number, layer: "l1" | "l2"): CacheEntry<T> | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }

    const envelope = envelopeSchema.safeParse(parsed);
    if (!envelope.success) return undefined;

    const ageSeconds = (now - envelope.data.storedAt) / 1000;
    return {
      value: envelope.data.v as T,
      storedAt: new Date(envelope.data.storedAt),
      stale: ageSeconds > envelope.data.freshSeconds,
      layer,
    };
  }

  #key(key: string): string {
    return `${this.#namespace}:${key}`;
  }
}

/**
 * In-memory driver.
 *
 * A complete implementation of the driver contract, used in tests and as the fallback
 * when no shared cache is configured. Not shared across processes, so it does not
 * provide L2 semantics in a multi-instance deployment.
 */
export class MemoryCacheDriver implements CacheDriver {
  readonly #store = new Map<string, { value: string; expiresAt: number }>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  async get(key: string): Promise<string | undefined> {
    const entry = this.#store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.#store.set(key, { value, expiresAt: this.#now() + ttlSeconds * 1000 });
  }

  async delete(key: string): Promise<void> {
    this.#store.delete(key);
  }

  async ping(): Promise<number> {
    return 0;
  }

  async close(): Promise<void> {
    this.#store.clear();
  }

  get size(): number {
    return this.#store.size;
  }
}

export { type CacheDriver as Driver };
export * from "./upstash.js";
export * from "./config.js";
