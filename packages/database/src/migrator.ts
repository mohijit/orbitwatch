import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

/**
 * Migration runner.
 *
 * Three properties matter more than convenience here:
 *
 *   1. **Checksums are verified, not just recorded.** If a migration file changes after
 *      it was applied, every environment that already ran it now has a schema that no
 *      longer matches the file describing it. Detecting that at deploy time is the
 *      difference between a loud failure and a database nobody can reason about.
 *
 *   2. **One migration per transaction.** A failed migration leaves no partial schema.
 *      Postgres supports transactional DDL, so there is no excuse not to use it.
 *
 *   3. **An advisory lock guards the whole run.** Two instances starting at once during
 *      a rolling deploy would otherwise race to apply the same migration.
 *
 * The runner needs a SESSION connection, not a transaction pooler: DDL and advisory
 * locks both require session state. That is why `DATABASE_DIRECT_URL` exists.
 */

/**
 * Namespaced advisory lock id. Arbitrary but fixed — it only has to be unique.
 * Kept below Number.MAX_SAFE_INTEGER so it survives the round trip as a JS number.
 */
const MIGRATION_LOCK_ID = 8_531_004_119_672_301;

export interface Migration {
  readonly version: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly version: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

/** Where the .sql files live, relative to this module in both src/ and dist/. */
export function defaultMigrationsDirectory(): string {
  return fileURLToPath(new URL("../migrations/", import.meta.url));
}

/**
 * Hash a migration's content.
 *
 * Line endings are normalised first. Without that, the same file checked out on Windows
 * (CRLF) and in CI (LF) produces different checksums, and the drift detector would fire
 * on every deploy — training everyone to ignore it, which is worse than not having it.
 * A trailing-newline difference is likewise not a schema change.
 */
export function checksumMigration(sql: string): string {
  const normalized = sql.replace(/\r\n/g, "\n").trimEnd();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Load migrations from disk, ordered by filename.
 *
 * Filenames are zero-padded (`0001_`, `0002_`) so lexicographic order is also numeric
 * order. That is checked rather than assumed: an unpadded `10_foo.sql` would silently
 * sort before `2_bar.sql` and apply the schema out of order.
 */
export async function loadMigrations(
  directory: string = defaultMigrationsDirectory(),
): Promise<readonly Migration[]> {
  const entries = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();

  const migrations: Migration[] = [];
  for (const entry of entries) {
    const prefix = /^(\d+)_/.exec(entry);
    if (prefix === null) {
      throw new MigrationError(
        `Migration "${entry}" must start with a zero-padded number, e.g. 0003_add_thing.sql. ` +
          `Unnumbered files cannot be ordered reliably.`,
        entry,
      );
    }
    const sql = await readFile(join(directory, entry), "utf8");
    migrations.push({
      version: entry.replace(/\.sql$/, ""),
      sql,
      checksum: checksumMigration(sql),
    });
  }

  assertOrderingIsUnambiguous(migrations);
  return migrations;
}

/** Guard against mixed-width numbering, where sort order stops matching intent. */
function assertOrderingIsUnambiguous(migrations: readonly Migration[]): void {
  const widths = new Set(
    migrations.map((migration) => (/^(\d+)_/.exec(migration.version)?.[1] ?? "").length),
  );
  if (widths.size > 1) {
    throw new MigrationError(
      `Migration filenames use inconsistent number widths (${[...widths].sort().join(", ")} digits). ` +
        `Lexicographic order would stop matching numeric order. Pad them all to the same width.`,
      migrations[0]?.version ?? "(none)",
    );
  }
}

/**
 * Apply every migration not yet recorded, in order.
 *
 * Safe to call on every boot: already-applied migrations are skipped, and their
 * checksums are verified while we are here.
 */
export async function runMigrations(
  connectionString: string,
  options: { readonly directory?: string; readonly ssl?: boolean } = {},
): Promise<MigrationResult> {
  const migrations = await loadMigrations(options.directory);

  const sql = postgres(connectionString, {
    max: 1,
    connect_timeout: 30,
    idle_timeout: 5,
    ssl: (options.ssl ?? true) ? "require" : false,
    onnotice: () => undefined,
  });

  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
          version     TEXT        PRIMARY KEY,
          applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          checksum    TEXT        NOT NULL
      )
    `);

    // Serialise concurrent deploys. Released automatically when the session ends, so a
    // crashed migrator cannot wedge the lock permanently.
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`;

    try {
      const recorded = await sql<{ version: string; checksum: string }[]>`
        SELECT version, checksum FROM schema_migrations
      `;
      const checksumByVersion = new Map(recorded.map((row) => [row.version, row.checksum]));

      const applied: string[] = [];
      const alreadyApplied: string[] = [];

      for (const migration of migrations) {
        const existing = checksumByVersion.get(migration.version);

        if (existing !== undefined) {
          if (existing !== migration.checksum) {
            throw new MigrationError(
              `Migration "${migration.version}" was already applied, but its file has changed ` +
                `since (recorded checksum ${existing.slice(0, 12)}…, file is ` +
                `${migration.checksum.slice(0, 12)}…). Applied migrations are immutable: ` +
                `add a new migration instead of editing this one.`,
              migration.version,
            );
          }
          alreadyApplied.push(migration.version);
          continue;
        }

        try {
          // Transactional DDL: a failure here leaves no half-built schema behind.
          await sql.begin(async (tx) => {
            await tx.unsafe(migration.sql);
            await tx`
              INSERT INTO schema_migrations (version, checksum)
              VALUES (${migration.version}, ${migration.checksum})
            `;
          });
        } catch (error) {
          throw new MigrationError(
            `Migration "${migration.version}" failed and was rolled back: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            migration.version,
            error,
          );
        }

        applied.push(migration.version);
      }

      return { applied, alreadyApplied };
    } finally {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`.catch(() => undefined);
    }
  } finally {
    await sql.end({ timeout: 10 }).catch(() => undefined);
  }
}
