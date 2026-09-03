import { describe, expect, it } from "vitest";

import {
  formatSyncCode,
  generateSyncCode,
  hashSyncCode,
  normaliseSyncCode,
} from "./sync-code.js";

/**
 * Pairing codes.
 *
 * A code is the entire security model for watchlist sync — holding one entitles a
 * device to read and replace a list — so these tests are about the properties that make
 * that safe, not about the string format.
 */

describe("generateSyncCode", () => {
  it("uses an alphabet with no character that can be misread", () => {
    // Crockford's base32: I and L read as 1, O reads as 0, and U is left out so a
    // random code cannot spell something unfortunate.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      expect(generateSyncCode()).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
    }
  });

  it("does not repeat itself", () => {
    /*
     * Not a randomness test — it cannot be — but it does catch the failure that
     * matters: a generator wired to a constant seed, or one that lost its loop and
     * returns the same symbol ten times. Fifty bits means a collision in 5,000 draws is
     * far beyond astronomically unlikely, so any repeat here is a bug and not luck.
     */
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 5_000; attempt += 1) seen.add(generateSyncCode());

    expect(seen.size).toBe(5_000);
  });

  it("uses the whole alphabet", () => {
    // A generator that only ever emitted the first few symbols would still look random
    // and would have a small fraction of the entropy the security argument assumes.
    const used = new Set<string>();
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      for (const character of generateSyncCode()) used.add(character);
    }

    expect(used.size).toBe(32);
  });
});

describe("normaliseSyncCode", () => {
  it("accepts a code as it is displayed", () => {
    const code = generateSyncCode();
    expect(normaliseSyncCode(formatSyncCode(code))).toBe(code);
  });

  it("forgives what a person typing from a screen will actually do", () => {
    // Lower case, the hyphen left out, a stray space, and the confusables Crockford's
    // alphabet exists to absorb. Refusing these would be blaming the user for a font.
    expect(normaliseSyncCode("abcde-fghjk")).toBe("ABCDEFGHJK");
    expect(normaliseSyncCode("ABCDEFGHJK")).toBe("ABCDEFGHJK");
    expect(normaliseSyncCode(" ABCDE FGHJK ")).toBe("ABCDEFGHJK");
    expect(normaliseSyncCode("O1234-5678I")).toBe("0123456781");
    expect(normaliseSyncCode("l1234-56789")).toBe("1123456789");
  });

  it("rejects rather than repairs anything else", () => {
    /*
     * The important half. Quietly dropping an unrecognised character would turn one
     * person's typo into a valid code belonging to somebody else, handing them a
     * stranger's list — so the length check happens after cleaning, and a character
     * outside the alphabet is a refusal.
     */
    expect(normaliseSyncCode("ABCDEFGHJ")).toBeUndefined();
    expect(normaliseSyncCode("ABCDEFGHJKL")).toBeUndefined();
    expect(normaliseSyncCode("ABCDE-FGH!K")).toBeUndefined();
    expect(normaliseSyncCode("")).toBeUndefined();
    expect(normaliseSyncCode("UUUUU-UUUUU")).toBeUndefined();
  });
});

describe("hashSyncCode", () => {
  it("is stable, so a code found tomorrow finds the same list", () => {
    expect(hashSyncCode("ABCDEFGHJK")).toBe(hashSyncCode("ABCDEFGHJK"));
    expect(hashSyncCode("ABCDEFGHJK")).toHaveLength(64);
  });

  it("does not carry the code into what is stored", () => {
    // The whole point: a database dump must not yield working codes. The hash contains
    // no fragment of the input, in either case.
    const code = "ABCDEFGHJK";
    const hash = hashSyncCode(code);

    expect(hash).not.toContain(code);
    expect(hash.toUpperCase()).not.toContain(code);
  });

  it("separates codes that differ by one character", () => {
    expect(hashSyncCode("ABCDEFGHJK")).not.toBe(hashSyncCode("ABCDEFGHJM"));
  });
});
