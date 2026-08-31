import { describe, expect, it } from "vitest";

import { redactCredentials, safeDetail } from "./redact.js";

/**
 * These exist because a real leak got through review and was caught by an API test:
 * the health endpoint quoted a driver error verbatim, and Postgres connection errors
 * routinely contain the DSN with the password in it.
 */

describe("redactCredentials", () => {
  it("removes the password from a Postgres connection string", () => {
    const leaked =
      "getaddrinfo ENOTFOUND postgresql://postgres:hunter2@db.example.supabase.co:5432/postgres";
    const safe = redactCredentials(leaked);

    expect(safe).not.toContain("hunter2");
    // The host is retained: it is what makes the diagnostic useful, and it is not secret.
    expect(safe).toContain("db.example.supabase.co");
  });

  it("removes the username as well as the password", () => {
    // The pooler username embeds the project ref, and a username is a credential half.
    const safe = redactCredentials(
      "postgres://postgres.abcdef:pw@aws-0.pooler.supabase.com:5432",
    );
    expect(safe).not.toContain("postgres.abcdef");
    expect(safe).not.toContain("pw@");
  });

  it("redacts sensitive key-value pairs", () => {
    expect(redactCredentials("connect failed password=s3cret")).not.toContain("s3cret");
    expect(redactCredentials('{"token": "abc123"}')).not.toContain("abc123");
    expect(redactCredentials("?api_key=xyz789&limit=5")).not.toContain("xyz789");
    expect(redactCredentials("Authorization: Bearer zzz")).not.toContain("zzz");
  });

  it("keeps the non-sensitive part of the message intact", () => {
    const safe = redactCredentials("?api_key=xyz789&limit=5");
    // Over-redacting is acceptable; destroying the diagnostic is not.
    expect(safe).toContain("limit=5");
  });

  it("leaves an ordinary message unchanged", () => {
    expect(redactCredentials("connection refused")).toBe("connection refused");
  });

  it("redacts an Upstash REST URL token", () => {
    const safe = redactCredentials("https://user:AX4gASQ@eu1-example.upstash.io/get/key");
    expect(safe).not.toContain("AX4gASQ");
  });
});

describe("safeDetail", () => {
  it("extracts and redacts an Error message", () => {
    const detail = safeDetail(new Error("failed for postgres://u:p@host:5432"));
    expect(detail).not.toContain(":p@");
    expect(detail).toContain("failed for");
  });

  it("collapses whitespace", () => {
    expect(safeDetail("a\n\n  b")).toBe("a b");
  });

  it("truncates a very long message", () => {
    const detail = safeDetail("x".repeat(1000));
    expect(detail?.length).toBeLessThanOrEqual(301);
    expect(detail?.endsWith("…")).toBe(true);
  });

  it("returns undefined for empty input so the field can be omitted", () => {
    expect(safeDetail("")).toBeUndefined();
    expect(safeDetail(undefined)).toBeUndefined();
    expect(safeDetail("   ")).toBeUndefined();
  });
});
