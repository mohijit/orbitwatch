"use client";

import { useEffect } from "react";

/**
 * Registers the service worker.
 *
 * PRODUCTION ONLY, DELIBERATELY
 * A service worker in front of a Turbopack dev server caches modules that hot reload
 * is simultaneously replacing, and the result is a page that will not update and gives
 * no clue why. The E2E suite runs against the production build, so this path is
 * exercised by tests rather than only in deployment.
 *
 * Nothing here waits for or reports registration: the app is fully functional without
 * a service worker, and a browser that refuses one — private mode, an insecure origin,
 * a policy — should get the app, not an error about a capability it did not ask for.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      // Visible to anyone looking, silent to everyone else.
      console.warn("Service worker registration failed", error);
    });
  }, []);

  return null;
}
