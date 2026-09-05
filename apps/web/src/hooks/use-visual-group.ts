"use client";

import { useEffect, useState } from "react";

import { fetchCatalogGroup } from "../lib/api-client";

/**
 * CelesTrak's `visual` group: the objects bright enough to look for by eye.
 *
 * Fetched once and held for the session. Membership changes on the provider's
 * ingestion cadence, not on ours, so re-fetching it as the clock moves would be
 * requests spent to learn nothing.
 *
 * `unavailable` is distinct from an empty list, and the distinction matters. An empty
 * group would mean "nothing is bright enough tonight", which is a claim about the sky.
 * A group that has never been ingested means we do not know, and the UI has to say
 * that instead of showing an empty result that reads like an answer.
 */

export type VisualGroupState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "ready"; readonly catalogIds: readonly string[] };

const GROUP = "visual";

export function useVisualGroup(): VisualGroupState {
  const [state, setState] = useState<VisualGroupState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetchCatalogGroup(GROUP);
        if (cancelled) return;
        setState({ status: "ready", catalogIds: response.catalogIds });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "unavailable",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
