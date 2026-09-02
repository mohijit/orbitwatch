import { resolve } from "node:path";

import {
  createPostgresDatabase,
  describeConnection,
  hasDatabaseConfig,
  loadDatabaseConfig,
  type Database,
} from "@orbitwatch/database";
import { FetchGuard, GuardedHttpClient } from "@orbitwatch/providers";

import { readEnvFile } from "./env-file.js";
import { ingestSpaceWeather } from "./ingest-space-weather.js";

/**
 * Ingest space weather from NOAA SWPC.
 *
 *   pnpm --filter @orbitwatch/worker exec tsx src/cli-space-weather.ts
 *
 * Separate from the other ingestion entry points so a scheduler can run them
 * independently: NOAA refreshes every few minutes where orbital elements refresh every
 * few hours, and a NOAA outage must not stop the elements the globe depends on.
 */
async function main(): Promise<void> {
  const repoRoot = resolve(process.cwd(), "..", "..");
  const env = { ...readEnvFile(resolve(repoRoot, ".env.local")), ...process.env };

  if (!hasDatabaseConfig(env)) {
    throw new Error(
      "DATABASE_URL is not set. Ingestion writes to the durable store and to " +
        "provider_runs, which is what enforces the provider rate policy across runs.",
    );
  }

  const config = loadDatabaseConfig(env);
  const database: Database = createPostgresDatabase(config);

  console.log("\nOrbitWatch space weather ingestion");
  // Host, port and database only — never the credential, not even on failure.
  console.log(`  target    : ${describeConnection(config.DATABASE_URL)}\n`);

  const http = new GuardedHttpClient(new FetchGuard());

  try {
    const result = await ingestSpaceWeather({
      database,
      http,
      logger: {
        info: (message, fields) => console.log(`  · ${message}`, fields ?? ""),
        warn: (message, fields) => console.warn(`  ! ${message}`, fields ?? ""),
        error: (message, fields) => console.error(`  ✗ ${message}`, fields ?? ""),
      },
    });

    console.log("");
    console.log(`  status    : ${result.status}`);
    console.log(`  inserted  : ${String(result.inserted)}`);
    console.log(`  updated   : ${String(result.updated)}`);
    for (const [source, detail] of Object.entries(result.sources)) {
      console.log(`  ${source.padEnd(18)}: ${detail}`);
    }
    console.log(`  duration  : ${String(Math.round(result.durationMs))} ms\n`);

    process.exitCode = result.status === "failed" ? 1 : 0;
  } finally {
    await database.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `\nSpace weather ingestion failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
