import { describe, expect, it } from "vitest";

import { parseDeepLink, routeFor, shareableUrl } from "./deep-links";

/**
 * Deep links are untrusted input, and these tests treat them that way.
 *
 * Roughly half of what follows is about links that must NOT resolve. A parser that
 * accepts everything it is given is not a parser; it is a way of handing arbitrary
 * strings to a router.
 */

describe("parseDeepLink", () => {
  it("opens an object from the custom scheme", () => {
    expect(parseDeepLink("orbitwatch://satellite/25544")).toEqual({
      screen: "satellite",
      catalogId: "25544",
    });
  });

  it("opens an object from an https link", () => {
    // The same link has to work whether or not the app is installed, so both forms
    // must reach the same screen.
    expect(parseDeepLink("https://orbitwatch.app/satellite/25544")).toEqual({
      screen: "satellite",
      catalogId: "25544",
    });
    expect(parseDeepLink("https://www.orbitwatch.app/satellite/25544")).toEqual({
      screen: "satellite",
      catalogId: "25544",
    });
  });

  it("normalises leading zeros so one object is one screen", () => {
    expect(parseDeepLink("orbitwatch://satellite/025544")).toEqual({
      screen: "satellite",
      catalogId: "25544",
    });
  });

  it("accepts six-digit catalog numbers, which are now in use", () => {
    expect(parseDeepLink("orbitwatch://satellite/100001")).toEqual({
      screen: "satellite",
      catalogId: "100001",
    });
  });

  it("rejects a catalog id that is not a plain number", () => {
    // The traversal attempt is the point: a router handed "../.." does something.
    for (const bad of [
      "orbitwatch://satellite/../../etc",
      "orbitwatch://satellite/25544abc",
      "orbitwatch://satellite/%2e%2e%2f",
      "orbitwatch://satellite/-1",
      "orbitwatch://satellite/1e5",
      "orbitwatch://satellite/9999999",
      "orbitwatch://satellite/0",
      "orbitwatch://satellite/",
    ]) {
      expect(parseDeepLink(bad), bad).toBeUndefined();
    }
  });

  it("refuses a host that is not ours", () => {
    // A link that merely looks like ours must not drive navigation inside the app.
    expect(parseDeepLink("https://orbitwatch.app.evil.com/satellite/25544")).toBeUndefined();
    expect(parseDeepLink("https://example.com/satellite/25544")).toBeUndefined();
  });

  it("refuses a scheme that is not ours", () => {
    expect(parseDeepLink("javascript:alert(1)")).toBeUndefined();
    expect(parseDeepLink("file:///etc/passwd")).toBeUndefined();
    expect(parseDeepLink("otherapp://satellite/25544")).toBeUndefined();
  });

  it("returns nothing for a string that is not a URL", () => {
    // An unrecognised link is routine — an old link, a truncated one — so the answer is
    // "not ours", never a thrown error.
    expect(parseDeepLink("")).toBeUndefined();
    expect(parseDeepLink("not a url")).toBeUndefined();
    expect(parseDeepLink("25544")).toBeUndefined();
  });

  it("carries a search query through", () => {
    expect(parseDeepLink("orbitwatch://search?q=hubble")).toEqual({
      screen: "search",
      query: "hubble",
    });
    expect(parseDeepLink("orbitwatch://search")).toEqual({ screen: "search" });
    expect(parseDeepLink("orbitwatch://search?q=%20%20")).toEqual({ screen: "search" });
  });

  it("routes the remaining screens", () => {
    expect(parseDeepLink("orbitwatch://watchlist")).toEqual({ screen: "watchlist" });
    expect(parseDeepLink("orbitwatch://observer")).toEqual({ screen: "observer" });
    expect(parseDeepLink("orbitwatch://agreement")).toEqual({ screen: "agreement" });
    expect(parseDeepLink("orbitwatch://")).toEqual({ screen: "globe" });
    expect(parseDeepLink("https://orbitwatch.app/")).toEqual({ screen: "globe" });
  });

  it("ignores an unknown screen rather than guessing", () => {
    expect(parseDeepLink("orbitwatch://settings")).toBeUndefined();
    expect(parseDeepLink("https://orbitwatch.app/blog/post-1")).toBeUndefined();
  });

  it("is case-insensitive about the screen and host", () => {
    expect(parseDeepLink("orbitwatch://Satellite/25544")).toEqual({
      screen: "satellite",
      catalogId: "25544",
    });
    expect(parseDeepLink("https://OrbitWatch.app/watchlist")).toEqual({ screen: "watchlist" });
  });
});

describe("routeFor", () => {
  it("round-trips every target through the parser", () => {
    // The generator and the parser must not drift apart: a link the app writes has to
    // be a link the app can read.
    const targets = [
      { screen: "globe" },
      { screen: "search", query: "iss" },
      { screen: "satellite", catalogId: "25544" },
      { screen: "watchlist" },
      { screen: "observer" },
      { screen: "agreement" },
    ] as const;

    for (const target of targets) {
      expect(parseDeepLink(shareableUrl(target)), routeFor(target)).toEqual(target);
    }
  });

  it("escapes a query that would otherwise break the URL", () => {
    const url = shareableUrl({ screen: "search", query: "a&b=c d" });
    expect(url).not.toContain("a&b=c d");
    expect(parseDeepLink(url)).toEqual({ screen: "search", query: "a&b=c d" });
  });
});
