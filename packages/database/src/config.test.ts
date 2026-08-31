import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  describeConnection,
  hasDatabaseConfig,
  loadDatabaseConfig,
  migrationConnectionString,
} from "./config.js";

const POOLED =
  "postgresql://user:pw@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres";
const DIRECT =
  "postgresql://user:pw@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres";

describe("loadDatabaseConfig", () => {
  it("accepts a minimal configuration and applies defaults", () => {
    const config = loadDatabaseConfig({ DATABASE_URL: POOLED });

    expect(config.DATABASE_URL).toBe(POOLED);
    expect(config.DATABASE_POOL_MAX).toBe(10);
    expect(config.DATABASE_STATEMENT_TIMEOUT_MS).toBe(30_000);
    // TLS defaults on: the failure mode of defaulting off is plaintext credentials
    // crossing the network.
    expect(config.DATABASE_SSL).toBe(true);
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => loadDatabaseConfig({})).toThrow(ConfigurationError);
  });

  it("rejects a connection string with the wrong scheme", () => {
    expect(() => loadDatabaseConfig({ DATABASE_URL: "mysql://host/db" })).toThrow(
      /postgres/,
    );
  });

  it("names the offending variable without echoing its value", () => {
    let message = "";
    try {
      loadDatabaseConfig({ DATABASE_URL: "mysql://user:hunter2@host/db" });
    } catch (error) {
      message = String(error);
    }

    expect(message).toContain("DATABASE_URL");
    // A malformed connection string is still a credential.
    expect(message).not.toContain("hunter2");
  });

  it("treats an empty DATABASE_DIRECT_URL as absent", () => {
    // `cp .env.example .env.local` leaves variables set to the empty string. Without
    // this, migrationConnectionString returned "" rather than falling back, because
    // `??` only catches undefined.
    const config = loadDatabaseConfig({ DATABASE_URL: POOLED, DATABASE_DIRECT_URL: "" });

    expect(config.DATABASE_DIRECT_URL).toBeUndefined();
    expect(migrationConnectionString(config)).toBe(POOLED);
  });

  it("uses the direct URL for migrations when one is set", () => {
    const config = loadDatabaseConfig({
      DATABASE_URL: POOLED,
      DATABASE_DIRECT_URL: DIRECT,
    });

    // Migrations issue DDL, which a transaction pooler does not support.
    expect(migrationConnectionString(config)).toBe(DIRECT);
  });

  it("coerces numeric settings from strings", () => {
    const config = loadDatabaseConfig({
      DATABASE_URL: POOLED,
      DATABASE_POOL_MAX: "5",
      DATABASE_STATEMENT_TIMEOUT_MS: "1000",
      DATABASE_SSL: "false",
    });

    expect(config.DATABASE_POOL_MAX).toBe(5);
    expect(config.DATABASE_STATEMENT_TIMEOUT_MS).toBe(1000);
    expect(config.DATABASE_SSL).toBe(false);
  });
});

describe("describeConnection", () => {
  it("reports host, port and database only", () => {
    expect(describeConnection(POOLED)).toBe(
      "aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres",
    );
  });

  it("never includes the credential", () => {
    const described = describeConnection(POOLED);
    // Dropped entirely rather than masked: a masked value still reveals length and shape.
    expect(described).not.toContain("user");
    expect(described).not.toContain("pw");
  });

  it("defaults the port when the URL omits it", () => {
    expect(describeConnection("postgresql://u:p@host/db")).toBe("host:5432/db");
  });

  it("does not throw on an unparseable string", () => {
    expect(describeConnection("nonsense")).toBe("(unparseable connection string)");
  });
});

describe("hasDatabaseConfig", () => {
  it("is false when unset or empty", () => {
    expect(hasDatabaseConfig({})).toBe(false);
    expect(hasDatabaseConfig({ DATABASE_URL: "" })).toBe(false);
  });

  it("is true when set", () => {
    expect(hasDatabaseConfig({ DATABASE_URL: POOLED })).toBe(true);
  });
});
