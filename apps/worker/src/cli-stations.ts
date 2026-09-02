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
import { ingestSolarEvents } from "./ingest-solar-events.js";
import { ingestStations } from "./ingest-stations.js";

/**
 * Ingest ground stations and solar events.
 *
 *   pnpm --filter @orbitwatch/worker exec tsx src/cli-stations.ts
 *   pnpm --filter @orbitwatch/worker exec tsx src/cli-stations.ts --only stations
 *
 * Two providers in one entry point because they share a cadence and neither is on the
 * critical path for the globe. Each is still an independent run with its own lease,
 * rate policy and provider_runs row, so one failing does not affect the other.
 */
/**
 * Bypass the DURABLE rate check for this run.
 *
 * Exists because a transient failure — a timeout on a slow endpoint, say — otherwise
 * costs a full policy window before it can be retried, and the policy is ours rather
 * than the provider's. It does NOT bypass the on-disk fetch guard or any backoff the
 * provider has asked for, and it announces itself. Mirrors the same escape hatch in
 * scripts/verify-providers.ts, and deserves the same restraint.
 */
function parseForce(argv: readonly string[]): boolean {
  return argv.includes("--force");
}

function parseOnly(argv: readonly string[]): "stations" | "events" | undefined {
  const index = argv.indexOf("--only");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value !== "stations" && value !== "events") {
    throw new Error("--only takes 'stations' or 'events'");
  }
  return value;
}

async function main(): Promise<void> {
  const repoRoot = resolve(process.cwd(), "..", "..");
  const env = { ...readEnvFile(resolve(repoRoot, ".env.local")), ...process.env };
  const only = parseOnly(process.argv.slice(2));
  const force = parseForce(process.argv.slice(2));

  if (!hasDatabaseConfig(env)) {
    throw new Error(
      "DATABASE_URL is not set. Ingestion writes to the durable store and to " +
        "provider_runs, which is what enforces the provider rate policy across runs.",
    );
  }

  const config = loadDatabaseConfig(env);
  const database: Database = createPostgresDatabase(config);

  console.log("\nOrbitWatch station and solar event ingestion");
  // Host, port and database only — never the credential, not even on failure.
  console.log(`  target    : ${describeConnection(config.DATABASE_URL)}\n`);

  if (force) {
    console.warn("  ! --force: skipping the durable rate check for this run");
  }

  const http = new GuardedHttpClient(new FetchGuard());
  const logger = {
    info: (message: string, fields?: unknown) => console.log(`  · ${message}`, fields ?? ""),
    warn: (message: string, fields?: unknown) => console.warn(`  ! ${message}`, fields ?? ""),
    error: (message: string, fields?: unknown) => console.error(`  ✗ ${message}`, fields ?? ""),
  };

  let failed = false;

  try {
    if (only !== "events") {
      const stations = await ingestStations({ database, http, logger, force });
      console.log(`\n  stations  : ${stations.status}`);
      console.log(`  fetched   : ${String(stations.fetched)}`);
      console.log(`  inserted  : ${String(stations.inserted)}  updated: ${String(stations.updated)}`);
      for (const [status, count] of Object.entries(stations.byStatus)) {
        console.log(`    ${status.padEnd(10)}: ${String(count)}`);
      }
      if (stations.errorSummary !== undefined) console.log(`  note      : ${stations.errorSummary}`);
      failed ||= stations.status === "failed";
    }

    if (only !== "stations") {
      const events = await ingestSolarEvents({ database, http, logger, force });
      console.log(`\n  events    : ${events.status}`);
      console.log(`  fetched   : ${String(events.fetched)}`);
      console.log(`  inserted  : ${String(events.inserted)}  updated: ${String(events.updated)}`);
      for (const [type, count] of Object.entries(events.byType)) {
        console.log(`    ${type.padEnd(10)}: ${String(count)}`);
      }
      if (events.errorSummary !== undefined) console.log(`  note      : ${events.errorSummary}`);
      failed ||= events.status === "failed";
    }

    console.log("");
    process.exitCode = failed ? 1 : 0;
  } finally {
    await database.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(`\nIngestion failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
