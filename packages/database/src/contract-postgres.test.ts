import { describe, it } from "vitest";
import postgres from "postgres";

import { loadDatabaseConfig } from "./config.js";
import { createPostgresDatabase } from "./postgres.js";
import { runDatabaseContractTests } from "./database-contract.js";

/**
 * The Postgres implementation against the storage contract.
 *
 * DESTRUCTIVE. This suite truncates every application table before each test, so it
 * deliberately refuses to use `DATABASE_URL`. It runs only when
 * `ORBITWATCH_TEST_DATABASE_URL` is set, and that variable must point at a database
 * that exists to be wiped.
 *
 * Requiring a separate variable is the whole safety mechanism: `pnpm test` must never
 * be able to destroy a developer's working data because the ambient environment
 * happened to be configured.
 */

const TEST_URL = process.env["ORBITWATCH_TEST_DATABASE_URL"];

/** Application tables, in no particular order — CASCADE handles the dependency. */
const TABLES = [
  "satellite_groups",
  "orbital_elements",
  "satellites",
  "provider_runs",
  "ingestion_leases",
];

if (TEST_URL === undefined || TEST_URL === "") {
  describe("storage contract: PostgresDatabase", () => {
    it.skip("requires ORBITWATCH_TEST_DATABASE_URL (destructive; must not be a real database)", () =>
      undefined);
  });
} else {
  runDatabaseContractTests("PostgresDatabase", async () => {
    const config = loadDatabaseConfig({
      ...process.env,
      // Both point at the throwaway database. The direct URL is what migrations use,
      // and the contract's first action is to create the schema.
      DATABASE_URL: TEST_URL,
      DATABASE_DIRECT_URL: TEST_URL,
    });

    const database = createPostgresDatabase(config);
    await database.migrate();

    // A separate connection for truncation: the repositories deliberately expose no way
    // to delete everything, and that restriction should not be relaxed for tests.
    const admin = postgres(TEST_URL, {
      max: 1,
      ssl: config.DATABASE_SSL ? "require" : false,
      onnotice: () => undefined,
    });

    return {
      database,
      async reset() {
        await admin.unsafe(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
      },
      async dispose() {
        await admin.end({ timeout: 5 });
        await database.close();
      },
    };
  });
}
