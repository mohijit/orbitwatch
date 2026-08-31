import { z } from "zod";

/**
 * Database configuration, read from the environment and validated at startup.
 *
 * CREDENTIAL HANDLING
 * Credentials are read from the process environment and never appear anywhere else.
 * They are not committed, not embedded in source, not written to fixtures, and not
 * logged. `describeConnection` exists precisely so that diagnostics, health output and
 * error messages can identify a connection WITHOUT revealing it — a connection string
 * carries the password inline, so logging it once puts it in the log store forever.
 *
 * Validation happens once, at startup, so a misconfigured deployment fails immediately
 * and loudly rather than at the first query under load.
 */

const databaseConfigSchema = z.object({
  /**
   * Postgres connection string.
   *
   * Supabase supplies this. Prefer the POOLED connection string for the API (many
   * short-lived connections) and the DIRECT one for migrations, which need a session
   * that survives DDL.
   */
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "DATABASE_URL must be a postgres:// or postgresql:// connection string",
    ),

  /**
   * Direct (non-pooled) connection, used only by the migration runner.
   *
   * Falls back to DATABASE_URL when unset, which is correct for a local Postgres but
   * wrong for Supabase's transaction pooler, where DDL needs a session connection.
   */
  DATABASE_DIRECT_URL: z.preprocess(
    // An empty variable means "not set". Without this, migrationConnectionString would
    // return "" instead of falling back to DATABASE_URL, because ?? only catches
    // undefined — and migrations would fail with an unhelpful parse error.
    (value) => (value === "" ? undefined : value),
    z.string().optional(),
  ),

  /** Maximum pool size. Kept low by default: Supabase free tier limits connections. */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),

  /** Statement timeout in milliseconds, so one bad query cannot pin a connection. */
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  /**
   * Whether to require TLS. Hosted Postgres always should; a local container may not
   * offer it. Defaults to on, because the failure mode of defaulting off is silent
   * plaintext credentials over the network.
   */
  DATABASE_SSL: z
    .union([z.literal("true"), z.literal("false")])
    .default("true")
    .transform((value) => value === "true"),
});

export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

export class ConfigurationError extends Error {
  constructor(
    message: string,
    readonly missingKeys: readonly string[],
  ) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * Load and validate database configuration.
 *
 * The error message names the missing variables but never echoes any value, so a
 * startup failure in a shared log does not leak a password that was merely malformed.
 */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const parsed = databaseConfigSchema.safeParse(env);

  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    const details = parsed.error.issues
      .map((issue) => `${String(issue.path[0])}: ${issue.message}`)
      .join("; ");
    throw new ConfigurationError(
      `Database configuration is invalid. ${details}. ` +
        `Set these in your environment or .env.local; never commit them.`,
      keys,
    );
  }

  return parsed.data;
}

/** The connection the migration runner should use. */
export function migrationConnectionString(config: DatabaseConfig): string {
  return config.DATABASE_DIRECT_URL ?? config.DATABASE_URL;
}

/**
 * A safe, human-readable description of a connection, for logs and health output.
 *
 * Returns host, port and database name only. Username, password and query parameters
 * are dropped entirely rather than masked, because a masked value still reveals length
 * and shape.
 */
export function describeConnection(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const database = url.pathname.replace(/^\//, "") || "(default)";
    const port = url.port === "" ? "5432" : url.port;
    return `${url.hostname}:${port}/${database}`;
  } catch {
    return "(unparseable connection string)";
  }
}

/**
 * Whether database configuration is present, without throwing.
 *
 * Lets the API and worker start in a degraded, clearly-labelled mode when no database
 * is configured, instead of crash-looping. Milestones before persistence depend on
 * this.
 */
export function hasDatabaseConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env["DATABASE_URL"] === "string" && env["DATABASE_URL"].length > 0;
}
