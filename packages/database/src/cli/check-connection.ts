/**
 * Connection diagnostic.
 *
 * Opens a real connection to each configured database URL and reports what happened.
 * Exists because a connection string can be well-formed and still wrong — the wrong
 * pooler host, an IPv6-only endpoint on an IPv4 network, or a password that parses but
 * is not accepted. Finding that out here is far cheaper than finding it out from a
 * half-applied migration.
 *
 * Prints host, port and database name only. The credential is never echoed, not even
 * on failure, because a diagnostic that leaks a password into a terminal scrollback is
 * worse than no diagnostic.
 *
 *   pnpm --filter @orbitwatch/database exec tsx src/cli/check-connection.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import postgres from "postgres";

interface Target {
  readonly name: string;
  readonly url: string;
}

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
    // Strip surrounding quotes, which are required when a value contains '#'.
    value = value.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
    env[match[1]] = value;
  }
  return env;
}

/** Host, port and database only. Never the userinfo. */
function describe(url: string): string {
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, "") || "(default)";
    return `${parsed.hostname}:${parsed.port || "5432"}/${database}`;
  } catch {
    return "(unparseable)";
  }
}

/** Translate a driver error into something that suggests a fix. */
function explain(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);

  switch (code) {
    case "ENOTFOUND":
      return `host does not resolve (${code}) — likely the wrong pooler hostname`;
    case "ECONNREFUSED":
      return `connection refused (${code}) — nothing listening on that port`;
    case "ENETUNREACH":
      return `network unreachable (${code}) — typically an IPv6-only endpoint on an IPv4 network; use the Session pooler instead`;
    case "ETIMEDOUT":
    case "CONNECT_TIMEOUT":
      return `timed out (${code}) — firewall, or an IPv6-only endpoint on an IPv4 network`;
    case "28P01":
      return "password authentication failed — check the password, and percent-encode any # @ : / ? % characters";
    case "3D000":
      return "database does not exist";
    default:
      return code === "" ? message : `${code}: ${message}`;
  }
}

async function probe(target: Target): Promise<boolean> {
  process.stdout.write(`  ${target.name.padEnd(20)} ${describe(target.url)}\n`);

  const sql = postgres(target.url, {
    max: 1,
    connect_timeout: 15,
    idle_timeout: 1,
    ssl: "require",
    onnotice: () => undefined,
  });

  try {
    const started = Date.now();
    const rows = await sql`
      select current_database() as database,
             current_user      as user,
             version()         as version
    `;
    const elapsed = Date.now() - started;
    const row = rows[0] as { database: string; user: string; version: string } | undefined;

    console.log(`  ${"".padEnd(20)} CONNECTED in ${elapsed} ms`);
    console.log(`  ${"".padEnd(20)}   database : ${row?.database ?? "?"}`);
    console.log(`  ${"".padEnd(20)}   user     : ${row?.user ?? "?"}`);
    console.log(
      `  ${"".padEnd(20)}   server   : ${(row?.version ?? "").split(" ").slice(0, 2).join(" ")}`,
    );

    // DDL support is what separates a usable migration connection from a pooled one.
    try {
      await sql.unsafe("create temporary table _orbitwatch_probe (id int)");
      await sql.unsafe("drop table _orbitwatch_probe");
      console.log(`  ${"".padEnd(20)}   DDL      : supported (usable for migrations)`);
    } catch {
      console.log(
        `  ${"".padEnd(20)}   DDL      : NOT supported (transaction pooler — fine for queries, not migrations)`,
      );
    }

    return true;
  } catch (error) {
    console.log(`  ${"".padEnd(20)} FAILED — ${explain(error)}`);
    return false;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const repoRoot = resolve(process.cwd(), "..", "..");
  const env = { ...readEnvFile(resolve(repoRoot, ".env.local")), ...process.env };

  const targets: Target[] = [];
  for (const name of ["DATABASE_URL", "DATABASE_DIRECT_URL"]) {
    const url = env[name];
    if (url !== undefined && url.length > 0) targets.push({ name, url });
  }

  if (targets.length === 0) {
    console.error("No DATABASE_URL or DATABASE_DIRECT_URL configured in .env.local.");
    process.exitCode = 1;
    return;
  }

  console.log("\nOrbitWatch database connection check");
  console.log("(host, port and database only — credentials are never printed)\n");

  let anyFailed = false;
  for (const target of targets) {
    const ok = await probe(target);
    if (!ok) anyFailed = true;
    console.log("");
  }

  process.exitCode = anyFailed ? 1 : 0;
}

await main();
