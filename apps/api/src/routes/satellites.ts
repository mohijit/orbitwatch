import {
  satelliteQuerySchema,
  type CatalogElementsResponse,
  type CatalogGroupResponse,
  type ElementHistoryResponse,
  type ElementsResponse,
  type SatelliteListResponse,
} from "@orbitwatch/contracts";
import type { ObjectType, OrbitClass } from "@orbitwatch/orbit-core";
import { assessAccuracy } from "@orbitwatch/orbit-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { toOrbitalElements, toSatellite } from "../mappers.js";
import type { ApiContext } from "../server.js";

/**
 * Catalog and element endpoints.
 *
 * These serve ELEMENTS, not positions. The client propagates locally with the same
 * `orbit-core` the server uses, which is what makes smooth animation possible without
 * the server computing 20,000 positions at frame rate, and what makes web and native
 * agree numerically.
 *
 * Every element response carries an accuracy assessment. Propagation far from the
 * element epoch is not equivalent to orbital truth, and the client must be told which
 * it is holding rather than left to assume.
 */

/** Catalog ids are Alpha-5: five characters, a leading letter permitted. */
/**
 * Group names are provider-published slugs, not free text. Bounded and pattern-checked
 * so a path parameter cannot become an arbitrary database predicate.
 */
const catalogGroupParamSchema = z.object({
  group: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Group names are lowercase, digits and hyphens"),
});

const catalogIdParamSchema = z.object({
  catalogId: z
    .string()
    .trim()
    .min(1)
    .max(11)
    .regex(/^[A-Za-z0-9-]+$/, "Catalog id may contain only letters, digits and hyphens"),
});

const timeQuerySchema = z.object({
  /** Assess accuracy for this instant instead of now. Drives historical replay. */
  at: z
    .string()
    .refine(
      (value) => !Number.isNaN(new Date(value).getTime()),
      "Expected an ISO 8601 timestamp",
    )
    .optional(),
});

const historyQuerySchema = z.object({
  since: z
    .string()
    .refine(
      (value) => !Number.isNaN(new Date(value).getTime()),
      "Expected an ISO 8601 timestamp",
    )
    .optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

/** Bounded so one request cannot ask the server to serialise an unbounded catalog. */
const MAX_CATALOG_ELEMENTS = 30_000;

const catalogQuerySchema = z.object({
  objectType: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) =>
      value === undefined
        ? undefined
        : ((Array.isArray(value) ? value : [value]) as ObjectType[]),
    ),
  orbitClass: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) =>
      value === undefined
        ? undefined
        : ((Array.isArray(value) ? value : [value]) as OrbitClass[]),
    ),
  includeDecayed: z.coerce.boolean().optional(),
});

/** Normalise a repeated query parameter, which Fastify gives as string or string[]. */
function toArray<T extends string>(value: unknown): readonly T[] | undefined {
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value : [value]) as T[];
}

