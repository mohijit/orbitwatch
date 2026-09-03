import {
  watchlistSyncBodySchema,
  type WatchlistSyncCreated,
  type WatchlistSyncResponse,
} from "@orbitwatch/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  formatSyncCode,
  generateSyncCode,
  hashSyncCode,
  normaliseSyncCode,
} from "../sync-code.js";
import type { ApiContext } from "../server.js";

/**
 * Moving a watchlist between devices, without an account.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS ENDPOINT IS ALLOWED TO HOLD
 *
 * A list of catalog numbers. Not an email address, not a device identifier, and above
 * all not an observing location — that is a home address to within a few metres, the
 * app promises on screen that it never leaves the device, and adding convenience is
 * not a reason to break that.
 *
 * THE CODE TRAVELS IN A HEADER, NEVER IN THE PATH
 * It is a bearer secret. A secret in a URL is written to every access log, proxy log
 * and error report along the way, and Fastify's own request logging records the URL of
 * every request it serves — so a path parameter here would put working credentials into
 * the log store on purpose. In a header it is recorded by none of them.
 *
 * THE SERVER NEVER STORES THE CODE
 * Only its SHA-256. Requests arrive with the code, are hashed here, and every lookup is
 * by hash, so this service can be dumped whole without yielding a usable code.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const CODE_HEADER = "x-sync-code";

/** Ninety days without a sync and a pairing is abandoned. */
const EXPIRY_DAYS = 90;

/**
 * Read and validate the code from the request.
 *
 * Returns the hash, or undefined. The caller answers identically for "no header",
 * "malformed code" and "no such pairing" — telling them apart would confirm to someone
 * guessing that a code was well-formed but unclaimed, which is a free bit of feedback
 * they should not have.
 */
function codeHashFrom(request: FastifyRequest): string | undefined {
  const raw = request.headers[CODE_HEADER];
  if (typeof raw !== "string") return undefined;

  const code = normaliseSyncCode(raw);
  return code === undefined ? undefined : hashSyncCode(code);
}

export function registerSyncRoutes(app: FastifyInstance, context: ApiContext): void {
  /**
   * Start a pairing.
   *
   * The only response that ever contains a code. The server mints it so its entropy is
   * a property of this service rather than of whichever client asked.
   */
  app.post("/sync/watchlist", async (request, reply): Promise<WatchlistSyncCreated | undefined> => {
    const parsed = watchlistSyncBodySchema.safeParse(request.body);
    if (!parsed.success) {
      await reply.status(400).send({
        error: { code: "INVALID_BODY", message: "catalogIds must be a list of catalog numbers." },
      });
      return undefined;
    }

    const code = generateSyncCode();
    const { updatedAt } = await context.database.watchlistSync.put(
      hashSyncCode(code),
      parsed.data.catalogIds,
    );

    /*
     * Sweeping here rather than on a schedule.
     *
     * There is no cron in this service, and a pairing store that only ever grows is a
     * liability that accumulates quietly. Creation is rare and already a write, so it
     * is the natural place to pay for the tidying.
     */
    void context.database.watchlistSync
      .purgeOlderThan(new Date(context.now().getTime() - EXPIRY_DAYS * 86_400_000))
      .catch(() => undefined);

    return { code: formatSyncCode(code), updatedAt: updatedAt.toISOString() };
  });

  /** Collect a list on the other device. */
  app.get("/sync/watchlist", async (request, reply): Promise<WatchlistSyncResponse | undefined> => {
    const codeHash = codeHashFrom(request);
    if (codeHash === undefined) {
      await reply.status(404).send({
        error: { code: "NOT_FOUND", message: "No watchlist for that code." },
      });
      return undefined;
    }

    const record = await context.database.watchlistSync.get(codeHash);
    if (record === undefined) {
      // The same answer a malformed code gets, deliberately.
      await reply.status(404).send({
        error: { code: "NOT_FOUND", message: "No watchlist for that code." },
      });
      return undefined;
    }

    return {
      catalogIds: [...record.catalogIds],
      updatedAt: record.updatedAt.toISOString(),
    };
  });

  /**
   * Replace the list.
   *
   * A replacement, not a merge. Removing a satellite has to survive a sync, and merging
   * would resurrect every entry the user had deleted the moment the other device
   * uploaded its copy.
   */
  app.put("/sync/watchlist", async (request, reply): Promise<{ updatedAt: string } | undefined> => {
    const codeHash = codeHashFrom(request);
    if (codeHash === undefined) {
      await reply.status(404).send({
        error: { code: "NOT_FOUND", message: "No watchlist for that code." },
      });
      return undefined;
    }

    const parsed = watchlistSyncBodySchema.safeParse(request.body);
    if (!parsed.success) {
      await reply.status(400).send({
        error: { code: "INVALID_BODY", message: "catalogIds must be a list of catalog numbers." },
      });
      return undefined;
    }

    /*
     * An unknown code cannot create a pairing here.
     *
     * If PUT created what it could not find, anyone could claim a code of their
     * choosing — and the entropy argument that protects this whole feature rests on
     * codes being generated by the server, not chosen by a caller.
     */
    const existing = await context.database.watchlistSync.get(codeHash);
    if (existing === undefined) {
      await reply.status(404).send({
        error: { code: "NOT_FOUND", message: "No watchlist for that code." },
      });
      return undefined;
    }

    const { updatedAt } = await context.database.watchlistSync.put(
      codeHash,
      parsed.data.catalogIds,
    );
    return { updatedAt: updatedAt.toISOString() };
  });

  /** Unpair, and delete what was stored. */
  app.delete("/sync/watchlist", async (request, reply): Promise<undefined> => {
    const codeHash = codeHashFrom(request);
    if (codeHash !== undefined) await context.database.watchlistSync.remove(codeHash);

    // 204 whether or not anything was there. Someone deleting a pairing wants it gone,
    // and a 404 here would only tell a guesser which codes exist.
    await reply.status(204).send();
    return undefined;
  });
}
