import { createHash, randomInt } from "node:crypto";

/**
 * Pairing codes for watchlist sync.
 *
 * A code is the whole security model. There are no accounts, no email addresses and no
 * passwords: holding the code is what entitles a device to read and replace one list of
 * satellite numbers. That makes it a bearer secret, and everything here follows from
 * treating it as one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS PROTECTED, AND WHAT IS NOT
 *
 * The data behind a code is a list of catalog numbers. No location, no identity, no
 * contact details — the observing location is a home address to within a few metres and
 * it never leaves the device, which is a promise the app makes on screen and this
 * feature does not weaken.
 *
 * So the realistic harm from a guessed code is that somebody learns which satellites a
 * stranger follows, or replaces that list. Small, but not nothing, and the defence is
 * cheap: fifty bits of server-generated randomness behind a rate-limited endpoint.
 *
 * GENERATED HERE, NOT ON THE DEVICE
 * The server mints codes so their entropy is a property of this code rather than of
 * whichever platform happened to ask. `randomInt` is drawn from the system CSPRNG and
 * is free of the modulo bias that `Math.floor(Math.random() * 32)` would introduce —
 * and `Math.random` is not a CSPRNG in the first place.
 *
 * ONLY THE HASH IS STORED
 * SHA-256, no work factor, deliberately. Stretching exists to slow an attacker guessing
 * a human-chosen password; this is fifty bits of uniform randomness with no structure
 * to guess at, so a work factor would cost every request time while doing nothing an
 * attacker would notice. Entropy and the rate limit are the defence. What the hash buys
 * is that a database dump yields no working codes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Crockford's base32: no I, L, O or U.
 *
 * I and L are read as 1, O as 0, and U is excluded so that a random code cannot spell
 * something unfortunate. People will read these aloud and type them from a screen
 * across the room.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 10 characters of a 32-symbol alphabet: 50 bits. */
const CODE_LENGTH = 10;

/** Where the hyphen goes when the code is shown to a human. */
const GROUP = 5;

export function generateSyncCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    // randomInt is rejection-sampled by Node, so every symbol is equally likely.
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

/** `ABCDE-FGHJK`. The hyphen is presentation only and is stripped on the way back in. */
export function formatSyncCode(code: string): string {
  return `${code.slice(0, GROUP)}-${code.slice(GROUP)}`;
}

/**
 * Accept what a human typed, or reject it.
 *
 * Case is folded and the confusable characters are mapped the way Crockford intends —
 * someone reading a code off a screen will type O for 0 and l for 1, and refusing that
 * would be blaming them for a font. Anything still outside the alphabet after that is a
 * genuine mistake and is rejected rather than silently corrected into a different valid
 * code belonging to somebody else.
 */
export function normaliseSyncCode(input: string): string | undefined {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");

  if (cleaned.length !== CODE_LENGTH) return undefined;
  for (const character of cleaned) {
    if (!ALPHABET.includes(character)) return undefined;
  }
  return cleaned;
}

/**
 * The lookup key for a code.
 *
 * The only thing that ever reaches storage. Callers hash and then look up; nothing in
 * this system compares a code against a stored code, because no stored code exists.
 */
export function hashSyncCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}
