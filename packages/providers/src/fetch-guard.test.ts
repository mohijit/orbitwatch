import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FetchGuard, FetchGuardStateError } from "./fetch-guard.js";

const TWO_HOURS = 2 * 60 * 60 * 1000;

/** Mirrors what GuardedHttpClient does on a successful fetch. */
async function acquireAndCommit(g: FetchGuard, key: string): Promise<void> {
  const acquisition = await g.tryAcquire(key, 0);
  if (!acquisition.acquired) throw new Error(`could not acquire ${key}`);
  await g.commit(acquisition.reservation);
}

describe("FetchGuard", () => {
  let directory: string;
  let stateFile: string;
  let clock: Date;

  const guard = () =>
    new FetchGuard({ stateFile, now: () => clock });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "orbitwatch-guard-"));
    stateFile = join(directory, "fetch-guard.json");
    clock = new Date("2026-08-31T12:00:00.000Z");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("allows the very first request", async () => {
    const decision = await guard().check("celestrak-gp:active", TWO_HOURS);
    expect(decision).toEqual({ allowed: true, reason: "first-request" });
  });

  it("refuses a second request inside the provider interval", async () => {
    const g = guard();
    await acquireAndCommit(g, "celestrak-gp:active");

    clock = new Date(clock.getTime() + 30 * 60 * 1000); // +30 min
    const decision = await g.check("celestrak-gp:active", TWO_HOURS);

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toBe("within-interval");
    expect(decision.retryAfterMs).toBe(90 * 60 * 1000); // 90 min remaining
  });

  it("allows again once the interval has elapsed", async () => {
    const g = guard();
    await acquireAndCommit(g, "celestrak-gp:active");

    clock = new Date(clock.getTime() + TWO_HOURS + 1000);
    const decision = await g.check("celestrak-gp:active", TWO_HOURS);

    expect(decision).toEqual({ allowed: true, reason: "interval-elapsed" });
  });

  it("survives process restart — a new instance still sees the last fetch", async () => {
    // This is the property that protects against a dev-server restart loop
    // issuing a fresh upstream request every time the process boots.
    await acquireAndCommit(guard(), "celestrak-gp:active");

    clock = new Date(clock.getTime() + 10 * 60 * 1000);
    const freshInstance = new FetchGuard({ stateFile, now: () => clock });
    const decision = await freshInstance.check("celestrak-gp:active", TWO_HOURS);

    expect(decision.allowed).toBe(false);
  });

  it("tracks resources within a provider independently", async () => {
    const g = guard();
    await acquireAndCommit(g, "celestrak-gp:active");

    const other = await g.check("celestrak-gp:starlink", TWO_HOURS);
    expect(other.allowed).toBe(true);
  });

  it("applies escalating backoff after upstream refusals", async () => {
    const g = guard();

    const first = await g.recordRefusal("celestrak-gp:active");
    expect(first.getTime() - clock.getTime()).toBe(15 * 60 * 1000);

    const second = await g.recordRefusal("celestrak-gp:active");
    expect(second.getTime() - clock.getTime()).toBe(60 * 60 * 1000);

    const third = await g.recordRefusal("celestrak-gp:active");
    expect(third.getTime() - clock.getTime()).toBe(4 * 60 * 60 * 1000);

    const fourth = await g.recordRefusal("celestrak-gp:active");
    expect(fourth.getTime() - clock.getTime()).toBe(24 * 60 * 60 * 1000);

    // Backoff is capped, not unbounded.
    const fifth = await g.recordRefusal("celestrak-gp:active");
    expect(fifth.getTime() - clock.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("blocks while backoff is active even if the interval has elapsed", async () => {
    const g = guard();
    await g.recordRefusal("celestrak-gp:active");

    clock = new Date(clock.getTime() + 5 * 60 * 1000);
    const decision = await g.check("celestrak-gp:active", 0);

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toBe("backoff-active");
  });

  it("clears backoff after a later success", async () => {
    const g = guard();
    await g.recordRefusal("celestrak-gp:active");
    clock = new Date(clock.getTime() + 20 * 60 * 1000);

    await acquireAndCommit(g, "celestrak-gp:active");
    clock = new Date(clock.getTime() + TWO_HOURS + 1000);

    const decision = await g.check("celestrak-gp:active", TWO_HOURS);
    expect(decision.allowed).toBe(true);
  });

  it("fails closed when the state file is corrupt", async () => {
    // A guard that cannot prove when it last fetched must not permit a request.
    await writeFile(stateFile, "{ this is not json", "utf8");
    await expect(guard().check("celestrak-gp:active", TWO_HOURS)).rejects.toBeInstanceOf(
      FetchGuardStateError,
    );
  });

  it("fails closed when the stored timestamp is unparseable", async () => {
    await writeFile(
      stateFile,
      JSON.stringify({ "celestrak-gp:active": { lastFetchedAt: "not-a-date" } }),
      "utf8",
    );
    const decision = await guard().check("celestrak-gp:active", TWO_HOURS);
    expect(decision.allowed).toBe(false);
  });

  it("lets only one of two concurrent acquirers through", async () => {
    // Two ingest jobs racing. check()+record separately would be a TOCTOU race:
    // both would read the same state, both be told "allowed", and both hit upstream.
    // tryAcquire does check-and-reserve inside one critical section.
    const g = guard();

    const results = await Promise.all([
      g.tryAcquire("celestrak-gp:active", TWO_HOURS),
      g.tryAcquire("celestrak-gp:active", TWO_HOURS),
    ]);

    expect(results.filter((r) => r.acquired)).toHaveLength(1);
  });

  it("rolls back a reservation so a transient failure does not burn the interval", async () => {
    const g = guard();
    const acquisition = await g.tryAcquire("celestrak-gp:active", TWO_HOURS);
    expect(acquisition.acquired).toBe(true);
    if (!acquisition.acquired) throw new Error("unreachable");

    // Simulate a timeout / 502: we never got data, so we must not lose the slot.
    await g.rollback(acquisition.reservation);

    const retry = await g.tryAcquire("celestrak-gp:active", TWO_HOURS);
    expect(retry.acquired).toBe(true);
  });

  it("holds the reservation when upstream refuses, and does not roll back", async () => {
    const g = guard();
    const acquisition = await g.tryAcquire("celestrak-gp:active", TWO_HOURS);
    if (!acquisition.acquired) throw new Error("unreachable");

    await g.recordRefusal("celestrak-gp:active");

    const retry = await g.tryAcquire("celestrak-gp:active", TWO_HOURS);
    expect(retry.acquired).toBe(false);
  });

  it("writes valid JSON that a later run can read", async () => {
    await acquireAndCommit(guard(), "celestrak-gp:active");
    const raw = await readFile(stateFile, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toHaveProperty(["celestrak-gp:active", "lastFetchedAt"]);
  });
});
