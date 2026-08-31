import { describe, expect, it } from "vitest";

import {
  assessAccuracy,
  formatDuration,
  isEffectivelyLive,
  selectBestElements,
} from "./accuracy.js";

const EPOCH = new Date("2026-08-31T12:00:00Z");
const hoursAfter = (h: number) => new Date(EPOCH.getTime() + h * 3_600_000);

describe("assessAccuracy", () => {
  it("treats propagation near epoch as nominal", () => {
    const result = assessAccuracy(EPOCH, hoursAfter(2), "LEO");
    expect(result.confidence).toBe("NOMINAL");
    expect(result.warning).toBeUndefined();
    expect(result.renderable).toBe(true);
  });

  it("degrades LEO faster than GEO, because drag dominates low orbits", () => {
    const at48h = hoursAfter(48);
    expect(assessAccuracy(EPOCH, at48h, "LEO").confidence).toBe("DEGRADED");
    expect(assessAccuracy(EPOCH, at48h, "GEO").confidence).toBe("NOMINAL");
  });

  it("flags long forward propagation as extrapolation with a warning", () => {
    const result = assessAccuracy(EPOCH, hoursAfter(24 * 10), "LEO");
    expect(result.confidence).toBe("EXTRAPOLATED");
    expect(result.warning).toMatch(/EXTRAPOLATION/);
    expect(result.warning).toMatch(/indicative only/);
    expect(result.renderable).toBe(true);
  });

  it("refuses to render beyond any defensible limit", () => {
    // A confident wrong position is worse than no position.
    const result = assessAccuracy(EPOCH, hoursAfter(24 * 400), "LEO");
    expect(result.confidence).toBe("UNRELIABLE");
    expect(result.renderable).toBe(false);
    expect(result.warning).toMatch(/too far/);
  });

  it("holds backward propagation to a tighter limit than forward", () => {
    // Going backwards crosses any manoeuvre in between, producing an orbit the
    // spacecraft was never in.
    const forward = assessAccuracy(EPOCH, hoursAfter(48), "LEO");
    const backward = assessAccuracy(EPOCH, hoursAfter(-48), "LEO");
    expect(forward.confidence).toBe("DEGRADED");
    expect(backward.confidence).toBe("EXTRAPOLATED");
    expect(backward.backwards).toBe(true);
  });

  it("points backward propagation at stored history", () => {
    const result = assessAccuracy(EPOCH, hoursAfter(-24 * 5), "LEO");
    expect(result.warning).toMatch(/Historical replay should use element sets/);
  });

  it("reports signed hours from epoch", () => {
    expect(assessAccuracy(EPOCH, hoursAfter(6), "LEO").hoursFromEpoch).toBeCloseTo(6, 6);
    expect(assessAccuracy(EPOCH, hoursAfter(-6), "LEO").hoursFromEpoch).toBeCloseTo(-6, 6);
  });

  it("produces a compact badge label", () => {
    expect(assessAccuracy(EPOCH, hoursAfter(2), "LEO").label).toBe("NOMINAL · 2h");
    expect(assessAccuracy(EPOCH, hoursAfter(24 * 10), "LEO").label).toMatch(
      /^EXTRAPOLATED · 10d$/,
    );
  });

  it("uses the most conservative bands for an unknown orbit class", () => {
    expect(assessAccuracy(EPOCH, hoursAfter(48), "UNKNOWN").confidence).toBe("DEGRADED");
  });
});

describe("formatDuration", () => {
  it("scales units with magnitude", () => {
    expect(formatDuration(0.5)).toBe("30m");
    expect(formatDuration(5)).toBe("5h");
    expect(formatDuration(24 * 3)).toBe("3d");
    expect(formatDuration(24 * 400)).toBe("1.1y");
  });
});

describe("selectBestElements", () => {
  const sets = [
    { epoch: new Date("2026-08-01T00:00:00Z"), id: "aug1" },
    { epoch: new Date("2026-08-15T00:00:00Z"), id: "aug15" },
    { epoch: new Date("2026-08-29T00:00:00Z"), id: "aug29" },
  ];

  it("returns undefined when no elements are stored", () => {
    expect(selectBestElements([], new Date())).toBeUndefined();
  });

  it("chooses the most recent set preceding the requested time", () => {
    // This is the whole point of storing history: replaying 20 August must use the
    // elements that were current then, not today's propagated backwards.
    const selection = selectBestElements(sets, new Date("2026-08-20T00:00:00Z"), "LEO");
    expect(selection?.elements.id).toBe("aug15");
    expect(selection?.precedesTarget).toBe(true);
  });

  it("uses the newest set for a present-day request", () => {
    const selection = selectBestElements(sets, new Date("2026-08-30T00:00:00Z"), "LEO");
    expect(selection?.elements.id).toBe("aug29");
    expect(selection?.precedesTarget).toBe(true);
  });

  it("flags reconstruction when the request predates all stored history", () => {
    const selection = selectBestElements(sets, new Date("2026-07-01T00:00:00Z"), "LEO");
    expect(selection?.elements.id).toBe("aug1");
    expect(selection?.precedesTarget).toBe(false);
    expect(selection?.assessment.backwards).toBe(true);
  });

  it("is not affected by the input order", () => {
    const shuffled = [sets[2]!, sets[0]!, sets[1]!];
    const selection = selectBestElements(shuffled, new Date("2026-08-20T00:00:00Z"));
    expect(selection?.elements.id).toBe("aug15");
  });

  it("attaches an accuracy assessment to the chosen set", () => {
    const selection = selectBestElements(sets, new Date("2026-08-16T00:00:00Z"), "LEO");
    expect(selection?.assessment.confidence).toBe("NOMINAL");
    expect(selection?.assessment.hoursFromEpoch).toBeCloseTo(24, 3);
  });

  it("keeps history useful: a nearby stored set beats a distant one", () => {
    // Selecting aug29 for an aug-20 request would mean propagating 9 days backwards.
    const selection = selectBestElements(sets, new Date("2026-08-20T00:00:00Z"), "LEO");
    expect(selection?.assessment.backwards).toBe(false);
    expect(selection?.assessment.confidence).not.toBe("UNRELIABLE");
  });
});

describe("isEffectivelyLive", () => {
  const now = new Date("2026-08-31T12:00:00Z");

  it("tolerates small clock skew and animation lag", () => {
    expect(isEffectivelyLive(new Date(now.getTime() + 2000), now)).toBe(true);
    expect(isEffectivelyLive(new Date(now.getTime() - 2000), now)).toBe(true);
  });

  it("treats deliberate time travel as not live", () => {
    expect(isEffectivelyLive(new Date(now.getTime() + 60_000), now)).toBe(false);
    expect(isEffectivelyLive(new Date(now.getTime() - 3_600_000), now)).toBe(false);
  });
});
