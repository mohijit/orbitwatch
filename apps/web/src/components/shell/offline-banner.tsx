"use client";

import { cacheNotice, type CacheState } from "@/lib/offline";

/**
 * The bar that appears when the network goes away.
 *
 * WHY IT IS NOT A TOAST
 * A toast is dismissed and forgotten, and the condition it described outlives it. This
 * is a persistent bar for exactly as long as the app is offline, because the thing it
 * says stays true for exactly that long.
 *
 * `role="status"` rather than `role="alert"`: losing a network is not an emergency and
 * should not interrupt whatever a screen reader is in the middle of saying. It is
 * announced politely, once, when it appears.
 */
export function OfflineBanner(state: CacheState) {
  const notice = cacheNotice(state, new Date());
  if (notice === undefined) return null;

  return (
    <div
      className={`offline-banner${notice.usable ? "" : " offline-banner--empty"}`}
      role="status"
      data-testid="offline-banner"
    >
      <span className="offline-banner__headline" data-testid="offline-headline">
        {notice.headline}
      </span>
      <span className="offline-banner__detail">{notice.detail}</span>
    </div>
  );
}
