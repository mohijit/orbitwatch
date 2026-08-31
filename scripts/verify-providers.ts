/**
 * Milestone 0 provider verification.
 *
 * Makes AT MOST ONE request per provider resource, through the same FetchGuard that
 * production ingestion uses, and records what actually came back. The point is to
 * replace assumptions about third-party APIs with observed evidence, and to freeze
 * that evidence into fixtures so the rest of the build can be developed and tested
 * without touching upstream again.
 *
 *   pnpm verify:providers            # verify every provider
 *   pnpm verify:providers celestrak  # verify only matching providers
 *   pnpm verify:providers --force    # ignore the interval guard (USE SPARINGLY)
 *
 * --force exists for the genuine first run against a provider whose guard entry was
 * written by an earlier aborted attempt. It does not bypass an active backoff.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  FetchGuard,
  GuardedHttpClient,
  ProviderHttpError,
  ProviderRefusedError,
  policyFor,
  type ProviderId,
} from "../packages/providers/src/index.js";

interface ProbeSpec {
  readonly provider: ProviderId;
  readonly resource: string;
  readonly url: string;
  /** What we expect to learn. Printed alongside the result. */
  readonly verifies: string;
  /** Fixture filename, relative to /fixtures. */
  readonly fixture: string;
  /** Cap the stored fixture so we do not commit multi-megabyte payloads. */
  readonly maxFixtureBytes?: number;
  /** Override the default request timeout for a known-slow provider. */
  readonly timeoutMs?: number;
}

const ROOT = process.cwd();
const FIXTURE_DIR = join(ROOT, "fixtures");

/**
 * Deliberately small probes. We verify SHAPE, not volume — a single satellite tells
 * us the field names, and the bulk groups are the ingestion worker's job in M2.
 */
const PROBES: readonly ProbeSpec[] = [
  {
    provider: "celestrak-gp",
    resource: "catnr-25544",
    url: "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=json",
    verifies: "OMM JSON field names for json2satrec; ISS elements",
    fixture: "celestrak-gp-iss.json",
    timeoutMs: 90_000,
  },
  {
    provider: "celestrak-satcat",
    resource: "catnr-25544",
    url: "https://celestrak.org/satcat/records.php?CATNR=25544&FORMAT=json",
    verifies: "SATCAT metadata field names (object type, owner, launch site, RCS)",
    fixture: "celestrak-satcat-iss.json",
  },
  {
    provider: "satnogs-db",
    resource: "transmitters-25544",
    url: "https://db.satnogs.org/api/transmitters/?satellite__norad_cat_id=25544&format=json",
    verifies: "transmitter schema: downlink/uplink, mode, baud, status",
    fixture: "satnogs-transmitters-iss.json",
    timeoutMs: 90_000,
  },
  {
    provider: "satnogs-db",
    resource: "satellites-25544",
    url: "https://db.satnogs.org/api/satellites/?norad_cat_id=25544&format=json",
    verifies: "SatNOGS satellite record shape and sat_id linkage",
    fixture: "satnogs-satellite-iss.json",
  },
  {
    provider: "launch-library",
    resource: "upcoming",
    url: "https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=5&mode=list",
    verifies: "LL2 2.3.0 launch list shape; confirms rate-limit headers",
    fixture: "launch-library-upcoming.json",
  },
  {
    provider: "noaa-swpc",
    resource: "planetary-k-index",
    url: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
    verifies: "Kp product format (array-of-arrays with header row)",
    fixture: "noaa-planetary-k-index.json",
    maxFixtureBytes: 64 * 1024,
  },
  {
    provider: "noaa-swpc",
    resource: "propagated-solar-wind",
    // NOTE: services.swpc.noaa.gov/products/solar-wind/ does NOT exist (HTTP 404),
    // despite being widely cited. The real product lives under geospace/ and is
    // already propagated to Earth, which is what we want for satellite context.
    url: "https://services.swpc.noaa.gov/products/geospace/propagated-solar-wind-1-hour.json",
    verifies: "solar wind speed, density and IMF Bz propagated to Earth",
    fixture: "noaa-propagated-solar-wind.json",
    maxFixtureBytes: 64 * 1024,
  },
  {
    provider: "noaa-swpc",
    resource: "noaa-scales",
    url: "https://services.swpc.noaa.gov/products/noaa-scales.json",
    verifies: "NOAA R/S/G scale values for the space weather dashboard",
    fixture: "noaa-scales.json",
  },
  {
    provider: "wheretheiss",
    resource: "iss-position",
    url: "https://api.wheretheiss.at/v1/satellites/25544",
    verifies: "independent ISS position source for SGP4 cross-checking",
    fixture: "wheretheiss-iss.json",
  },
];

