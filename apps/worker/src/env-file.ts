import { readFileSync } from "node:fs";

/**
 * Minimal .env reader, shared by the ingestion CLIs.
 *
 * No dependency: it handles comments and quoted values, which is the whole of what a
 * local development file needs. Extracted from cli.ts when a second CLI needed it, so
 * that two entry points cannot drift into parsing credentials differently.
 *
 * A missing file is not an error — the variables may come from the real environment,
 * which is how this runs in CI and in production.
 */
export function readEnvFile(path: string): Record<string, string> {
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
    const value = (match[2] ?? "")
      .trim()
      .replace(/^"(.*)"$/s, "$1")
      .replace(/^'(.*)'$/s, "$1");
    env[match[1]] = value;
  }
  return env;
}
