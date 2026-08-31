import type { ProviderStatusResponse } from "@orbitwatch/contracts";
import { PROVIDER_VERIFICATION, type ProviderId } from "@orbitwatch/providers";
import type { FastifyInstance } from "fastify";

import { toProviderStatus } from "../mappers.js";
import type { ApiContext } from "../server.js";

/**
 * Provider status.
 *
 * Backs the UI's data-source panel and answers the question a user is entitled to ask:
 * how current is what I am looking at, and where did it come from?
 *
 * The response reports two things that are easy to conflate and are kept apart here:
 *
 *   * **freshness** — how recently ingestion last succeeded. Operational.
 *   * **verified**  — whether this provider's schema has ever been validated against a
 *                     real production response. Epistemic.
 *
 * A provider can be perfectly fresh and still unverified, and saying so is the point.
 * The verification answer comes from the registry in `@orbitwatch/providers`, so it
 * cannot drift away from a source comment.
 */

/** Providers whose ingestion runs this endpoint reports on. */
const REPORTED_PROVIDERS: readonly { id: ProviderId; resource: string }[] = [
  { id: "celestrak-gp", resource: "group-active" },
  { id: "celestrak-satcat", resource: "satcat" },
];

export async function registerProviderRoutes(
  app: FastifyInstance,
  context: ApiContext,
): Promise<void> {
  app.get("/providers/status", async (): Promise<ProviderStatusResponse> => {
    const now = context.now();
    const latestRuns = await context.database.providerRuns.latestRuns();

    const providers = await Promise.all(
      REPORTED_PROVIDERS.map(async ({ id, resource }) => {
        const lastRun = latestRuns.find(
          (run) => run.provider === id && run.resource === resource,
        );
        const lastSuccess = await context.database.providerRuns.latestSuccessfulRun(
          id,
          resource,
        );

        return toProviderStatus({
          provider: id,
          resource,
          verified: PROVIDER_VERIFICATION[id].status === "VERIFIED",
          lastRun,
          lastSuccess,
          now,
        });
      }),
    );

    return { time: now.toISOString(), providers };
  });

  /**
   * The verification registry itself.
   *
   * Separate from status because it answers a different question and changes on a
   * different cadence — status changes every ingestion run, verification changes only
   * when a provider is genuinely verified against live data.
   */
  app.get("/providers/verification", async () => ({
    time: context.now().toISOString(),
    providers: Object.entries(PROVIDER_VERIFICATION).map(([id, verification]) => ({
      provider: id,
      ...verification,
    })),
  }));
}
