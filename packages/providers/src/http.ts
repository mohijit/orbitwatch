import { FetchGuard } from "./fetch-guard.js";
import { policyFor, type ProviderId } from "./policy.js";

/**
 * Guarded HTTP access to third-party providers.
 *
 * Every outbound request to an external data source in OrbitWatch goes through here.
 * That is what makes the rate policy in `policy.ts` an enforced invariant rather than
 * a comment.
 */

/** Identifies OrbitWatch to providers. CelesTrak asks that M2M clients be identifiable. */
const USER_AGENT =
  "OrbitWatch/0.1 (+https://github.com/orbitwatch; satellite tracking; contact via repo)";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface GuardedFetchOptions {
  /** Which provider policy governs this request. */
  provider: ProviderId;
  /**
   * Distinguishes resources within one provider, so that fetching the `active` group
   * does not consume the budget for the `starlink` group.
   */
  resource: string;
  /** Overrides the policy interval. Use only with a documented reason. */
  minIntervalMs?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export type GuardedFetchResult =
  | { status: "fetched"; body: string; contentType: string; fetchedAt: Date }
  | {
      status: "skipped";
      reason: "within-interval" | "backoff-active";
      retryAfterMs: number;
      lastFetchedAt: Date | undefined;
    };

export class ProviderRefusedError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly httpStatus: number,
    readonly backoffUntil: Date,
    readonly bodyExcerpt: string,
  ) {
    super(
      `${provider} refused the request with HTTP ${httpStatus}. Backing off until ` +
        `${backoffUntil.toISOString()}. Upstream said: ${bodyExcerpt}`,
    );
    this.name = "ProviderRefusedError";
  }
}

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly httpStatus: number,
    readonly bodyExcerpt: string,
  ) {
    super(`${provider} returned HTTP ${httpStatus}: ${bodyExcerpt}`);
    this.name = "ProviderHttpError";
  }
}

export class GuardedHttpClient {
  readonly #guard: FetchGuard;

  constructor(guard: FetchGuard = new FetchGuard()) {
    this.#guard = guard;
  }

  /**
   * Perform a rate-guarded GET.
   *
   * Returns `{ status: "skipped" }` rather than throwing when the guard declines,
   * because "we already have recent data" is a normal, expected outcome that callers
   * handle by serving cache — not an error condition.
   */
  async get(url: string, options: GuardedFetchOptions): Promise<GuardedFetchResult> {
    const policy = policyFor(options.provider);
    const key = `${options.provider}:${options.resource}`;
    const minInterval = options.minIntervalMs ?? policy.minIntervalMs;

    // Atomic check-and-reserve. Using check() then recording separately would let
    // two concurrent callers both pass the check and both hit upstream.
    const acquisition = await this.#guard.tryAcquire(key, minInterval);
    if (!acquisition.acquired) {
      const { decision } = acquisition;
      // The type system knows a non-acquired result carries a refusing decision.
      if (decision.allowed) throw new Error("unreachable: allowed but not acquired");
      return {
        status: "skipped",
        reason: decision.reason,
        retryAfterMs: decision.retryAfterMs,
        lastFetchedAt: decision.lastFetchedAt,
      };
    }
    const { reservation } = acquisition;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("timeout")),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (options.signal) {
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json, text/csv, text/plain;q=0.9, */*;q=0.8",
          ...options.headers,
        },
      });

      // 403/429 mean "you are asking too often". Record an escalating backoff and
      // stop — CelesTrak explicitly instructs M2M clients to halt and alert a human
      // rather than retry.
      if (response.status === 403 || response.status === 429) {
        const excerpt = await readExcerpt(response);
        // Deliberately NOT rolled back: upstream told us we are asking too often, so
        // the reservation stands and an escalating backoff is layered on top.
        const backoffUntil = await this.#guard.recordRefusal(key);
        throw new ProviderRefusedError(
          options.provider,
          response.status,
          backoffUntil,
          excerpt,
        );
      }

      if (!response.ok) {
        // Server-side failures are the provider's problem, not a rate violation, so
        // release the reservation — a 502 must not cost us a 2-hour data cycle.
        await this.#guard.rollback(reservation);
        throw new ProviderHttpError(
          options.provider,
          response.status,
          await readExcerpt(response),
        );
      }

      const body = await response.text();
      await this.#guard.commit(reservation);

      return {
        status: "fetched",
        body,
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        fetchedAt: new Date(),
      };
    } catch (error) {
      // Network-level failure (timeout, DNS, connection refused). We never reached
      // the provider, so the attempt must not consume the interval budget.
      if (!(error instanceof ProviderRefusedError) && !(error instanceof ProviderHttpError)) {
        await this.#guard.rollback(reservation);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Expose guard state for the /providers/status endpoint. */
  async status(provider: ProviderId, resource: string) {
    return this.#guard.inspect(`${provider}:${resource}`);
  }
}

async function readExcerpt(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 300).replace(/\s+/g, " ").trim();
  } catch {
    return "<unreadable response body>";
  }
}
