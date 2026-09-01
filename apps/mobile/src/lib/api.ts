import {
  elementsResponseSchema,
  satelliteListResponseSchema,
  type ElementsResponse,
  type SatelliteListResponse,
} from "@orbitwatch/contracts";

/**
 * Typed API client for the native app.
 *
 * Separate from the web's client and validating with the SAME schemas from
 * `@orbitwatch/contracts`. Sharing the schema is the point: if the server renames a
 * field, web and mobile fail identically and at the boundary, rather than one of them
 * quietly rendering `undefined` on a device where nobody can attach a debugger.
 *
 * BASE URL
 * `EXPO_PUBLIC_API_BASE_URL` is inlined at build time by Expo. The development build
 * profile points it at 10.0.2.2, which is how the Android emulator reaches the host
 * machine's localhost; a physical device needs the host's LAN address instead, which
 * is why it is configuration and not a constant.
 */

const DEFAULT_BASE_URL = "http://10.0.2.2:3333";

export function apiBaseUrl(): string {
  return process.env["EXPO_PUBLIC_API_BASE_URL"] ?? DEFAULT_BASE_URL;
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

/**
 * A request that fails loudly and specifically.
 *
 * A mobile network is a hostile one — captive portals, dead zones, backgrounded
 * sockets — so a failure has to be distinguishable from an empty result. Everything
 * here throws rather than returning a falsy value that a screen could render as
 * "nothing found".
 */
async function getJson(path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(path, apiBaseUrl());
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), { headers: { accept: "application/json" } });

  if (!response.ok) {
    let code = "HTTP_ERROR";
    let message = `Request failed with status ${String(response.status)}`;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // A non-JSON error body is itself informative; keep the status-derived message.
    }
    throw new ApiError(response.status, code, message);
  }

  return response.json();
}

export async function fetchSatellites(
  query: { search?: string; limit?: number } = {},
): Promise<SatelliteListResponse> {
  const params: Record<string, string> = {};
  if (query.search !== undefined) params["search"] = query.search;
  if (query.limit !== undefined) params["limit"] = String(query.limit);
  return satelliteListResponseSchema.parse(await getJson("/satellites", params));
}

export async function fetchElements(catalogId: string): Promise<ElementsResponse> {
  return elementsResponseSchema.parse(
    await getJson(`/satellites/${encodeURIComponent(catalogId)}/elements`),
  );
}
