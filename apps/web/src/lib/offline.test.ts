import { describe, expect, it } from "vitest";

import { cacheNotice, type CacheState } from "./offline";

const NOW = new Date("2026-09-03T12:00:00Z");

const LIVE: CacheState = { online: true, fromCache: false, retrievedAt: "2026-09-03T11:59:00Z" };
const OFFLINE: CacheState = {
  online: false,
  fromCache: true,
  retrievedAt: "2026-09-03T09:00:00Z",
};

describe("cacheNotice", () => {
  it("says nothing when the data is live", () => {
    expect(cacheNotice(LIVE, NOW)).toBeUndefined();
  });

  it("says how old the cached elements are", () => {
    const notice = cacheNotice(OFFLINE, NOW);

    expect(notice?.headline).toBe("Offline — elements from 3h ago");
    expect(notice?.usable).toBe(true);
  });

  it("speaks up when the browser claims to be online but the data came from a cache", () => {
    /*
     * The case that justifies having two signals.
     *
     * A captive portal, a dead API and DNS that resolves to nothing all leave
     * `navigator.onLine` true. Keyed on that alone, the banner would stay hidden in
     * exactly the situations where what is on screen is oldest — and the user would
     * have no way to tell a working app from a frozen one.
     */
    const notice = cacheNotice({ ...OFFLINE, online: true }, NOW);

    expect(notice).toBeDefined();
    expect(notice?.headline).toBe("Using cached elements — 3h old");
    expect(notice?.headline).not.toContain("Offline");
  });

  it("always says the positions are computed rather than received", () => {
    // Satellites keep moving on screen while offline, because propagation is local. A
    // banner that says only "offline" leaves that motion looking like a live feed that
    // somehow survived losing the network.
    const notice = cacheNotice(OFFLINE, NOW);

    expect(notice?.detail).toContain("computed");
    expect(notice?.detail).toContain("not received");
  });

  it("does not claim the positions are accurate, or that they are not", () => {
    // That judgement is per satellite, from its own element epoch and orbit class, and
    // it already has a home in the accuracy badge. Repeating a single verdict for the
    // whole catalog here would contradict it for most objects.
    const notice = cacheNotice(OFFLINE, NOW);

    expect(notice?.detail).not.toMatch(/\baccurate\b|\bwrong\b|\binaccurate\b/i);
    expect(notice?.detail).toContain("badge");
  });

  it("says there is nothing rather than showing an empty globe", () => {
    // Nothing is precached, so a first visit with no network genuinely has no catalog.
    const notice = cacheNotice({ online: false, fromCache: false, retrievedAt: undefined }, NOW);

    expect(notice?.usable).toBe(false);
    expect(notice?.headline).toContain("no cached catalog");
    expect(notice?.detail).toContain("Reconnect");
  });

  it("drops the age rather than reporting a negative one", () => {
    /*
     * A timestamp in the future means the device clock disagrees with the server's,
     * which is common enough on phones. "elements from -2h ago" would be gibberish;
     * the statement that they are cached is still true and still worth making.
     */
    const notice = cacheNotice({ ...OFFLINE, retrievedAt: "2026-09-03T14:00:00Z" }, NOW);

    expect(notice?.headline).toBe("Offline — cached catalog");
    expect(notice?.headline).not.toContain("-");
    expect(notice?.usable).toBe(true);
  });

  it("scales the age from minutes to days", () => {
    expect(cacheNotice({ ...OFFLINE, retrievedAt: "2026-09-03T11:30:00Z" }, NOW)?.headline).toContain(
      "30m",
    );
    expect(cacheNotice({ ...OFFLINE, retrievedAt: "2026-08-31T12:00:00Z" }, NOW)?.headline).toContain(
      "3d",
    );
  });
});
