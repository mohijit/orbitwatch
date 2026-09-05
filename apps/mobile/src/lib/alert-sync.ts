import {
  parseOmm,
  predictPasses,
  type OMMJsonObject,
  type ObserverLocation,
} from "@orbitwatch/orbit-core";

import { fetchElements } from "./api";
import { syncAlerts, type SyncResult } from "./notifications";
import { type AlertCandidate, type AlertPreferences } from "./pass-alerts";
import { loadObserver, loadWatchlist } from "./storage";

/**
 * Gather what could be alerted about, then hand it to the rules.
 *
 * The piece that was missing: `planAlerts` decided what to schedule and `syncAlerts`
 * could schedule it, but nothing ever assembled the candidates, so the whole feature was
 * inert. This composes the three sources — where you are, what you follow, and when
 * those things next come over — and nothing else. It makes no decisions; every rule
 * about what is worth an interruption stays in `pass-alerts`.
 *
 * SCOPED TO THE WATCHLIST, DELIBERATELY
 * The alternative is the whole catalog, which at sixteen thousand objects is both an
 * enormous amount of propagation and a guarantee of notification fatigue: there is
 * always something bright overhead. Following an object is the user saying they care
 * about it, and that is the only signal here worth acting on.
 */

/** How far ahead to look. Long enough to cover a night, short enough to stay accurate. */
const WINDOW_HOURS = 24;

export type SyncOutcome =
  | { readonly status: "no-observer" }
  | { readonly status: "empty-watchlist" }
  | ({ readonly status: "synced" } & SyncResult)
  | { readonly status: "failed"; readonly message: string };

/**
 * Build the candidate list and reconcile the scheduled notifications with it.
 *
 * Every element set is fetched fresh rather than reused from a previous run. A pass
 * predicted from elements a day old can move by minutes, and a notification is a
 * promise about a time — so the prediction is made from the newest elements available,
 * and `syncAlerts` withdraws anything the new prediction no longer supports.
 */
export async function syncPassAlerts(
  preferences: AlertPreferences,
  now: Date = new Date(),
): Promise<SyncOutcome> {
  const observer: ObserverLocation | undefined = await loadObserver();
  if (observer === undefined) return { status: "no-observer" };

  const watchlist = await loadWatchlist();
  if (watchlist.length === 0) return { status: "empty-watchlist" };

  const until = new Date(now.getTime() + WINDOW_HOURS * 3_600_000);
  const candidates: AlertCandidate[] = [];

  for (const catalogId of watchlist) {
    try {
      const response = await fetchElements(catalogId);
      const omm = response.elements.omm as unknown as OMMJsonObject;
      const { satrec } = parseOmm(omm);

      const rawName = (omm as { OBJECT_NAME?: unknown }).OBJECT_NAME;
      const name =
        typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim() : catalogId;

      for (const pass of predictPasses(satrec, observer, now, until)) {
        candidates.push({ catalogId, name, pass });
      }
    } catch {
      /*
       * One object failing must not cost the others their alerts.
       *
       * A satellite can be removed from the catalog, or decay, and its endpoint starts
       * returning 404 while the watchlist still names it. Abandoning the whole sync
       * there would silently stop notifications for everything else the user follows.
       */
      continue;
    }
  }

  try {
    const result = await syncAlerts(candidates, preferences, now);
    return { status: "synced", ...result };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
