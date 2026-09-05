import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createCacheFromEnv } from "@orbitwatch/cache";
import {
  createPostgresDatabase,
  describeConnection,
  hasDatabaseConfig,
  InMemoryDatabase,
  loadDatabaseConfig,
  type Database,
} from "@orbitwatch/database";

import { loadServerConfig } from "./config.js";
import { buildServer } from "./server.js";

/**
 * API entrypoint.
 *
 * The only file that reads the environment. `buildServer` takes its dependencies as
 * arguments, which is what keeps the entire HTTP surface testable without credentials.
 *
 * Credentials are consumed through environment configuration and never logged. Startup
 * output identifies the database by host, port and name only — a connection string
 * carries its password inline, so printing one puts a credential in the log store
 * permanently.
 */

/** Minimal .env reader, so local development does not need a runner flag. */
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
    value = value.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
    env[match[1]] = value;
  }
  return env;
}
async function main(): Promise<void> {
  const repoRoot = resolve(process.cwd(), "..", "..");
  const env = { ...readEnvFile(resolve(repoRoot, ".env.local")), ...process.env };

  const config = loadServerConfig(env);
  const { PORT: port, HOST: host } = config;

  let database: Database;
  if (hasDatabaseConfig(env)) {
    const config = loadDatabaseConfig(env);
    database = createPostgresDatabase(config);
    console.log(`  database : ${describeConnection(config.DATABASE_URL)}`);
  } else {
    // Explicitly announced. An API silently running on a database that vanishes at
    // restart is far more dangerous than one that refuses to start, so if this is
    // unexpected the operator finds out at boot rather than after losing data.
    database = new InMemoryDatabase();
    console.warn(
      "  database : IN-MEMORY (DATABASE_URL is not set)\n" +
        "             Data will not survive a restart. Set DATABASE_URL for anything\n" +
        "             other than local development.",
    );
  }

  const cache = createCacheFromEnv(env);
  console.log(
    `  cache    : ${cache.hasSharedLayer ? "shared (Upstash) + in-process" : "in-process only"}`,
  );

  const app = await buildServer({
    database,
    cache,
    version: env["npm_package_version"] ?? "0.0.0",
    logger: true,
    ...(config.CORS_ORIGINS.length > 0 ? { corsOrigins: config.CORS_ORIGINS } : {}),
    ...(config.RATE_LIMIT_PER_MINUTE === undefined
      ? {}
      : { rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE }),
  });

  /**
   * Close connections before exiting, but never wait forever to do it.
   *
   * WHY THE DEADLINE IS THE IMPORTANT PART
   * Closing matters: without it a redeploy leaves pooled Postgres connections held
   * until they time out server-side, and the free tier's connection ceiling is low
   * enough that a few rapid restarts exhaust it.
   *
   * But an unbounded close is worse than no close. This used to await each shutdown in
   * turn, and `sql.end()` does not resolve at all when the database has stopped
   * answering -- so Ctrl+C against an unreachable database printed "shutting down" and
   * then hung indefinitely, still holding the port. Measured by sending a real console
   * Ctrl+C event: the process was still listening 25 seconds later. From the outside
   * that looks exactly like Ctrl+C not working, and the natural next move is to kill
   * the window -- which strands precisely the connections this was written to release.
   *
   * So the cleanup races a deadline and the deadline always wins eventually. Losing a
   * graceful close costs connections the server will reclaim on its own timeout; not
   * exiting costs the port and the developer's trust in the signal.
   */
  const SHUTDOWN_DEADLINE_MS = 5_000;

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    /*
     * A second signal exits immediately. Anyone pressing Ctrl+C twice has decided they
     * are done waiting, and the right answer is to go, not to explain.
     */
    if (shuttingDown) {
      console.log(`${signal} again - exiting now.`);
      process.exit(130);
    }
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down.`);

    // unref, so a clean and fast close is not held open by its own timer.
    const deadline = new Promise<"timeout">((resolve) => {
      setTimeout(() => {
        resolve("timeout");
      }, SHUTDOWN_DEADLINE_MS).unref();
    });

    try {
      const outcome = await Promise.race([
        (async () => {
          await app.close();
          await database.close();
          await cache.close();
          return "closed" as const;
        })(),
        deadline,
      ]);

      if (outcome === "timeout") {
        console.warn(
          `Connections did not close within ${String(SHUTDOWN_DEADLINE_MS)}ms - exiting anyway.`,
        );
      }
    } catch (error) {
      // A close that throws is still a close we are finished with.
      console.warn("Error while closing:", error instanceof Error ? error.message : error);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port, host });
  console.log(`\nOrbitWatch API listening on http://${host}:${String(port)}\n`);
}

await main();
