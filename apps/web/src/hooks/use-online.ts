"use client";

import { useEffect, useState } from "react";

/**
 * Whether the browser believes it has a network.
 *
 * WHAT navigator.onLine ACTUALLY MEANS
 * That a network interface exists and is up — not that anything is reachable across
 * it. A captive portal, a dead API, or DNS that resolves to nothing all report online.
 * So this is a reliable signal in one direction only: false definitely means offline,
 * true means "no reason to think otherwise".
 *
 * That asymmetry suits the use here. The banner exists to explain data that is already
 * cached, and the case it must never miss is the one this detects exactly. A network
 * that is up but useless produces a failed catalog fetch, which the badge already
 * reports as CATALOG UNAVAILABLE rather than as a working app.
 *
 * Starts true and is corrected in an effect, because the server has no navigator and
 * rendering a banner during hydration that the client immediately removes is a flash
 * of a warning that was never true.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);

    const goOnline = (): void => {
      setOnline(true);
    };
    const goOffline = (): void => {
      setOnline(false);
    };

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
