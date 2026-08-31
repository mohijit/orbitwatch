import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createMemoryCache } from "@orbitwatch/cache";
import { InMemoryDatabase } from "@orbitwatch/database";

import { buildServer } from "./server.js";

/**
 * Seeded in-memory API server, for end-to-end tests only.
 *
 * The Playwright suite needs a real HTTP round trip — a genuine fetch, genuine JSON,
 * genuine Zod parsing on both ends — without depending on `DATABASE_URL`. A fork's
 * pull request has no secrets and must still be able to run the full E2E suite, so
 * this exists to give it something real to talk to.
 *
 * Seeded from the ACTUAL CelesTrak fixtures captured and verified in M2
 * (fixtures/celestrak-gp-iss.json, fixtures/celestrak-satcat-iss.json) rather than
 * invented data — the same standing rule that governs every fixture in this repo.
 *
 *   pnpm --filter @orbitwatch/api exec tsx src/seed-dev.ts
 */

const PORT = Number(process.env["PORT"] ?? 3333);
const repoRoot = resolve(process.cwd(), "..", "..");

function readFixture(name: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(resolve(repoRoot, "fixtures", name), "utf8"));
  return (raw as Record<string, unknown>[])[0] as Record<string, unknown>;
}

async function main(): Promise<void> {
  const gp = readFixture("celestrak-gp-iss.json");
  const satcat = readFixture("celestrak-satcat-iss.json");

  const database = new InMemoryDatabase();

  await database.satellites.upsertMany([
    {
      catalogId: "25544",
      name: String(satcat["OBJECT_NAME"]),
      internationalDesignator: String(satcat["OBJECT_ID"]),
      objectType: "PAYLOAD",
      operationalStatus: "OPERATIONAL",
      owner: String(satcat["OWNER"]),
      launchDate: new Date(`${String(satcat["LAUNCH_DATE"])}T00:00:00.000Z`),
      launchSite: String(satcat["LAUNCH_SITE"]),
      decayDate: undefined,
      periodMinutes: Number(satcat["PERIOD"]),
      inclinationDegrees: Number(satcat["INCLINATION"]),
      apogeeKm: Number(satcat["APOGEE"]),
      perigeeKm: Number(satcat["PERIGEE"]),
      rcsSquareMetres: Number(satcat["RCS"]),
      orbitClass: "LEO",
      metadata: {},
      sourceProvider: "celestrak",
      updatedAt: new Date(),
    },
  ]);

  const epoch = new Date(`${String(gp["EPOCH"])}Z`);
  await database.elements.insertMany([
    {
      catalogId: "25544",
      provider: "celestrak",
      format: "OMM_JSON",
      epoch,
      retrievedAt: new Date(),
      omm: gp,
      tleLine1: undefined,
      tleLine2: undefined,
      meanMotion: Number(gp["MEAN_MOTION"]),
      eccentricity: Number(gp["ECCENTRICITY"]),
      inclination: Number(gp["INCLINATION"]),
      bstar: Number(gp["BSTAR"]),
    },
  ]);

  const app = await buildServer({
    database,
    cache: createMemoryCache(),
    version: "e2e-seed",
    corsOrigins: ["http://127.0.0.1:3100", "http://localhost:3100"],
    rateLimitPerMinute: 10_000,
  });

  await app.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`Seeded E2E API listening on http://127.0.0.1:${String(PORT)}`);
}

await main();
