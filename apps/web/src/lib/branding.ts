/**
 * Product branding, isolated so the name can be changed in one place.
 *
 * Nothing else in the codebase should hard-code the product name.
 */
export const BRANDING = {
  name: "OrbitWatch",
  shortName: "OrbitWatch",
  tagline: "Real-time orbital tracking",
  description:
    "Track satellites in real time. Positions are calculated from recently published orbital elements using SGP4/SDP4 — not continuous onboard telemetry.",
} as const;
