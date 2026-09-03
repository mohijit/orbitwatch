import { z } from "zod";

/**
 * The API's own configuration, validated at startup.
 *
 * Its own module rather than part of main.ts because main.ts calls itself at import
 * time: anything defined there can only be exercised by starting a server.
 *
 * CREDENTIAL HANDLING
 * Nothing here is a credential -- the database and cache read their own, through their
 * own schemas. The one variable that could carry something an operator would rather not
 * publish is CORS_ORIGINS, which may name an internal hostname, so the error path names
 * variables and never echoes values.
 */

/**
 * An empty variable means "not set", not "set to empty".
 *
 * `.env.local` files are full of `FOO=` lines for things the operator has not filled
 * in, and readEnvFile returns "" for those. Without this, `PORT=` would coerce to 0 and
 * fail validation instead of falling back to the default.
 */
const blankAsUndefined = (value: unknown): unknown => (value === "" ? undefined : value);

/**
 * Is this a browser origin, as the Origin header will actually present it?
 *
 * Scheme and host with no path, no trailing slash, no query, no fragment. Strict on
 * purpose: @fastify/cors compares the allowlist against the Origin header verbatim, so
 * `example.com` or `https://example.com/` do not throw — they simply never match, and
 * the deployment gets a CORS wall nobody can explain. Rejecting them at startup turns a
 * silent misconfiguration into a loud one.
 */
function isBrowserOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.host.length > 0 &&
    // Parsing normalises a bare origin to a "/" path, so the two checks together mean
    // "no path at all": pathname rejects `/app`, and the raw string rejects the
    // trailing slash that parsing would otherwise have hidden.
    url.pathname === "/" &&
    !value.endsWith("/") &&
    url.search === "" &&
    url.hash === ""
  );
}

/**
 * The API's own configuration, validated at startup.
 *
 * The database and cache packages have always validated their environment through a
 * schema; this file was reading its own with bare `Number(...)`, which does not fail —
 * it produces NaN. `RATE_LIMIT_PER_MINUTE=12O` (letter O) reached @fastify/rate-limit
 * as NaN, was rejected by its `Number.isFinite` guard, and silently became the
 * library's own default of 1000 a minute instead of the 120 that was intended. Nothing
 * anywhere said so.
 *
 * A misconfigured deployment should fail immediately and loudly rather than run at
 * settings nobody chose.
 */
const serverConfigSchema = z.object({
  PORT: z.preprocess(blankAsUndefined, z.coerce.number().int().min(1).max(65_535).default(3333)),

  HOST: z.preprocess(blankAsUndefined, z.string().min(1).default("0.0.0.0")),

  /**
   * Comma-separated browser origins. Empty means same-origin only, which is correct
   * when the web app is proxied through its own domain.
   */
  CORS_ORIGINS: z.preprocess(
    blankAsUndefined,
    z
      .string()
      .optional()
      .transform((value) =>
        (value ?? "")
          .split(",")
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      )
      .refine((origins) => origins.every(isBrowserOrigin), {
        message:
          "each entry must be a scheme and host with no trailing slash, " +
          "e.g. https://orbitwatch.example",
      }),
  ),

  /** Our own limit, protecting this service. Unset means the server's default. */
  RATE_LIMIT_PER_MINUTE: z.preprocess(
    blankAsUndefined,
    z.coerce.number().int().positive().max(1_000_000).optional(),
  ),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;

/**
 * Validate, or refuse to start.
 *
 * The message names the offending variables and quotes zod's reason, but never echoes
 * a value: this output goes to a log store, and CORS_ORIGINS is the one variable here
 * that could carry an internal hostname.
 */
export function loadServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const parsed = serverConfigSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${String(issue.path[0])}: ${issue.message}`)
      .join("; ");
    throw new Error(`API configuration is invalid. ${details}.`);
  }
  return parsed.data;
}
