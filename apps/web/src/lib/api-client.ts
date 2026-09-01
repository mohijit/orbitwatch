import {
  catalogGroupResponseSchema,
  elementsResponseSchema,
  satelliteListResponseSchema,
  type CatalogGroupResponse,
  type ElementsResponse,
  type SatelliteListResponse,
} from "@orbitwatch/contracts";

/**
 * Typed client for the OrbitWatch API.
 *
 * Every response is parsed with the shared Zod schema from `@orbitwatch/contracts` —
 * the same schema the server's own tests validate against. A field the server renames
 * or drops fails here, at the boundary, rather than as a `undefined.toFixed is not a
 * function` deep inside a Cesium callback.
 */

function baseUrl(): string {
  return process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "http://localhost:3333";
}

/**
 * Absolute URL of the whole-catalog endpoint.
 *
 * Exposed as a URL rather than a fetch because the propagation worker fetches this
 * one itself. At 16,468 objects the response is 10.9 MB, and decoding it, validating
 * it and building satrecs from it is over a second of work that has no business on
 * the main thread while Cesium is starting up. Everything else here is small enough
 * that a normal fetch is the simpler choice.
 */
/**
 * Membership of a provider-published group, e.g. CelesTrak's `visual`.
 *
 * Catalog IDs only; the elements themselves already arrived with the catalog. A 404
 * means the group has never been ingested, which is a different statement from an
 * empty group and is surfaced as such rather than as "nothing is visible".
 */
export async function fetchCatalogGroup(group: string): Promise<CatalogGroupResponse> {
  return catalogGroupResponseSchema.parse(
    await getJson(`/catalog/groups/${encodeURIComponent(group)}`),
  );
}

export function catalogElementsUrl(): string {
  return new URL("/catalog/elements", baseUrl()).toString();
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function getJson(path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(path, baseUrl());
  if (params) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url, { cache: "no-store" });
  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const errorBody = body as { error?: { code?: string; message?: string } } | undefined;
    throw new ApiError(
      response.status,
      errorBody?.error?.code ?? "UNKNOWN_ERROR",
      errorBody?.error?.message ?? `Request to ${path} failed with status ${response.status}`,
    );
  }
  return body;
}

/** Search and filter the catalog. Drives the command palette. */
export async function fetchSatellites(search?: string): Promise<SatelliteListResponse> {
  return satelliteListResponseSchema.parse(
    await getJson("/satellites", search ? { search, limit: "25" } : { limit: "25" }),
  );
}

/** Elements + accuracy assessment for one object, optionally at a past instant. */
export async function fetchElements(
  catalogId: string,
  at?: Date,
): Promise<ElementsResponse> {
  return elementsResponseSchema.parse(
    await getJson(
      `/satellites/${encodeURIComponent(catalogId)}/elements`,
      at ? { at: at.toISOString() } : undefined,
    ),
  );
}
