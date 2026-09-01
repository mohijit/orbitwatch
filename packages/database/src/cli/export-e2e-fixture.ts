/**
 * Export a small, representative E2E fixture from already-ingested data.
 *
 * WHY THIS EXISTS
 * The E2E suite used to exercise a single object — the ISS — which cannot distinguish
 * "the catalog pipeline works" from "the catalog pipeline works for exactly one item".
 * A multi-object fixture is needed, and the only honest sources for one are a live
 * provider request or data we have already ingested. CelesTrak firewalls repeat
 * callers, so this takes the second route: the rows in Postgres are unmodified
 * CelesTrak GP records, so a subset of them is real provider data by construction.
 *
 * WHAT IT PRODUCES
 * `fixtures/celestrak-gp-e2e-subset.json` — a bare JSON array of OMM records, the
 * exact shape `gp.php?FORMAT=json` returns and `parseGpResponse` consumes. That is
 * what lets the E2E seed replay it through the real ingestion pipeline rather than
 * hand-constructing database rows.
 *
 * WHAT IS AND IS NOT MODIFIED
 * Record VALUES are copied verbatim; not one number is touched. What is dropped is the
 * storage wrapper, which is not part of the provider's response and not reproducible
 * across environments: the identity column, `created_at`, `first_seen_at`, and the
 * all-null SATCAT metadata columns that GP ingestion never fills in. Key ORDER is
 * whatever JSONB returns, which is already not the wire order — Postgres does not
 * preserve it. That is recorded in the manifest rather than papered over.
 *
 * SELECTION
 * Every record comes from ONE ingestion run, so the file is a subset of a single real
 * response rather than a composite of several. Within it, objects are bucketed by
 * orbit class — derived here exactly as the app derives it, from the elements
 * themselves — and the lowest catalog IDs in each bucket are taken. Low IDs are old
 * objects, which yields distinct recognisable names rather than a wall of Starlink.
 * The ISS is always included, because the existing E2E path names it.
 *
 * Deterministic: the same database produces the same file, byte for byte.
 *
 *   pnpm --filter @orbitwatch/database exec tsx src/cli/export-e2e-fixture.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  deriveOrbitGeometry,
  normalizeCatalogId,
  parseOmm,
  type OMMJsonObject,
  type OrbitClass,
} from "@orbitwatch/orbit-core";
import postgres from "postgres";

/** Objects per orbit class. Small enough that the E2E suite stays fast. */
const PER_ORBIT_CLASS = 6;

/** Always present: the existing E2E path names the ISS by catalog id and by name. */
const ALWAYS_INCLUDE = ["25544"];

const FIXTURE_FILE = "celestrak-gp-e2e-subset.json";

/** Minimal .env reader, mirroring check-connection.ts. No dependency, no side effects. */
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

/** Host, port and database only — never the credential. */
function describe(url: string): string {
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, "") || "(default)";
    return `${parsed.hostname}:${parsed.port || "5432"}/${database}`;
  } catch {
    return "(unparseable)";
  }
}

/**
 * Stable catalog-id ordering.
 *
 * Catalog ids are TEXT because of Alpha-5 (ADR 0004), so a plain string sort puts "9"
 * after "10000". Comparing length first, then lexicographically, orders numeric ids
 * correctly and still gives a total order over Alpha-5 ids.
 */
function compareCatalogIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

interface Candidate {
  readonly catalogId: string;
  readonly name: string;
  readonly epoch: Date;
  readonly orbitClass: OrbitClass;
  readonly omm: Record<string, unknown>;
}

interface SourceRow {
  readonly catalog_id: string;
  readonly name: string;
  readonly epoch: Date;
  readonly omm: Record<string, unknown>;
}

