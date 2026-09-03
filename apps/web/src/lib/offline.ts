import { formatDuration } from "@orbitwatch/orbit-core";

/**
 * What to say when the elements on screen did not just come from the network.
 *
 * SEPARATED FROM THE COMPONENT SO THE WORDING CAN BE TESTED
 * The wording is the feature. A banner that says the wrong thing is worse than none at
 * all, because it converts "I could not reach the network" into "this is what is
 * happening in orbit right now".
 *
 * TWO SIGNALS, NOT ONE
 * `online` is what the browser claims. `fromCache` is what the service worker
 * observed. They disagree in the case that matters most: a captive portal or a dead
 * API leaves `navigator.onLine` true while every response comes from the cache, and a
 * banner keyed only on `online` would stay hidden exactly when the data is oldest.
 *
 * WHAT THIS DELIBERATELY DOES NOT SAY
 * It does not say the positions are wrong, and it does not say they are right. Both
 * would be claims this function is in no position to make: how far a propagated
 * position can be trusted depends on the age of one satellite's elements and the class
 * of its orbit, which is assessed per object and shown in the badge beside it.
 */

export interface CacheNotice {
  /** Short enough for a status bar. */
  readonly headline: string;
  /** The sentence that stops "offline" being read as "paused". */
  readonly detail: string;
  /** False when there is nothing cached to work from at all. */
  readonly usable: boolean;
}

export interface CacheState {
  /** What the browser claims about the network. */
  readonly online: boolean;
  /** Whether the service worker served the catalog from its cache. */
  readonly fromCache: boolean;
  /** When the catalog in use was retrieved, or undefined if there is none yet. */
  readonly retrievedAt: string | undefined;
}

/** The notice to show, or undefined when there is nothing worth saying. */
export function cacheNotice(state: CacheState, now: Date): CacheNotice | undefined {
  // Live data over a working network needs no explanation.
  if (state.online && !state.fromCache) return undefined;

  if (state.retrievedAt === undefined) {
    return {
      headline: "Offline — no cached catalog",
      /*
       * The case a precaching service worker would have hidden. This app caches what
       * the browser actually loaded rather than downloading 14 MB of Cesium on every
       * first visit, so a first visit with no network genuinely has nothing. Saying so
       * is the only honest option: an empty globe would read as "no satellites".
       */
      detail: "Nothing has been downloaded on this device yet. Reconnect to load the catalog.",
      usable: false,
    };
  }

  const ageHours = (now.getTime() - new Date(state.retrievedAt).getTime()) / 3_600_000;

  /*
   * A future timestamp means the device clock disagrees with the server's, not that
   * the catalog is from the future. Reporting "from -2h ago" would be nonsense, so the
   * age is dropped and the fact is stated without it.
   */
  const age = ageHours < 0 ? undefined : formatDuration(ageHours);

  /*
   * Two phrasings rather than one with a swapped word. "Offline" is the reason the
   * data is old and leads; when the browser thinks it is online, the age IS the news
   * and there is no reason to lead with a state the user has no evidence of.
   */
  const headline = state.online
    ? age === undefined
      ? "Using cached elements"
      : `Using cached elements — ${age} old`
    : age === undefined
      ? "Offline — cached catalog"
      : `Offline — elements from ${age} ago`;

  return {
    headline,
    /*
     * The distinction the whole milestone turns on.
     *
     * The satellites keep moving on screen while offline, because their positions are
     * computed here from the elements rather than streamed from anywhere. Without this
     * sentence, motion on a screen that says "offline" reads as a live feed that
     * somehow survived, which is the one impression this product must never leave.
     */
    detail:
      "Positions are still being computed from these elements, not received. " +
      "Each satellite's badge says how far its own elements can be trusted.",
    usable: true,
  };
}
