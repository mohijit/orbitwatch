import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createMemoryCache } from "@orbitwatch/cache";
import { InMemoryDatabase } from "@orbitwatch/database";
import { GuardedHttpClient, type GuardedFetchResult } from "@orbitwatch/providers";
import { ingestOrbitalElements, ingestTransmitters } from "@orbitwatch/worker";

import { buildServer } from "./server.js";

/**
 * Seeded in-memory API server, for end-to-end tests only.
 *
 * The Playwright suite needs a real HTTP round trip — a genuine fetch, genuine JSON,
 * genuine Zod parsing on both ends — without depending on `DATABASE_URL`. A fork's
 * pull request has no secrets and must still be able to run the full E2E suite, so
 * this exists to give it something real to talk to.
 *
 * THE DATA IS REAL
 * Both fixtures are unmodified CelesTrak GP records exported from rows this project
 * actually ingested (see `packages/database/src/cli/export-e2e-fixture.ts` and
 * `fixtures/manifest.json`): a subset of one GROUP=active response for the catalog,
 * and a subset of one GROUP=visual response for the brightness list. Not one value is
 * invented, and no request leaves the machine when this runs.
 *
 * IT IS LOADED THE WAY PRODUCTION LOADS IT
 * The fixture is not turned into database rows here. It is replayed through
 * `ingestOrbitalElements` — the same VALIDATE → NORMALIZE → COMPARE → STORE → LOG pipeline
 * the real worker runs — with the network step replaced by a reader that returns the
 * fixture bytes. That means the E2E suite exercises schema validation, catalog-id
 * normalisation, SGP4 initialisation and placeholder satellite creation for real. A
 * seed that hand-built rows would skip all of it, and a field rename that breaks
 * ingestion in production would still pass E2E.
 *
 *   pnpm --filter @orbitwatch/api exec tsx src/seed-dev.ts
 */

const PORT = Number(process.env["PORT"] ?? 3333);
const repoRoot = resolve(process.cwd(), "..", "..");
const FIXTURE_FILE = "celestrak-gp-e2e-subset.json";

/**
 * A subset of one real GROUP=visual response.
 *
 * Replayed as a second ingestion so the seeded API knows which objects CelesTrak
 * curates as bright enough to see. That membership cannot be derived from the
 * elements — GP records carry no brightness at all — and without it "Visible Tonight"
 * has nothing to search.
 */
const VISUAL_FIXTURE_FILE = "celestrak-gp-e2e-visual.json";

/**
 * A real SatNOGS DB response: 50 transmitters for the ISS, captured in M0.
 *
 * Replayed through the same ingestion the scheduled worker runs, so the E2E suite
 * exercises schema validation, normalisation and the upsert rather than hand-built
 * rows. Radio is a separate provider with its own licence and cadence, and the seed
 * treats it as one.
 */
const TRANSMITTERS_FIXTURE_FILE = "satnogs-transmitters-iss.json";

/**
 * The moment the fixture's records were actually retrieved from CelesTrak.
 *
 * Read from `fixtures/manifest.json` rather than hard-coded, so the retrieval time
 * this server reports cannot drift from the provenance record that justifies it. It
 * becomes the response's `fetchedAt`, which is what makes the API state the retrieval
 * time the data genuinely has instead of the time this process happened to start —
 * two different facts that this product refuses to conflate.
 */
function fixtureRetrievedAt(): Date {
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, "fixtures", "manifest.json"), "utf8"),
  ) as { fixtures?: { file?: string; retrievedAt?: string }[] };

  const entry = manifest.fixtures?.find((candidate) => candidate.file === FIXTURE_FILE);
  if (entry?.retrievedAt === undefined) {
    throw new Error(`fixtures/manifest.json has no retrievedAt for ${FIXTURE_FILE}.`);
  }
  return new Date(entry.retrievedAt);
}

const FIXTURE_RETRIEVED_AT = fixtureRetrievedAt();

/**
 * Replays captured provider bytes instead of making a request.
 *
 * Subclasses `GuardedHttpClient` rather than reimplementing its interface so that a
 * caller cannot be handed something that merely looks like the guarded client. `get`
 * is overridden to never touch the network, which is what makes it impossible for the
 * E2E suite to reach CelesTrak — a stricter guarantee than remembering not to.
 */
class FixtureHttpClient extends GuardedHttpClient {
  readonly #body: string;

  constructor(body: string) {
    super();
    this.#body = body;
  }

  override get(): Promise<GuardedFetchResult> {
    return Promise.resolve({
      status: "fetched",
      body: this.#body,
      contentType: "application/json",
      fetchedAt: FIXTURE_RETRIEVED_AT,
    });
  }
}

async function main(): Promise<void> {
  const body = readFileSync(resolve(repoRoot, "fixtures", FIXTURE_FILE), "utf8");
  const database = new InMemoryDatabase();

  const result = await ingestOrbitalElements({
    database,
    http: new FixtureHttpClient(body),
    // The group the fixture was drawn from. It never reaches a URL, but it is what
    // provider_runs records, so it should name the real source.
    query: { kind: "GROUP", value: "active" },
    holder: "e2e-seed",
  });

  if (result.status !== "success" || result.inserted === 0) {
    // Failing loudly here is the point: a fixture that no longer satisfies the
    // ingestion schema must stop the suite, not quietly serve an empty catalog and
    // turn every downstream assertion into a confusing timeout.
    throw new Error(
      `E2E seed ingestion did not succeed: status=${result.status} ` +
        `fetched=${String(result.fetched)} inserted=${String(result.inserted)} ` +
        `rejected=${String(result.rejected)} ${result.errorSummary ?? ""}`,
    );
  }

  // Second replay: the visual group. Runs through the same pipeline, which is what
  // records group membership — the seed does not write it directly.
  const visualBody = readFileSync(resolve(repoRoot, "fixtures", VISUAL_FIXTURE_FILE), "utf8");
  const visual = await ingestOrbitalElements({
    database,
    http: new FixtureHttpClient(visualBody),
    query: { kind: "GROUP", value: "visual" },
    holder: "e2e-seed",
  });

  if (visual.status !== "success") {
    throw new Error(
      `E2E seed visual-group ingestion did not succeed: status=${visual.status} ` +
        `${visual.errorSummary ?? ""}`,
    );
  }

  // Third replay: radio. Failure here is reported but not fatal — the catalog and the
  // observer features do not depend on it, and a suite that cannot start because one
  // optional provider's fixture drifted would hide the failures that matter.
  const transmitterBody = readFileSync(
    resolve(repoRoot, "fixtures", TRANSMITTERS_FIXTURE_FILE),
    "utf8",
  );
  const radio = await ingestTransmitters({
    database,
    http: new FixtureHttpClient(transmitterBody),
    catalogId: "25544",
    holder: "e2e-seed",
  });

  if (radio.status !== "success") {
    console.warn(
      `E2E seed transmitter ingestion was ${radio.status}: ${radio.errorSummary ?? "no detail"}`,
    );
  }

  const app = await buildServer({
    database,
    cache: createMemoryCache(),
    version: "e2e-seed",
    corsOrigins: ["http://127.0.0.1:3100", "http://localhost:3100"],
    rateLimitPerMinute: 10_000,
  });

  await app.listen({ port: PORT, host: "127.0.0.1" });
  console.log(
    `Seeded E2E API listening on http://127.0.0.1:${String(PORT)} — ` +
      `${String(result.inserted)} objects from fixtures/${FIXTURE_FILE}, ` +
      `${String(visual.fetched)} visual-group members, ` +
      `${String(radio.inserted)} transmitters`,
  );
}

await main();
