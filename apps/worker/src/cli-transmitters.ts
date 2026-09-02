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
import { ingestTransmitters } from "./ingest-transmitters.js";

/**
 * Ingest radio transmitters from the SatNOGS DB.
 *
 *   pnpm --filter @orbitwatch/worker exec tsx src/cli-transmitters.ts
 *   pnpm --filter @orbitwatch/worker exec tsx src/cli-transmitters.ts --satellite 25544
 *
 * Separate from the elements CLI on purpose. They are different providers with
 * different cadences and different failure modes, and a scheduler should be able to
 * run one without the other — a SatNOGS outage must not stop orbital elements being
 * refreshed, which is what the globe actually depends on.
 *
 * The guarded client and the durable rate policy apply exactly as they do everywhere
 * else: this cannot be used to hammer the provider by running it repeatedly.
 */

function parseSatellite(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--satellite");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--satellite requires a catalog number");
  }
  if (!/^[0-9]{1,6}$/.test(value)) {
    throw new Error(`"${value}" is not a catalog number`);
  }
  return value;
}

async function main(): Promise<void> {
  const repoRoot = resolve(process.cwd(), "..", "..");
  const env = { ...readEnvFile(resolve(repoRoot, ".env.local")), ...process.env };
  const satellite = parseSatellite(process.argv.slice(2));

  if (!hasDatabaseConfig(env)) {
    throw new Error(
      "DATABASE_URL is not set. Ingestion writes to the durable store and to " +
        "provider_runs, which is what enforces the provider rate policy across runs.",
    );
  }

  const config = loadDatabaseConfig(env);
  const database: Database = createPostgresDatabase(config);

  console.log("\nOrbitWatch transmitter ingestion");
  // Host, port and database only — never the credential, not even on failure.
  console.log(`  target    : ${describeConnection(config.DATABASE_URL)}`);
  console.log(`  scope     : ${satellite === undefined ? "all transmitters" : `NORAD ${satellite}`}\n`);

  const http = new GuardedHttpClient(new FetchGuard());

  try {
    const result = await ingestTransmitters({
      database,
      http,
      ...(satellite === undefined ? {} : { catalogId: satellite }),
      logger: {
        info: (message, fields) => console.log(`  · ${message}`, fields ?? ""),
        warn: (message, fields) => console.warn(`  ! ${message}`, fields ?? ""),
        error: (message, fields) => console.error(`  ✗ ${message}`, fields ?? ""),
      },
    });

    console.log("");
    console.log(`  status    : ${result.status}`);
    console.log(`  fetched   : ${String(result.fetched)}`);
    console.log(`  inserted  : ${String(result.inserted)}`);
    console.log(`  updated   : ${String(result.updated)}`);
    console.log(`  rejected  : ${String(result.rejected)}`);
    console.log(`  duration  : ${String(Math.round(result.durationMs))} ms`);
    if (result.errorSummary !== undefined) console.log(`  note      : ${result.errorSummary}`);
    console.log("");

    // `skipped` is success for a scheduler: the rate policy did its job.
    process.exitCode = result.status === "failed" ? 1 : 0;
  } finally {
    await database.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `\nTransmitter ingestion failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
