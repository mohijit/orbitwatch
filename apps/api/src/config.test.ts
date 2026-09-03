import { describe, expect, it } from "vitest";

import { loadServerConfig } from "./config.js";

/**
 * Startup configuration.
 *
 * WHY THIS FILE EXISTS
 * Every one of these cases used to pass silently. The API read its own environment with
 * bare `Number(...)`, which does not throw on nonsense — it returns NaN, and NaN then
 * flows somewhere that quietly substitutes a value nobody chose. The database and cache
 * packages have always validated through a schema; this brings the API in line.
 */

describe("loadServerConfig", () => {
  it("runs on defaults when nothing is set", () => {
    const config = loadServerConfig({});

    expect(config.PORT).toBe(3333);
    expect(config.HOST).toBe("0.0.0.0");
    // Empty means same-origin only, which is correct behind a proxy on one domain.
    expect(config.CORS_ORIGINS).toEqual([]);
    // Undefined, not a number: the server owns its own default, and repeating it here
    // would give two places to change it and one of them would be missed.
    expect(config.RATE_LIMIT_PER_MINUTE).toBeUndefined();
  });

  it("refuses a rate limit that is not a number", () => {
    /*
     * THE BUG THIS REPLACES
     *
     * `Number("12O")` — with a letter O — is NaN, and `NaN ?? default` is NaN, because
     * ?? only catches null and undefined. That NaN reached @fastify/rate-limit, whose
     * `Number.isFinite` guard rejected it and substituted the library's own default of
     * 1000 a minute. The deployment ran at eight times the intended limit and nothing
     * anywhere said so.
     */
    expect(() => loadServerConfig({ RATE_LIMIT_PER_MINUTE: "12O" })).toThrow(
      /RATE_LIMIT_PER_MINUTE/,
    );
    expect(() => loadServerConfig({ RATE_LIMIT_PER_MINUTE: "0" })).toThrow();
    expect(() => loadServerConfig({ RATE_LIMIT_PER_MINUTE: "-5" })).toThrow();
    expect(() => loadServerConfig({ RATE_LIMIT_PER_MINUTE: "1.5" })).toThrow();

    expect(loadServerConfig({ RATE_LIMIT_PER_MINUTE: "120" }).RATE_LIMIT_PER_MINUTE).toBe(120);
  });

  it("treats a blank variable as unset rather than as zero", () => {
    // `.env.local` files are full of `FOO=` lines for things not filled in yet, and
    // Number("") is 0 — which would be a port of zero and a rate limit of none.
    const config = loadServerConfig({ PORT: "", HOST: "", RATE_LIMIT_PER_MINUTE: "" });

    expect(config.PORT).toBe(3333);
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.RATE_LIMIT_PER_MINUTE).toBeUndefined();
  });

  it("refuses a port that is not a port", () => {
    expect(() => loadServerConfig({ PORT: "not-a-port" })).toThrow(/PORT/);
    expect(() => loadServerConfig({ PORT: "0" })).toThrow(/PORT/);
    expect(() => loadServerConfig({ PORT: "70000" })).toThrow(/PORT/);

    expect(loadServerConfig({ PORT: "8080" }).PORT).toBe(8080);
  });

  it("splits and trims the CORS allowlist", () => {
    const config = loadServerConfig({
      CORS_ORIGINS: "https://orbitwatch.example, http://localhost:3000 ,",
    });

    expect(config.CORS_ORIGINS).toEqual([
      "https://orbitwatch.example",
      "http://localhost:3000",
    ]);
  });

  it("refuses an origin the browser will never send", () => {
    /*
     * The failure this prevents is not an exception — it is silence.
     *
     * @fastify/cors compares the allowlist against the Origin header verbatim. An entry
     * with no scheme, or with a trailing slash, or with a path, is not an error: it
     * simply never matches anything, and every cross-origin request is refused with no
     * indication that the allowlist is the reason. Failing at startup is the only point
     * at which this is cheap to diagnose.
     */
    expect(() => loadServerConfig({ CORS_ORIGINS: "orbitwatch.example" })).toThrow(
      /CORS_ORIGINS/,
    );
    expect(() => loadServerConfig({ CORS_ORIGINS: "https://orbitwatch.example/" })).toThrow();
    expect(() => loadServerConfig({ CORS_ORIGINS: "https://orbitwatch.example/app" })).toThrow();
    expect(() => loadServerConfig({ CORS_ORIGINS: "ftp://orbitwatch.example" })).toThrow();

    // A wildcard is not an origin either. Anyone reaching for one wants
    // `origin: true` in the server, which is a code decision, not a config value.
    expect(() => loadServerConfig({ CORS_ORIGINS: "*" })).toThrow();
  });

  it("names the offending variable without echoing its value", () => {
    // This message goes to a log store. CORS_ORIGINS is the one variable here that can
    // carry an internal hostname, and a startup failure is not a reason to publish it.
    let message = "";
    try {
      loadServerConfig({ CORS_ORIGINS: "https://internal-host.corp.example/" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("CORS_ORIGINS");
    expect(message).not.toContain("internal-host");
  });
});
