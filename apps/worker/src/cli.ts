/**
 * One-shot ingestion runner.
 *
 *   pnpm --filter @orbitwatch/worker ingest
 *   pnpm --filter @orbitwatch/worker ingest -- --group stations
 *
 * Runs a single ingestion and exits, which is the shape a scheduler wants: GitHub
 * Actions cron, a Kubernetes CronJob and a plain crontab all invoke a process rather
 * than supervise one. There is deliberately no internal timer.
 *
 * SAFETY
 * Rate policy is enforced in two places and neither is this file. The durable guard in
 * `ingestOrbitalElements` reads provider_runs, which survives an ephemeral runner; the
 * on-disk FetchGuard backstops a long-lived host. Running this on a tight schedule is
 * therefore safe: extra invocations report `skipped` without contacting the provider.
 *
 * Prints no credentials. On a public repository, CI logs are public.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createPostgresDatabase,
  describeConnection,
  hasDatabaseConfig,
  loadDatabaseConfig,
  type Database,
} from "@orbitwatch/database";
import { CELESTRAK_GROUPS, FetchGuard, GuardedHttpClient } from "@orbitwatch/providers";
import type { CelestrakGroup } from "@orbitwatch/providers";

import { ingestOrbitalElements, type IngestionResult } from "./ingest-elements.js";

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
    const value = (match[2] ?? "")
      .trim()
      .replace(/^"(.*)"$/s, "$1")
      .replace(/^'(.*)'$/s, "$1");
    env[match[1]] = value;
  }
  return env;
}

/** Parse `--group <name>`, defaulting to the catalog backbone. */
function parseGroup(argv: readonly string[]): CelestrakGroup {
  const index = argv.indexOf("--group");
  if (index === -1) return "active";

  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error("--group requires a value");
  }
  if (!(CELESTRAK_GROUPS as readonly string[]).includes(value)) {
    throw new Error(
      `Unknown group "${value}". Supported: ${CELESTRAK_GROUPS.join(", ")}`,
    );
  }
  return value as CelestrakGroup;
}

function report(result: IngestionResult): void {
  const lines = [
    `  status    : ${result.status.toUpperCase()}`,
    `  fetched   : ${result.fetched}`,
    `  inserted  : ${result.inserted}`,
    `  unchanged : ${result.unchanged}`,
    `  rejected  : ${result.rejected}`,
    `  duration  : ${result.durationMs} ms`,
  ];
  if (result.skippedReason !== undefined) lines.push(`  reason    : ${result.skippedReason}`);
  if (result.errorSummary !== undefined) lines.push(`  error     : ${result.errorSummary}`);
  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const repoRoot = resolve(process.cwd(), "..", "..");
  const env = { ...readEnvFile(resolve(repoRoot, ".env.local")), ...process.env };
  const group = parseGroup(process.argv.slice(2));

  if (!hasDatabaseConfig(env)) {
    // Refused rather than silently ingesting into memory. A scheduled job that appears
    // to succeed while persisting nothing is worse than one that fails.
    throw new Error(
      "DATABASE_URL is not set. Ingestion writes to the durable store and to " +
        "provider_runs, which is also what enforces the provider rate policy across " +
        "runs, so an in-memory database would defeat both.",
    );
  }

  const config = loadDatabaseConfig(env);
  const database: Database = createPostgresDatabase(config);

  console.log("\nOrbitWatch ingestion");
  console.log(`  target    : ${describeConnection(config.DATABASE_URL)}`);
  console.log(`  group     : ${group}\n`);

  const http = new GuardedHttpClient(new FetchGuard());

  try {
    const result = await ingestOrbitalElements({
      database,
      http,
      query: { kind: "GROUP", value: group },
      logger: {
        info: (message, fields) => console.log(`  · ${message}`, fields ?? ""),
        warn: (message, fields) => console.warn(`  ! ${message}`, fields ?? ""),
        error: (message, fields) => console.error(`  ✗ ${message}`, fields ?? ""),
      },
    });

    console.log("");
    report(result);
    console.log("");

    // `skipped` is a success for a scheduler: the rate policy did its job, and failing
    // the job would turn correct behaviour into a red build every few minutes.
    process.exitCode = result.status === "failed" ? 1 : 0;
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
