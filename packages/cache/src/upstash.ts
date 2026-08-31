import type { CacheDriver } from "./index.js";

/**
 * Upstash Redis driver, over the REST API.
 *
 * WHY REST RATHER THAN A REDIS CLIENT
 * Upstash exposes an HTTP API alongside the Redis protocol. HTTP is the better fit
 * here: it needs no connection pool, survives serverless cold starts, and works from
 * runtimes with no raw TCP. The cost is a little latency per call, which the L1 layer
 * already absorbs for repeated reads.
 *
 * CREDENTIALS
 * The token is read from configuration and sent in an Authorization header. It is
 * never logged, never included in error messages, and never written to disk. Errors
 * report the status code and a truncated body only after the body has been checked
 * for the token — see `redactToken`.
 *
 * VERIFICATION STATUS
 * This driver is written against Upstash's documented REST interface and is NOT yet
 * verified against a live instance, because that needs credentials. It is exercised in
 * tests through an injected fetch, which proves the request shape and the error
 * handling but not the service contract.
 */

export interface UpstashDriverOptions {
  readonly restUrl: string;
  readonly restToken: string;
  readonly timeoutMs?: number;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class UpstashCacheDriver implements CacheDriver {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: UpstashDriverOptions) {
    this.#baseUrl = options.restUrl.replace(/\/$/, "");
    this.#token = options.restToken;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async get(key: string): Promise<string | undefined> {
    const result = await this.#command<string | null>(["GET", key]);
    return result === null ? undefined : result;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    // EX sets an expiry atomically with the write; a separate EXPIRE would leave a
    // window where a crash produces a key that never expires.
    await this.#command(["SET", key, value, "EX", String(Math.max(1, Math.floor(ttlSeconds)))]);
  }

  async delete(key: string): Promise<void> {
    await this.#command(["DEL", key]);
  }

  async ping(): Promise<number> {
    const started = Date.now();
    await this.#command(["PING"]);
    return Date.now() - started;
  }

  async close(): Promise<void> {
    // Stateless over HTTP; nothing to release.
  }

  async #command<T>(parts: readonly string[]): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(this.#baseUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(parts),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new UpstashError(
          `Upstash returned HTTP ${response.status}: ${this.#redactToken(body).slice(0, 200)}`,
          response.status,
        );
      }

      const payload: unknown = await response.json();
      if (
        payload === null ||
        typeof payload !== "object" ||
        !("result" in payload)
      ) {
        throw new UpstashError("Upstash response did not contain a result field", 0);
      }

      return (payload as { result: T }).result;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Strip the token from any text before it can reach a log or an error message.
   *
   * Upstash error bodies do not normally echo the token, but an error message that
   * might contain a credential is not something to leave to chance: once a secret is
   * in a log store it is effectively public and must be rotated.
   */
  #redactToken(text: string): string {
    if (this.#token.length === 0) return text;
    return text.split(this.#token).join("[REDACTED]");
  }
}

export class UpstashError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UpstashError";
  }
}
