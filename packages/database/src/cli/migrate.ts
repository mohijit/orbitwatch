/**
 * Migration CLI.
 *
 *   pnpm --filter @orbitwatch/database migrate
 *
 * Reads configuration from the environment (and `.env.local` at the repo root), applies
 * any migrations not yet recorded, and reports what it did.
 *
 * Prints host, port and database name only. A connection string carries the password
 * inline, so a runner that echoes it puts a credential into CI logs permanently.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describeConnection, loadDatabaseConfig, migrationConnectionString } from "../config.js";
import { loadMigrations, MigrationError, runMigrations } from "../migrator.js";

/** Minimal .env reader: no dependency, and it handles quoted values and comments. */
function readEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }

  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match?.[1] === undefined) continue;
    let value = (match[2] ?? "").trim();
    // Quotes are required when a value contains '#', so strip them here.
    value = value.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
    env[match[1]] = value;
  }
  return env;
}

async function main(): Promise<void> {
  const repoRoot = resolve(process.cwd(), "..", "..");
  const env = { ...readEnvFile(resolve(repoRoot, ".env.local")), ...process.env };

  const config = loadDatabaseConfig(env);
  const connectionString = migrationConnectionString(config);

  console.log("\nOrbitWatch migrations");
  console.log(`  target : ${describeConnection(connectionString)}`);

  if (config.DATABASE_DIRECT_URL === undefined) {
    console.log(
      "  note   : DATABASE_DIRECT_URL is not set, so DATABASE_URL is being used.\n" +
        "           If that is a transaction pooler, DDL will fail. Set the direct or\n" +
        "           session connection string for migrations.",
    );
  }

  const available = await loadMigrations();
  console.log(`  found  : ${available.length} migration(s)\n`);

  const result = await runMigrations(connectionString, { ssl: config.DATABASE_SSL });

  for (const version of result.alreadyApplied) {
    console.log(`  = ${version} (already applied)`);
  }
  for (const version of result.applied) {
    console.log(`  + ${version} APPLIED`);
  }

  console.log(
    `\n${result.applied.length} applied, ${result.alreadyApplied.length} already up to date.\n`,
  );
}

try {
  await main();
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(`\nMigration failed: ${error.message}\n`);
  } else {
    console.error(`\nMigration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}
