import { InMemoryDatabase } from "./in-memory.js";
import { runDatabaseContractTests } from "./database-contract.js";

/**
 * The in-memory implementation against the storage contract.
 *
 * This runs unconditionally and needs no credentials, which is what lets the contract
 * be developed and trusted before a database exists. `contract-postgres.test.ts` runs
 * the same suite against Postgres.
 */
runDatabaseContractTests("InMemoryDatabase", async () => {
  let database = new InMemoryDatabase();
  return {
    get database() {
      return database;
    },
    async reset() {
      // A fresh instance is the cheapest possible truncate.
      database = new InMemoryDatabase();
    },
    async dispose() {
      await database.close();
    },
  };
});
