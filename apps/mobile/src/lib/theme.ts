/**
 * Shared visual constants.
 *
 * Deliberately a plain object rather than a styling library. The mobile UI is native
 * and small; a theming runtime would add a dependency and a re-render path to solve a
 * problem four screens do not have. The values match the web shell so the two products
 * read as one, and `@orbitwatch/design-tokens` supersedes this when it lands.
 */
export const theme = {
  background: "#070b14",
  surface: "#0e1421",
  border: "rgba(148, 176, 214, 0.18)",
  text: "#e8eef8",
  textMuted: "#8ba0bd",
  accent: "#35c8f5",
  good: "#4ade80",
  warn: "#facc15",
  bad: "#f4a548",
} as const;

/** Monospace face by platform, for figures that must not jitter as digits change. */
export const MONO = { android: "monospace", ios: "Menlo", default: "monospace" } as const;
