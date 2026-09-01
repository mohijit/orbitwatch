import Constants from "expo-constants";

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
 * FINDING THE SERVER IN DEVELOPMENT
 * "localhost" means the phone on a phone, so the one address that cannot work is the
 * obvious one. The emulator has 10.0.2.2; a physical device needs the development
 * machine's LAN address, which changes with the network and is exactly the kind of
 * thing nobody wants to edit by hand before every test.
 *
 * Metro already solved this: the packager tells the client which host it was reached
 * on, and Expo exposes that as `hostUri`. Reusing it with the API's port means the app
 * finds the server on an emulator, on a phone over Wi-Fi, and after the laptop's
 * address changes, with nothing configured.
 *
 * `EXPO_PUBLIC_API_BASE_URL` overrides it and is what release builds use, where there
 * is no packager and the answer is a real deployment.
 */

/** Reachable from the Android emulator only; the last resort if nothing else resolves. */
const EMULATOR_FALLBACK = "http://10.0.2.2:3333";

const API_PORT = 3333;

/**
 * The development machine's address, as the packager reported it.
 *
 * `hostUri` looks like "192.168.1.24:8081". Only the host is taken; the port is
 * Metro's, not the API's. Absent in any build without a packager, which is the signal
 * to fall back.
 */
function packagerHost(): string | undefined {
  const hostUri = Constants.expoConfig?.hostUri;
  if (typeof hostUri !== "string" || hostUri === "") return undefined;
  const host = hostUri.split(":")[0];
  return host === undefined || host === "" ? undefined : host;
}

export function apiBaseUrl(): string {
  const configured = process.env["EXPO_PUBLIC_API_BASE_URL"];
  if (configured !== undefined && configured !== "") return configured;

  const host = packagerHost();
  return host === undefined ? EMULATOR_FALLBACK : `http://${host}:${String(API_PORT)}`;
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
