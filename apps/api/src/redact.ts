/**
 * Credential redaction for outbound diagnostics.
 *
 * Health and error output quote messages produced by drivers we do not control, and
 * those messages can contain the thing that caused the failure — which for a database
 * is very often the connection string, password included. Postgres drivers routinely
 * embed the DSN in connection errors.
 *
 * So any driver text that reaches a client passes through here first. This is a last
 * line of defence, not a licence to be careless about what gets quoted: the primary
 * rule is still that internal errors are logged, not served.
 */

/** Longest diagnostic detail served to a client. Beyond this it is noise anyway. */
const MAX_DETAIL_LENGTH = 300;

/**
 * Sensitive query and key-value parameters.
 *
 * Matches `password=secret`, `token: secret`, `apikey="secret"` and similar, in query
 * strings, in JSON fragments (where the key carries a closing quote before the colon)
 * and in prose error messages alike.
 *
 * The value alternatives are ordered so an auth scheme is consumed together with the
 * credential that follows it: matching `Bearer` alone would leave the token in place,
 * which is the one thing that actually needed removing.
 */
const SENSITIVE_KEY_PATTERN =
  /\b(password|passwd|pwd|token|api[-_]?key|secret|authorization|auth|access[-_]?key)\b("?\s*[=:]\s*)((?:Bearer|Basic|Token|Digest)\s+\S+|"[^"]*"|'[^']*'|[^\s,;&)}\]]+)/gi;

/** URL userinfo: the `user:password@` between a scheme and a host. */
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;

/**
 * Remove anything credential-shaped from a string.
 *
 * Deliberately aggressive. Over-redacting a diagnostic costs a little debugging
 * convenience; under-redacting writes a password into a log store or a browser's
 * network tab, where it stays.
 */
export function redactCredentials(value: string): string {
  return value
    .replace(URL_USERINFO_PATTERN, "$1[redacted]@")
    .replace(
      SENSITIVE_KEY_PATTERN,
      (_match, key: string, separator: string) => `${key}${separator}[redacted]`,
    );
}

/**
 * Prepare a driver message for a client response.
 *
 * Redacts, collapses whitespace, and truncates. Returns undefined for anything empty so
 * a caller can omit the field rather than serving an empty string.
 */
export function safeDetail(value: unknown): string | undefined {
  const text = value instanceof Error ? value.message : String(value ?? "");
  const cleaned = redactCredentials(text).replace(/\s+/g, " ").trim();
  if (cleaned === "") return undefined;
  return cleaned.length > MAX_DETAIL_LENGTH
    ? `${cleaned.slice(0, MAX_DETAIL_LENGTH)}…`
    : cleaned;
}
