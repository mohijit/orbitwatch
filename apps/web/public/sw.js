/*
 * OrbitWatch service worker.
 *
 * Hand-written, and deliberately not generated. The interesting decisions here are
 * about which data may be served from a cache at all, and that is a question about
 * what this product is allowed to claim -- not something to delegate to a plugin's
 * defaults. It is plain JavaScript in public/ because Turbopack has no service worker
 * pipeline and this file needs no build step to be correct.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THAT DECIDES EVERYTHING BELOW
 *
 *   Cache data that carries its own timestamp. Never cache data that does not.
 *
 * Orbital elements carry an epoch, and the app already degrades a position from
 * NOMINAL to UNRELIABLE as it ages away from that epoch, refusing to draw one that has
 * gone too far. A cached element set therefore cannot masquerade as fresh: it says how
 * old it is, in the badge next to every satellite, whether or not there is a network.
 *
 * Space weather, solar activity and launch times carry no such self-description. A Kp
 * index served from a cache is indistinguishable from one measured a minute ago, and
 * the app would report a quiet magnetosphere during a storm -- the exact failure
 * space-weather.spec.ts exists to prevent. Those endpoints are never cached. Offline
 * they fail, and their panels already say "unavailable" rather than implying calm.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Bump this to evict everything.
 *
 * Cesium is served from stable URLs rather than content-hashed ones, so a Cesium
 * upgrade is invisible to the cache key. Stale-while-revalidate means an upgrade lands
 * on the next load without a bump; the version exists for changes that must not wait,
 * and for discarding a cache whose shape has changed.
 */
const VERSION = "ow-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;

/**
 * Catalog data: self-dating, therefore cacheable.
 *
 * `/catalog/elements` is the globe itself. `/satellites/.../elements` is one object's
 * element sets, and `/satellites` is the search index. All three are OMM records or
 * identifiers, all three carry epochs or an explicit response time, and all three are
 * republished on a provider cadence measured in hours rather than seconds.
 */
const CACHEABLE_DATA = [/\/catalog\/elements$/, /\/satellites(\?|$)/, /\/satellites\/[^/]+\/elements/];

/**
 * Immutable enough to serve from cache first.
 *
 * `/_next/static/` is content-addressed: the URL changes when the bytes do, so a hit
 * is never stale. `/cesium/` and `/icons/` are not, which is why they are revalidated
 * in the background rather than trusted forever.
 */
const CONTENT_ADDRESSED = /\/_next\/static\//;
const REVALIDATED_ASSETS = /\/(cesium|icons)\//;

