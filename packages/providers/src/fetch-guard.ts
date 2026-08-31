import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Persistent upstream-request guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * CelesTrak tightened its usage policy in March 2026: GP data updates roughly every
 * two hours, and consumers are permitted ONE download per update cycle. A second
 * request inside the same cycle returns HTTP 403 ("GP data has not updated since your
 * last successful download"), and CelesTrak states that continued excessive requests
 * result in the offending IP being handed to their firewall.
 *
 * An in-memory rate limiter is NOT sufficient protection. During development a dev
 * server may restart dozens of times an hour; each restart would reset an in-memory
 * counter and issue a fresh upstream request. That is precisely the access pattern
 * that gets an IP banned.
 *
 * This guard therefore persists its state to disk so it survives process restarts,
 * and it is deliberately fail-closed: if the state file cannot be read, we assume a
 * request was just made rather than assuming it is safe to proceed.
 */

/** Reason a guarded request was not permitted. */
export type GuardDecision =
  | { allowed: true; reason: "first-request" | "interval-elapsed" }
  | {
      allowed: false;
      reason: "within-interval" | "backoff-active";
      /** Milliseconds until the next request is permitted. */
      retryAfterMs: number;
      /** When the last successful request happened, if known. */
      lastFetchedAt: Date | undefined;
    };

export interface GuardEntry {
  /** ISO timestamp of the last *successful* upstream fetch. */
  lastFetchedAt?: string;
  /** ISO timestamp before which no request may be made (set after a 403/429). */
  backoffUntil?: string;
  /** Consecutive refusals from upstream, used to escalate backoff. */
  consecutiveRefusals?: number;
}

type GuardState = Record<string, GuardEntry>;

/** A reserved request slot, returned by {@link FetchGuard.tryAcquire}. */
export interface Reservation {
  readonly key: string;
  /** State to restore if the request fails for a non-rate-limit reason. */
  readonly previous: GuardEntry | undefined;
}

export type AcquireResult =
  | { readonly acquired: true; readonly reservation: Reservation }
  | { readonly acquired: false; readonly decision: GuardDecision };

export interface FetchGuardOptions {
  /**
   * Path to the JSON state file. Defaults to `<cwd>/.data/fetch-guard.json`.
   * This file is gitignored — it is machine-local operational state, not source.
   */
  stateFile?: string;
  /** Injectable clock, for tests. */
  now?: () => Date;
}

/** Escalating backoff applied after upstream refuses us (403/429). */
const BACKOFF_SCHEDULE_MS = [
  15 * 60 * 1000, // 15 min
  60 * 60 * 1000, // 1 h
  4 * 60 * 60 * 1000, // 4 h
  24 * 60 * 60 * 1000, // 24 h
] as const;

const DEFAULT_STATE_FILE = join(process.cwd(), ".data", "fetch-guard.json");

export class FetchGuard {
  readonly #stateFile: string;
  readonly #now: () => Date;
  /**
   * Serialises read-modify-write cycles. Without this, two concurrent ingest jobs
   * could both read the same state, both decide they are allowed, and both fetch.
   */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: FetchGuardOptions = {}) {
    this.#stateFile = options.stateFile ?? DEFAULT_STATE_FILE;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Ask whether a request to `key` is permitted right now, WITHOUT reserving it.
   *
   * This is advisory only — for status endpoints and diagnostics. Do not use it to
   * gate an actual request: between `check` returning `allowed` and the caller
   * issuing the request, another caller can also be told `allowed`. Use
   * {@link tryAcquire} for anything that actually hits the network.
   */
  async check(key: string, minIntervalMs: number): Promise<GuardDecision> {
    return this.#serialise(async () => {
      const state = await this.#read();
      return this.#decide(state[key], minIntervalMs);
    });
  }

  /**
   * Atomically check the interval AND reserve the slot in one critical section.
   *
   * This is the method real requests must use. Checking and recording separately is
   * a time-of-check-to-time-of-use race: two concurrent ingest jobs would both read
   * the same state, both be told "allowed", and both hit upstream — burning two
   * requests inside one cycle and triggering exactly the 403/firewall response the
   * guard exists to prevent.
   *
   * The reservation optimistically stamps `lastFetchedAt` to now. Callers MUST then
   * call {@link commit} on success or {@link rollback} on a non-rate-limit failure,
   * so that a transient network error does not consume the whole interval budget.
   */
  async tryAcquire(key: string, minIntervalMs: number): Promise<AcquireResult> {
    return this.#serialise(async () => {
      const state = await this.#read();
      const decision = this.#decide(state[key], minIntervalMs);
      if (!decision.allowed) return { acquired: false, decision } as const;

      const previous = state[key];
      state[key] = {
        ...previous,
        lastFetchedAt: this.#now().toISOString(),
      };
      await this.#write(state);

      return {
        acquired: true,
        reservation: { key, previous },
      } as const;
    });
  }

  /**
   * Confirm a reservation after a successful (2xx) response. Refreshes the timestamp
   * to the completion time and clears any prior backoff.
   */
  async commit(reservation: Reservation): Promise<void> {
    await this.#serialise(async () => {
      const state = await this.#read();
      state[reservation.key] = { lastFetchedAt: this.#now().toISOString() };
      await this.#write(state);
    });
  }

  /**
   * Release a reservation after a failure that was NOT a rate-limit refusal
   * (timeout, DNS failure, upstream 5xx). Restores the previous state so the failed
   * attempt does not count against the interval.
   */
  async rollback(reservation: Reservation): Promise<void> {
    await this.#serialise(async () => {
      const state = await this.#read();
      if (reservation.previous === undefined) {
        delete state[reservation.key];
      } else {
        state[reservation.key] = reservation.previous;
      }
      await this.#write(state);
    });
  }

  /**
   * Record that upstream refused us (HTTP 403 or 429) and apply escalating backoff.
   *
   * CelesTrak's documented guidance is that machine-to-machine software must stop
   * querying immediately on any non-200 response and surface it to a human, so this
   * intentionally applies a long backoff rather than retrying.
   */
  async recordRefusal(key: string): Promise<Date> {
    return this.#serialise(async () => {
      const state = await this.#read();
      const previous = state[key] ?? {};
      const refusals = (previous.consecutiveRefusals ?? 0) + 1;
      const index = Math.min(refusals - 1, BACKOFF_SCHEDULE_MS.length - 1);
      // `index` is clamped into range above, so this element always exists.
      const backoffMs = BACKOFF_SCHEDULE_MS[index] as number;
      const backoffUntil = new Date(this.#now().getTime() + backoffMs);

      state[key] = {
        ...previous,
        backoffUntil: backoffUntil.toISOString(),
        consecutiveRefusals: refusals,
      };
      await this.#write(state);
      return backoffUntil;
    });
  }

  /** Inspect stored state for a key. Used by the provider-status endpoint. */
  async inspect(key: string): Promise<{ lastFetchedAt?: Date; backoffUntil?: Date }> {
    return this.#serialise(async () => {
      const entry = (await this.#read())[key];
      const result: { lastFetchedAt?: Date; backoffUntil?: Date } = {};
      if (entry?.lastFetchedAt) result.lastFetchedAt = new Date(entry.lastFetchedAt);
      if (entry?.backoffUntil) result.backoffUntil = new Date(entry.backoffUntil);
      return result;
    });
  }

  #decide(entry: GuardEntry | undefined, minIntervalMs: number): GuardDecision {
    const now = this.#now().getTime();

    if (entry?.backoffUntil) {
      const until = Date.parse(entry.backoffUntil);
      if (Number.isFinite(until) && until > now) {
        return {
          allowed: false,
          reason: "backoff-active",
          retryAfterMs: until - now,
          lastFetchedAt: entry.lastFetchedAt ? new Date(entry.lastFetchedAt) : undefined,
        };
      }
    }

    if (!entry?.lastFetchedAt) {
      return { allowed: true, reason: "first-request" };
    }

    const last = Date.parse(entry.lastFetchedAt);
    if (!Number.isFinite(last)) {
      // Corrupt timestamp. Fail closed: treat as if we just fetched.
      return {
        allowed: false,
        reason: "within-interval",
        retryAfterMs: minIntervalMs,
        lastFetchedAt: undefined,
      };
    }

    const elapsed = now - last;
    if (elapsed < minIntervalMs) {
      return {
        allowed: false,
        reason: "within-interval",
        retryAfterMs: minIntervalMs - elapsed,
        lastFetchedAt: new Date(last),
      };
    }

    return { allowed: true, reason: "interval-elapsed" };
  }

  async #read(): Promise<GuardState> {
    try {
      const raw = await readFile(this.#stateFile, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed as GuardState;
    } catch (error) {
      if (isNotFound(error)) {
        // No state file yet — genuinely the first run.
        return {};
      }
      // Unreadable/corrupt state. Fail CLOSED by reporting a state that blocks
      // everything, rather than silently allowing an unbounded upstream request.
      throw new FetchGuardStateError(this.#stateFile, error);
    }
  }

  async #write(state: GuardState): Promise<void> {
    await mkdir(dirname(this.#stateFile), { recursive: true });
    // Write-then-rename keeps the state file valid even if the process dies mid-write.
    const temporary = `${this.#stateFile}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
    const { rename } = await import("node:fs/promises");
    await rename(temporary, this.#stateFile);
  }

  #serialise<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(operation, operation);
    // Keep the chain alive even if an operation rejects.
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

export class FetchGuardStateError extends Error {
  constructor(
    readonly stateFile: string,
    // `Error` already declares `cause`, so this must be an explicit override.
    override readonly cause: unknown,
  ) {
    super(
      `Fetch guard state at ${stateFile} could not be read. Refusing all upstream ` +
        `requests until this is resolved, to avoid violating provider rate policy.`,
    );
    this.name = "FetchGuardStateError";
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
