/**
 * The shape of pass results as they cross the worker boundary.
 *
 * A side-effect-free module imported by both the worker and the main thread, so the
 * two cannot drift. It deliberately does NOT import from propagation.worker.ts: that
 * module calls `self.addEventListener` at load time, and pulling it into the main
 * thread would attach a worker listener to `window`.
 *
 * Everything here is plain JSON-ish data. Dates cross structured clone intact, but
 * orbit-core's branded units do not survive as anything but numbers, so they are
 * declared as numbers rather than pretending the tags mean something on this side.
 */

export interface PassEndpoint {
  readonly time: Date;
  readonly azimuth: number;
  readonly compass: string;
  readonly elevation: number;
  readonly range: number;
}

export interface VisiblePass {
  readonly catalogId: string;
  readonly name: string;
  readonly aos: PassEndpoint;
  readonly maximum: PassEndpoint;
  readonly los: PassEndpoint;
  readonly durationSeconds: number;
  readonly minimumRange: number;
  readonly visibility: string;
  readonly illumination: string | undefined;
}

/** Serialisable observer. Branded units are re-applied inside the worker. */
export interface PlainObserver {
  readonly latitude: number;
  readonly longitude: number;
  readonly altitude: number;
}

export interface VisibleTonightRequest {
  readonly type: "visibleTonight";
  readonly observer: PlainObserver;
  /**
   * Which objects to search. The worker already holds every satrec, so this is the
   * curated subset worth searching — CelesTrak's `visual` group — not a copy of the
   * elements.
   */
  readonly catalogIds: readonly string[];
  /** Search for the next darkness window at or after this instant. */
  readonly from: number;
}

export type VisibleTonightResult =
  | {
      readonly type: "visibleTonight";
      readonly status: "ok";
      readonly darkStart: number;
      readonly darkEnd: number;
      /** How many of the requested objects the worker actually held elements for. */
      readonly searched: number;
      readonly passes: readonly VisiblePass[];
    }
  | {
      /**
       * There is no darkness in the search horizon: polar day, or a high-latitude
       * summer night that never gets past civil twilight. A real answer, not an error.
       */
      readonly type: "visibleTonight";
      readonly status: "no-darkness";
    };
