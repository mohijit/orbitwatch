/**
 * Turning an incoming URL into a screen.
 *
 * A deep link is untrusted input from outside the app — a message, a QR code, a web
 * page — and it arrives as a string that something then navigates to. So this parses
 * into a small closed set of typed routes rather than handing a path fragment to the
 * router, and anything it does not recognise resolves to nothing at all.
 *
 * WHY NOT JUST PASS THE PATH THROUGH
 * Because `orbitwatch://satellite/../../something` is a valid string, and a router that
 * is handed unvalidated segments will do something with it. Catalog numbers are digits
 * with a known maximum length; validating that here means no other layer has to wonder.
 */

/** Custom scheme registered by the app, and the eventual web origin. */
export const APP_SCHEME = "orbitwatch";
export const WEB_HOSTS = ["orbitwatch.app", "www.orbitwatch.app"] as const;

export type DeepLinkTarget =
  | { readonly screen: "globe" }
  | { readonly screen: "search"; readonly query?: string }
  | { readonly screen: "satellite"; readonly catalogId: string }
  | { readonly screen: "watchlist" }
  | { readonly screen: "observer" }
  | { readonly screen: "agreement" };

/**
 * NORAD catalog numbers are digits, and the catalog has passed 100,000.
 *
 * Six digits is the documented ceiling for the current numbering scheme; the check is
 * a bound on input length rather than a claim about which objects exist, since an
 * unknown-but-well-formed number is the API's business to reject, not this parser's.
 */
const CATALOG_ID = /^[0-9]{1,6}$/;

/**
 * Validate and canonicalise a catalog number arriving from outside the app.
 *
 * Exported because the parser is not the only entry point: expo-router hands a route
 * parameter straight to the screen, so the screen has to apply the same rule. One
 * definition, used in both places, is what keeps them from disagreeing.
 */
export function parseCatalogId(raw: string): string | undefined {
  if (!CATALOG_ID.test(raw)) return undefined;
  // Leading zeros are stripped so "025544" and "25544" reach the same screen rather
  // than producing two cache entries and two API calls for one object.
  const normalized = String(Number(raw));
  return normalized === "0" ? undefined : normalized;
}

/**
 * Parse a deep link into a target, or `undefined` if it is not one of ours.
 *
 * Returns undefined rather than throwing: an unrecognised link is a routine event —
 * an old link, a truncated one, a link for a different app — and the caller's correct
 * response is to open the app normally, not to show an error.
 */
export function parseDeepLink(url: string): DeepLinkTarget | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  const isWebLink = scheme === "http" || scheme === "https";

  if (isWebLink) {
    // Only our own hosts. Accepting any host would let a link that merely looks like
    // ours drive navigation inside the app.
    const host = parsed.hostname.toLowerCase();
    if (!WEB_HOSTS.includes(host as (typeof WEB_HOSTS)[number])) return undefined;
  } else if (scheme !== APP_SCHEME) {
    return undefined;
  }

  /*
   * The two forms put the screen name in different places.
   *
   * "orbitwatch://satellite/25544" parses with "satellite" as the HOST and "/25544" as
   * the path, because a custom scheme has no real authority component. The https form
   * puts everything in the path and the host is genuinely a host. Treating the two
   * alike sends every web link to the "orbitwatch.app" screen, which does not exist.
   */
  const rawSegments = isWebLink
    ? parsed.pathname.split("/")
    : [parsed.hostname, ...parsed.pathname.split("/")];

  const segments = rawSegments
    .map((segment) => decodeURIComponent(segment).trim())
    .filter((segment) => segment !== "");

  const [head, second] = segments;

  if (head === undefined) return { screen: "globe" };

  switch (head.toLowerCase()) {
    case "globe":
      return { screen: "globe" };

    case "satellite": {
      if (second === undefined) return undefined;
      const catalogId = parseCatalogId(second);
      return catalogId === undefined ? undefined : { screen: "satellite", catalogId };
    }

    case "search": {
      const query = parsed.searchParams.get("q")?.trim();
      return query === undefined || query === ""
        ? { screen: "search" }
        : { screen: "search", query };
    }

    case "watchlist":
      return { screen: "watchlist" };

    case "observer":
      return { screen: "observer" };

    case "agreement":
      return { screen: "agreement" };

    default:
      return undefined;
  }
}

/**
 * The in-app path for a target.
 *
 * The inverse of the parser, so a link the app generates is a link the app can read.
 * Keeping both directions here is what stops a shared URL and the router's expectation
 * drifting apart.
 */
export function routeFor(target: DeepLinkTarget): string {
  switch (target.screen) {
    case "globe":
      return "/";
    case "search":
      return target.query === undefined
        ? "/search"
        : `/search?q=${encodeURIComponent(target.query)}`;
    case "satellite":
      return `/satellite/${target.catalogId}`;
    case "watchlist":
      return "/watchlist";
    case "observer":
      return "/observer";
    case "agreement":
      return "/agreement";
  }
}

/** A shareable https link, which works whether or not the app is installed. */
export function shareableUrl(target: DeepLinkTarget): string {
  return `https://${WEB_HOSTS[0]}${routeFor(target)}`;
}