type Outcome =
  | { kind: "verified"; bytes: number; contentType: string; summary: string }
  | { kind: "skipped"; detail: string }
  | { kind: "refused"; detail: string }
  | { kind: "failed"; detail: string };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const filters = argv.filter((a) => !a.startsWith("--"));

  const selected = PROBES.filter(
    (p) =>
      filters.length === 0 ||
      filters.some((f) => p.provider.includes(f) || p.resource.includes(f)),
  );

  if (selected.length === 0) {
    console.error(`No probes matched: ${filters.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  await mkdir(FIXTURE_DIR, { recursive: true });

  const client = new GuardedHttpClient(new FetchGuard());
  const results = new Map<ProbeSpec, Outcome>();

  console.log(`\nOrbitWatch provider verification — ${selected.length} probe(s)\n`);

  for (const probe of selected) {
    const policy = policyFor(probe.provider);
    process.stdout.write(`  ${probe.provider}/${probe.resource} ... `);

    try {
      const result = await client.get(probe.url, {
        provider: probe.provider,
        resource: probe.resource,
        // --force collapses the interval but leaves backoff enforcement intact,
        // because backoff means upstream explicitly told us to stop.
        ...(force ? { minIntervalMs: 0 } : {}),
        ...(probe.timeoutMs === undefined ? {} : { timeoutMs: probe.timeoutMs }),
      });

      if (result.status === "skipped") {
        const mins = Math.ceil(result.retryAfterMs / 60_000);
        results.set(probe, {
          kind: "skipped",
          detail:
            result.reason === "backoff-active"
              ? `backoff active, ${mins} min remaining`
              : `fetched ${describeAge(result.lastFetchedAt)}; next allowed in ${mins} min`,
        });
        console.log("SKIPPED (guard)");
        continue;
      }

      const summary = summarise(result.body, result.contentType);
      const stored = truncate(result.body, probe.maxFixtureBytes);
      await writeFile(join(FIXTURE_DIR, probe.fixture), stored, "utf8");

      results.set(probe, {
        kind: "verified",
        bytes: Buffer.byteLength(result.body, "utf8"),
        contentType: result.contentType.split(";")[0] ?? result.contentType,
        summary,
      });
      console.log(`OK (${formatBytes(Buffer.byteLength(result.body, "utf8"))})`);
    } catch (error) {
      if (error instanceof ProviderRefusedError) {
        results.set(probe, {
          kind: "refused",
          detail: `HTTP ${error.httpStatus}; backing off until ${error.backoffUntil.toISOString()}`,
        });
        console.log(`REFUSED (HTTP ${error.httpStatus})`);
      } else if (error instanceof ProviderHttpError) {
        results.set(probe, {
          kind: "failed",
          detail: `HTTP ${error.httpStatus}: ${error.bodyExcerpt}`,
        });
        console.log(`FAILED (HTTP ${error.httpStatus})`);
      } else {
        results.set(probe, { kind: "failed", detail: describeError(error) });
        console.log(`FAILED (${describeError(error)})`);
      }
    }

    void policy;
  }

  report(results);
}

function report(results: Map<ProbeSpec, Outcome>): void {
  console.log("\n" + "-".repeat(76));
  console.log("RESULTS\n");

  for (const [probe, outcome] of results) {
    console.log(`${probe.provider}/${probe.resource}`);
    console.log(`  verifies : ${probe.verifies}`);
    switch (outcome.kind) {
      case "verified":
        console.log(`  status   : VERIFIED (${outcome.contentType}, ${formatBytes(outcome.bytes)})`);
        console.log(`  shape    : ${outcome.summary}`);
        console.log(`  fixture  : fixtures/${probe.fixture}`);
        break;
      case "skipped":
        console.log(`  status   : SKIPPED — ${outcome.detail}`);
        break;
      case "refused":
        console.log(`  status   : REFUSED — ${outcome.detail}`);
        break;
      case "failed":
        console.log(`  status   : FAILED — ${outcome.detail}`);
        break;
    }
    console.log("");
  }

  const counts = { verified: 0, skipped: 0, refused: 0, failed: 0 };
  for (const outcome of results.values()) counts[outcome.kind] += 1;

  console.log("-".repeat(76));
  console.log(
    `verified ${counts.verified}  skipped ${counts.skipped}  ` +
      `refused ${counts.refused}  failed ${counts.failed}`,
  );

  if (counts.refused > 0) {
    console.log(
      "\nA provider refused us. Per CelesTrak's M2M guidance this run stopped rather\n" +
        "than retrying; backoff has been recorded. Investigate before running again.",
    );
  }
  // A failed probe is information, not a build break — providers go down, and the
  // adapter still needs building. Refusals are different: they mean we misbehaved.
  process.exitCode = counts.refused > 0 ? 1 : 0;
}

/** Describes the top-level structure of a response without dumping it. */
function summarise(body: string, contentType: string): string {
  if (contentType.includes("json") || body.trimStart().startsWith("[") || body.trimStart().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (Array.isArray(parsed)) {
        const first: unknown = parsed[0];
        const keys =
          first !== null && typeof first === "object" && !Array.isArray(first)
            ? Object.keys(first as Record<string, unknown>)
            : [];
        return keys.length > 0
          ? `array[${parsed.length}], first object keys: ${preview(keys)}`
          : `array[${parsed.length}] of ${Array.isArray(first) ? "arrays" : typeof first}`;
      }
      if (parsed !== null && typeof parsed === "object") {
        return `object, keys: ${preview(Object.keys(parsed as Record<string, unknown>))}`;
      }
      return `scalar ${typeof parsed}`;
    } catch {
      return "declared JSON but did not parse";
    }
  }

  const lines = body.split(/\r?\n/);
  return `text, ${lines.length} lines, first line: ${(lines[0] ?? "").slice(0, 90)}`;
}

function preview(keys: readonly string[]): string {
  const shown = keys.slice(0, 12).join(", ");
  return keys.length > 12 ? `${shown}, … (+${keys.length - 12})` : shown;
}

function truncate(body: string, maxBytes: number | undefined): string {
  if (maxBytes === undefined || Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  return `${body.slice(0, maxBytes)}\n/* truncated by verify-providers to ${maxBytes} bytes */`;
}

function describeAge(when: Date | undefined): string {
  if (!when) return "at an unknown time";
  const minutes = Math.round((Date.now() - when.getTime()) / 60_000);
  return minutes < 60 ? `${minutes} min ago` : `${(minutes / 60).toFixed(1)} h ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause !== null && typeof cause === "object" && "code" in cause) {
      return `${error.message} (${String((cause as { code?: unknown }).code)})`;
    }
    return error.message;
  }
  return String(error);
}

await main();
