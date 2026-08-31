import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checksumMigration, loadMigrations, MigrationError } from "./migrator.js";

/**
 * Tests for the parts of the migration runner that do not need a database.
 *
 * The parts that do — advisory locking, transactional rollback, drift detection against
 * recorded checksums — are exercised by `contract-postgres.test.ts`, which runs the
 * migrations for real.
 */

async function makeMigrationDirectory(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "orbitwatch-migrations-"));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents, "utf8");
  }
  return directory;
}

describe("checksumMigration", () => {
  it("is stable across line endings", async () => {
    // Without normalisation the same file checked out on Windows (CRLF) and in CI (LF)
    // would hash differently, and the drift detector would fire on every deploy —
    // training everyone to ignore it, which is worse than not having it.
    expect(checksumMigration("CREATE TABLE a;\nCREATE TABLE b;\n")).toBe(
      checksumMigration("CREATE TABLE a;\r\nCREATE TABLE b;\r\n"),
    );
  });

  it("ignores trailing whitespace", () => {
    expect(checksumMigration("SELECT 1;")).toBe(checksumMigration("SELECT 1;\n\n  "));
  });

  it("changes when the SQL changes", () => {
    expect(checksumMigration("CREATE TABLE a;")).not.toBe(
      checksumMigration("CREATE TABLE b;"),
    );
  });
});

describe("loadMigrations", () => {
  it("loads the project's own migrations in order", async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(2);
    expect(migrations[0]?.version).toBe("0001_initial_schema");
    expect(migrations[1]?.version).toBe("0002_element_retention");
    for (const migration of migrations) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(migration.sql.length).toBeGreaterThan(0);
    }
  });

  it("orders by the numeric prefix", async () => {
    const directory = await makeMigrationDirectory({
      "0002_second.sql": "SELECT 2;",
      "0001_first.sql": "SELECT 1;",
      "0010_tenth.sql": "SELECT 10;",
    });

    expect((await loadMigrations(directory)).map((m) => m.version)).toEqual([
      "0001_first",
      "0002_second",
      "0010_tenth",
    ]);
  });

  it("ignores non-SQL files", async () => {
    const directory = await makeMigrationDirectory({
      "0001_first.sql": "SELECT 1;",
      "README.md": "not a migration",
    });

    expect((await loadMigrations(directory)).map((m) => m.version)).toEqual([
      "0001_first",
    ]);
  });

  it("rejects an unnumbered migration", async () => {
    const directory = await makeMigrationDirectory({ "add_thing.sql": "SELECT 1;" });
    await expect(loadMigrations(directory)).rejects.toThrow(MigrationError);
  });

  it("rejects mixed-width numbering", async () => {
    // "10_" sorts before "2_" lexicographically, so the schema would be built in the
    // wrong order. Failing here is far cheaper than diagnosing that later.
    const directory = await makeMigrationDirectory({
      "2_second.sql": "SELECT 2;",
      "10_tenth.sql": "SELECT 10;",
    });

    await expect(loadMigrations(directory)).rejects.toThrow(/inconsistent number widths/);
  });

  it("returns nothing for an empty directory", async () => {
    expect(await loadMigrations(await makeMigrationDirectory({}))).toEqual([]);
  });
});
