import type { ObserverLocation, SatellitePass } from "@orbitwatch/orbit-core";

import { shareableUrl } from "./deep-links";

/**
 * Text for sharing a pass or an object.
 *
 * SHARED TEXT OUTLIVES ITS CONTEXT
 * A screenshot or a message is read hours later, by someone somewhere else, with none
 * of the app around it. So the text carries what it needs to remain true: the date as
 * well as the time, the location it was computed for, and the fact that this is a
 * prediction from orbital elements rather than an observation. Everything the app is
 * careful about on screen can be lost the moment a string leaves it.
 *
 * NO COORDINATES, EVER
 * The observer's label is shared; their latitude and longitude are not. An observing
 * location is a home address to within a few metres, and a share sheet is exactly the
 * place where someone would give theirs away without meaning to.
 *
 * A pure function of its inputs, and therefore testable — which matters because the
 * failure here is not a crash but a sentence that says something untrue.
 */

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const VISIBILITY_PHRASE = {
  LIKELY_VISIBLE: "Should be visible in a clear sky",
  POSSIBLY_VISIBLE: "Might be visible — low, or entering shadow",
  NOT_OPTICALLY_FAVOURABLE: "Not favourable for seeing it",
  DAYLIGHT: "Overhead, but in daylight — not visible",
  SATELLITE_IN_SHADOW: "Overhead, but in Earth's shadow — not visible",
} as const;

export interface PassShareInput {
  readonly catalogId: string;
  readonly name: string;
  readonly pass: SatellitePass;
  readonly observer: ObserverLocation | undefined;
}

/**
 * Describe a pass in a form that survives being pasted somewhere else.
 *
 * The visibility phrase is never omitted, including when it is bad news. A share that
 * quoted only the geometry — "peaks at 78°!" — would be the app implying something it
 * spends the rest of its surface refusing to imply.
 */
export function sharePassText(input: PassShareInput): string {
  const { pass, name, observer } = input;
  const elevation = Math.round(pass.maximum.elevation);
  const minutes = Math.max(1, Math.round(pass.durationSeconds / 60));

  const where =
    observer?.label === undefined || observer.label.trim() === ""
      ? "my observing location"
      : observer.label.trim();

  return [
    `${name} passes over ${where}`,
    `${dateTimeFormat.format(pass.aos.time)} — rises ${pass.aos.compass}, ` +
      `peaks ${String(elevation)}° ${pass.maximum.compass}, sets ${pass.los.compass} ` +
      `(${String(minutes)} min)`,
    VISIBILITY_PHRASE[pass.visibility],
    "",
    // The caveat is part of the message, not a footer to be trimmed. Predicted from
    // published elements is a different claim from observed, and the difference is the
    // whole point of this product.
    "Predicted from published orbital elements — not a live observation, and weather is not included.",
    shareableUrl({ screen: "satellite", catalogId: input.catalogId }),
  ].join("\n");
}

/** Share an object without a specific pass. */
export function shareSatelliteText(catalogId: string, name: string): string {
  return [
    `${name} (catalog #${catalogId}) on OrbitWatch`,
    "Positions calculated from published orbital elements using SGP4/SDP4.",
    shareableUrl({ screen: "satellite", catalogId }),
  ].join("\n");
}