export async function registerSatelliteRoutes(
  app: FastifyInstance,
  context: ApiContext,
): Promise<void> {
  /** Search and filter the catalog. */
  app.get("/satellites", async (request): Promise<SatelliteListResponse> => {
    const raw = request.query as Record<string, unknown>;
    const query = satelliteQuerySchema.parse({
      ...raw,
      objectType: toArray(raw["objectType"]),
      orbitClass: toArray(raw["orbitClass"]),
      owner: toArray(raw["owner"]),
    });

    const filter = {
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(query.objectType === undefined ? {} : { objectTypes: query.objectType }),
      ...(query.orbitClass === undefined ? {} : { orbitClasses: query.orbitClass }),
      ...(query.owner === undefined ? {} : { owners: query.owner }),
      excludeDecayed: query.includeDecayed !== true,
    };

    // Count and page are issued against the same filter so the total cannot describe a
    // different set from the rows.
    const [satellites, total] = await Promise.all([
      context.database.satellites.findMany({
        ...filter,
        limit: query.limit,
        offset: query.offset,
      }),
      context.database.satellites.count(filter),
    ]);

    return {
      satellites: satellites.map(toSatellite),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  });

  /** One object's catalog record. */
  app.get("/satellites/:catalogId", async (request, reply) => {
    const { catalogId } = catalogIdParamSchema.parse(request.params);

    const satellite = await context.database.satellites.findByCatalogId(catalogId);
    if (satellite === undefined) {
      return reply.status(404).send({
        error: {
          code: "SATELLITE_NOT_FOUND",
          message: `No satellite with id ${catalogId}`,
        },
      });
    }

    return reply.send({ satellite: toSatellite(satellite) });
  });

  /**
   * The element set to use for a given instant, with its accuracy assessment.
   *
   * With `?at=`, this returns the set that was CURRENT at that time rather than the
   * newest one — the difference between replaying history and propagating today's
   * elements backwards across an unmodelled manoeuvre, which produces an orbit the
   * spacecraft was never in.
   */
  app.get("/satellites/:catalogId/elements", async (request, reply) => {
    const { catalogId } = catalogIdParamSchema.parse(request.params);
    const { at } = timeQuerySchema.parse(request.query);

    const targetTime = at === undefined ? context.now() : new Date(at);

    const satellite = await context.database.satellites.findByCatalogId(catalogId);
    if (satellite === undefined) {
      return reply.status(404).send({
        error: {
          code: "SATELLITE_NOT_FOUND",
          message: `No satellite with id ${catalogId}`,
        },
      });
    }

    const elements =
      at === undefined
        ? await context.database.elements.findLatest(catalogId)
        : await context.database.elements.findForTime({
            catalogId,
            atOrBefore: targetTime,
          });

    if (elements === undefined) {
      // Distinguished from SATELLITE_NOT_FOUND: the object exists, we simply have no
      // elements for the requested moment. A client replaying history needs to tell
      // "no such object" apart from "no data that far back".
      return reply.status(404).send({
        error: {
          code: "ELEMENTS_NOT_FOUND",
          message:
            at === undefined
              ? `No orbital elements stored for ${catalogId}`
              : `No orbital elements for ${catalogId} at or before ${targetTime.toISOString()}`,
        },
      });
    }

    const accuracy = assessAccuracy(elements.epoch, targetTime, satellite.orbitClass);

    const response: ElementsResponse = {
      elements: toOrbitalElements(elements),
      accuracy: {
        confidence: accuracy.confidence,
        hoursFromEpoch: accuracy.hoursFromEpoch,
        backwards: accuracy.backwards,
        label: accuracy.label,
        ...(accuracy.warning === undefined ? {} : { warning: accuracy.warning }),
        renderable: accuracy.renderable,
      },
      assessedFor: targetTime.toISOString(),
    };

    return reply.send(response);
  });

  /** Stored element history, newest first. Backs the raw-data view and replay. */
  app.get("/satellites/:catalogId/elements/history", async (request) => {
    const { catalogId } = catalogIdParamSchema.parse(request.params);
    const { since, limit } = historyQuerySchema.parse(request.query);

    const history = await context.database.elements.findHistory(catalogId, {
      ...(since === undefined ? {} : { since: new Date(since) }),
      limit,
    });

    const response: ElementHistoryResponse = {
      catalogId,
      history: history.map(toOrbitalElements),
    };
    return response;
  });

  /**
   * Current elements for the whole catalog, for globe propagation.
   *
   * One request, then the client propagates every object locally. Serving positions
   * instead would put the server in the animation loop and make smooth motion a
   * function of network latency.
   */
  app.get("/catalog/elements", async (request): Promise<CatalogElementsResponse> => {
    const raw = request.query as Record<string, unknown>;
    const query = catalogQuerySchema.parse({
      ...raw,
      objectType: toArray(raw["objectType"]),
      orbitClass: toArray(raw["orbitClass"]),
    });

    const elements = await context.database.elements.findAllLatest({
      ...(query.objectType === undefined ? {} : { objectTypes: query.objectType }),
      ...(query.orbitClass === undefined ? {} : { orbitClasses: query.orbitClass }),
      excludeDecayed: query.includeDecayed !== true,
    });

    const limited = elements.slice(0, MAX_CATALOG_ELEMENTS);

    return {
      time: context.now().toISOString(),
      count: limited.length,
      elements: limited.map(toOrbitalElements),
    };
  });

  /**
   * Membership of a provider-published group, e.g. CelesTrak's `visual`.
   *
   * Only the catalog IDs. The client already has every element set from
   * /catalog/elements, so returning elements here would ship a second copy of data it
   * holds; what it cannot work out for itself is which objects are members.
   *
   * Restricted to the most recent observation of the group, so an object that has
   * dropped out stops being listed. Membership history stays in the database, but the
   * API answers "who is in this group" with the current answer, not the cumulative one.
   */
  app.get("/catalog/groups/:group", async (request, reply): Promise<CatalogGroupResponse | undefined> => {
    const { group } = catalogGroupParamSchema.parse(request.params);
    const provider = "celestrak-gp";

    const all = await context.database.groups.members(provider, group);

    if (all.length === 0) {
      // Never ingested. Deliberately not an empty list: "no objects are in this group"
      // is a claim about the sky, and "we have not looked" is not the same statement.
      await reply.status(404).send({
        error: {
          code: "GROUP_NOT_INGESTED",
          message: `The ${group} group has not been ingested, so its membership is unknown.`,
        },
      });
      return undefined;
    }

    // Current membership is everything seen in the most recent observation of the
    // group, which is the newest lastSeenAt across its members — one ingestion stamps
    // every member it lists with the same instant.
    //
    // Derived from the membership itself rather than from provider_runs on purpose.
    // Anchoring to a run's start time assumes the run's clock and the membership's
    // clock are the same, which is false whenever a captured response is replayed with
    // its original fetch time: the E2E seed does exactly that, and the group silently
    // came back empty.
    const observedAt = all.reduce(
      (latest, member) => (member.lastSeenAt > latest ? member.lastSeenAt : latest),
      all[0]!.lastSeenAt,
    );
    const current = all.filter(
      (member) => member.lastSeenAt.getTime() === observedAt.getTime(),
    );

    return {
      provider,
      group,
      count: current.length,
      catalogIds: current.map((member) => member.catalogId),
      observedAt: observedAt.toISOString(),
    };
  });
}
