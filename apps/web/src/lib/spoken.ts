/**
 * Text for listening to, where the text for reading is too compressed.
 *
 * An instrument panel is deliberately terse: "97.8° WNW" is exactly right on screen,
 * where the columns and the degree sign carry meaning at a glance. Read aloud it
 * becomes "ninety seven point eight degree W N W", which is a puzzle rather than a
 * reading. These produce the long form for `aria-label`, leaving the compact form
 * visible.
 *
 * This is not duplication for its own sake. The two audiences genuinely want different
 * text, and the alternative — spelling everything out on screen — would make the panel
 * worse for everyone rather than better for anyone.
 */

const COMPASS_WORDS: Record<string, string> = {
  N: "north",
  NNE: "north-north-east",
  NE: "north-east",
  ENE: "east-north-east",
  E: "east",
  ESE: "east-south-east",
  SE: "south-east",
  SSE: "south-south-east",
  S: "south",
  SSW: "south-south-west",
  SW: "south-west",
  WSW: "west-south-west",
  W: "west",
  WNW: "west-north-west",
  NW: "north-west",
  NNW: "north-north-west",
};

export function spokenCompass(compass: string): string {
  return COMPASS_WORDS[compass] ?? compass;
}

/** "97.8 degrees, west-north-west". */
export function spokenBearing(degrees: number, compass: string): string {
  return `${degrees.toFixed(1)} degrees, ${spokenCompass(compass)}`;
}

/**
 * Elevation, with the sign said rather than shown.
 *
 * "-1.5°" is read by some screen readers as "1.5 degrees", silently dropping the minus
 * — which inverts the meaning: below the horizon becomes above it.
 */
export function spokenElevation(degrees: number): string {
  const magnitude = Math.abs(degrees).toFixed(1);
  return degrees < 0
    ? `${magnitude} degrees below the horizon`
    : `${magnitude} degrees above the horizon`;
}

/** "receding at 5.42 kilometres per second". */
export function spokenRangeRate(kilometresPerSecond: number): string {
  const magnitude = Math.abs(kilometresPerSecond).toFixed(2);
  return kilometresPerSecond >= 0
    ? `receding at ${magnitude} kilometres per second`
    : `approaching at ${magnitude} kilometres per second`;
}