async function main(): Promise<void> {
  const repoRoot = resolve(process.cwd(), "..", "..");
  const env = { ...readEnvFile(resolve(repoRoot, ".env.local")), ...process.env };
  const url = env["DATABASE_URL"];

  if (url === undefined || url.length === 0) {
    console.error("DATABASE_URL is not configured in .env.local.");
    process.exitCode = 1;
    return;
  }

  console.log(`\nExporting E2E fixture from ${describe(url)}`);
  console.log("(host, port and database only — credentials are never printed)\n");

  const sql = postgres(url, {
    max: 1,
    connect_timeout: 20,
    ssl: "require",
    onnotice: () => undefined,
  });

  try {
    // One run, so the fixture is a subset of a single real response rather than a
    // composite assembled from several fetches with different retrieval times.
    const runRows = await sql<{ retrieved_at: Date | null }[]>`
      SELECT max(retrieved_at) AS retrieved_at FROM orbital_elements
    `;
    const retrievedAt = runRows[0]?.retrieved_at ?? undefined;
    if (retrievedAt === undefined) {
      throw new Error("orbital_elements is empty — run the ingestion worker first.");
    }

    const rows = await sql<SourceRow[]>`
      SELECT e.catalog_id, s.name, e.epoch, e.omm
      FROM orbital_elements e
      JOIN satellites s ON s.catalog_id = e.catalog_id
      WHERE e.retrieved_at = ${retrievedAt}
      ORDER BY e.catalog_id
    `;

    console.log(`  source run       : retrieved_at ${retrievedAt.toISOString()}`);
    console.log(`  candidate objects: ${String(rows.length)}\n`);

    // Classify from the elements, exactly as the web app does. The satellites table
    // cannot answer this: GP ingestion writes placeholder rows with orbit_class NULL,
    // because the GP feed genuinely does not say.
    const candidates: Candidate[] = [];
    let unusable = 0;

    for (const row of rows) {
      const catalogId = normalizeCatalogId(row.omm["NORAD_CAT_ID"]);
      if (catalogId === undefined) {
        unusable += 1;
        continue;
      }
      try {
        const { satrec } = parseOmm(row.omm as unknown as OMMJsonObject, {
          provider: "celestrak",
          retrievedAt,
        });
        candidates.push({
          catalogId,
          name: row.name,
          epoch: row.epoch,
          orbitClass: deriveOrbitGeometry(satrec).orbitClass,
          omm: row.omm,
        });
      } catch {
        // An object SGP4 cannot initialise makes a poor fixture member: it would be
        // rejected on load and the count assertions would then disagree for a reason
        // that has nothing to do with the code under test.
        unusable += 1;
      }
    }

    const byClass = new Map<OrbitClass, Candidate[]>();
    for (const candidate of candidates) {
      const bucket = byClass.get(candidate.orbitClass) ?? [];
      bucket.push(candidate);
      byClass.set(candidate.orbitClass, bucket);
    }

    console.log("  orbit class distribution across the whole run:");
    for (const [orbitClass, bucket] of [...byClass].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`    ${orbitClass.padEnd(8)} ${String(bucket.length).padStart(6)}`);
    }
    if (unusable > 0) console.log(`    (${String(unusable)} unusable, excluded)`);

    const selected = new Map<string, Candidate>();
    for (const bucket of byClass.values()) {
      bucket.sort((a, b) => compareCatalogIds(a.catalogId, b.catalogId));
      for (const candidate of bucket.slice(0, PER_ORBIT_CLASS)) {
        selected.set(candidate.catalogId, candidate);
      }
    }
    for (const catalogId of ALWAYS_INCLUDE) {
      const candidate = candidates.find((entry) => entry.catalogId === catalogId);
      if (candidate === undefined) {
        throw new Error(
          `${catalogId} is absent from the source run, so the E2E path that names it would break.`,
        );
      }
      selected.set(catalogId, candidate);
    }

    const chosen = [...selected.values()].sort((a, b) =>
      compareCatalogIds(a.catalogId, b.catalogId),
    );

    console.log(`\n  selected ${String(chosen.length)} objects:\n`);
    for (const candidate of chosen) {
      console.log(
        `    ${candidate.catalogId.padStart(6)}  ${candidate.orbitClass.padEnd(8)}` +
          `  ${candidate.epoch.toISOString()}  ${candidate.name}`,
      );
    }

    const epochs = chosen.map((candidate) => candidate.epoch.getTime());
    const issEpoch = chosen.find((candidate) => candidate.catalogId === "25544")?.epoch;

    const body = `${JSON.stringify(chosen.map((candidate) => candidate.omm))}\n`;
    writeFileSync(resolve(repoRoot, "fixtures", FIXTURE_FILE), body, "utf8");

    console.log(
      `\n  epoch range      : ${new Date(Math.min(...epochs)).toISOString()}` +
        ` .. ${new Date(Math.max(...epochs)).toISOString()}`,
    );
    console.log(`  ISS epoch        : ${issEpoch?.toISOString() ?? "(absent)"}`);
    console.log(
      `  classes present  : ${[...new Set(chosen.map((entry) => entry.orbitClass))].sort().join(", ")}`,
    );
    console.log(`  wrote            : fixtures/${FIXTURE_FILE} (${String(body.length)} bytes)`);
    console.log("\n  Record the provenance in fixtures/manifest.json before committing.\n");
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

await main();