self.addEventListener("install", (event) => {
  /*
   * Nothing is precached, on purpose.
   *
   * Cesium alone is 14 MB across 390 files, and precaching it would spend that on
   * every first visit for an offline capability most visitors never use. What the
   * cache holds is what this browser actually loaded, which means the offline
   * experience is a copy of the session the user already had.
   *
   * The honest consequence, stated here so it is not discovered later: a first visit
   * with no network has nothing, and the app says so rather than showing a globe with
   * no satellites on it.
   */
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !name.startsWith(VERSION)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/** Cache a response only if it is one we could serve back without lying. */
function isStorable(response) {
  // `ok` excludes opaque responses too: their status is 0, and an opaque response
  // cached here would be replayed as an unreadable success.
  return response !== undefined && response.ok && response.status === 200;
}

/**
 * Copy a response into a cache, without breaking the one being returned.
 *
 * TWO ORDERING RULES, BOTH OF WHICH FAIL SILENTLY IF BROKEN
 *
 * 1. Clone BEFORE the first await. A response body can be read once. By the time
 *    `caches.open` resolves, the response has already been handed to the browser and
 *    the body is locked, so `clone()` throws — inside a floating promise nobody is
 *    watching. Every page then loads perfectly from the network and nothing whatsoever
 *    is cached, which looks exactly like a service worker that is not running.
 *
 * 2. The caller must hold the worker alive with `event.waitUntil`. A service worker is
 *    killed once it has responded, so a write still in flight is simply lost.
 */
function copyIntoCache(cacheName, request, response) {
  if (!isStorable(response)) return Promise.resolve();

  // Synchronous, and deliberately the first statement after the guard.
  const copy = response.clone();

  return caches.open(cacheName).then((cache) =>
    // Keyed by URL rather than by the Request, because the propagation worker asks for
    // the catalog with `cache: "no-store"` and the key should not depend on that.
    cache.put(request.url, copy),
  );
}

/** Serve from cache, and refresh it in the background for next time. */
async function staleWhileRevalidate(event, request) {
  const cached = await caches.match(request.url);
  const network = fetch(request)
    .then((response) => {
      event.waitUntil(copyIntoCache(SHELL_CACHE, request, response));
      return response;
    })
    .catch(() => undefined);

  if (cached !== undefined) {
    // The refresh must still be allowed to finish even though the cached copy is what
    // gets returned, or the cache would never revalidate at all.
    event.waitUntil(network);
    return cached;
  }
  const response = await network;
  if (response !== undefined) return response;
  return Response.error();
}

async function cacheFirst(event, request) {
  const cached = await caches.match(request.url);
  if (cached !== undefined) return cached;

  try {
    const response = await fetch(request);
    event.waitUntil(copyIntoCache(SHELL_CACHE, request, response));
    return response;
  } catch {
    /*
     * A network error, not a synthetic 504.
     *
     * An uncached asset offline has failed to load, and that is precisely a network
     * error. Handing back an empty 504 instead tells the caller the request SUCCEEDED
     * with an empty body -- Cesium treats that as a corrupt texture and stops
     * rendering entirely, rather than falling back the way it does when a tile is
     * simply unreachable.
     */
    return Response.error();
  }
}

/**
 * Stamp a response so the page knows it did not come from the network.
 *
 * WHY THE PAGE CANNOT WORK THIS OUT FOR ITSELF
 * `navigator.onLine` is true whenever a network interface is up, which includes a
 * captive portal, a dead API and DNS that resolves to nothing. Keying the offline
 * banner on it would hide the banner in exactly the cases where the data on screen is
 * oldest. The service worker is the only party that knows where the bytes came from,
 * so it says so and the page believes it.
 *
 * A response constructed here is returned to the page as the worker's own, so this
 * header is readable even though the underlying request was cross-origin and no
 * Access-Control-Expose-Headers would have allowed it.
 */
function markCached(response) {
  const headers = new Headers(response.headers);
  headers.set("x-orbitwatch-cached", "1");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Network wins when there is one; the cache is the fallback.
 *
 * Note what is NOT here: no timeout that gives up on a slow network and serves the
 * cache instead. On a bad connection that would silently swap fresh elements for old
 * ones while the app still reported itself online, which is the one state this design
 * has no way to describe honestly.
 */
async function networkFirst(event, request, cacheName) {
  try {
    const response = await fetch(request);
    event.waitUntil(copyIntoCache(cacheName, request, response));
    return response;
  } catch (error) {
    const cached = await caches.match(request.url);
    if (cached !== undefined) return markCached(cached);
    throw error;
  }
}

async function handleNavigation(event, request) {
  try {
    const response = await fetch(request);
    event.waitUntil(copyIntoCache(SHELL_CACHE, request, response));
    return response;
  } catch {
    const cached = (await caches.match(request.url)) ?? (await caches.match("/"));
    if (cached !== undefined) return cached;
    throw new Error("offline and no cached shell");
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only GET is ever cacheable, and a range request must reach the network so the
  // browser gets its 206 rather than a whole body it did not ask for.
  if (request.method !== "GET" || request.headers.has("range")) return;

  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(event, request));
    return;
  }

  if (CONTENT_ADDRESSED.test(url.pathname)) {
    event.respondWith(cacheFirst(event, request));
    return;
  }

  if (REVALIDATED_ASSETS.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, request));
    return;
  }

  if (CACHEABLE_DATA.some((pattern) => pattern.test(url.pathname + url.search))) {
    event.respondWith(networkFirst(event, request, DATA_CACHE));
    return;
  }

  /*
   * Everything else goes to the network untouched, and that includes every provider
   * whose value is its currency: space weather, solar events, launches, ground
   * stations, transmitters. Falling through rather than failing here matters -- NASA's
   * imagery tiles are cross-origin and must be free to fail on their own terms.
   */
});
