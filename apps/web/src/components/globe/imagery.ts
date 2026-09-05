/**
 * NASA GIBS imagery layers.
 *
 * WHY THIS IS NOT AN INGESTION PROVIDER
 * Every other M7 provider publishes records that are fetched, validated, stored and
 * served. GIBS publishes map tiles, consumed directly by the renderer. There is nothing
 * to put in Postgres and no schema to validate, so the usual bar — real call, captured
 * fixture, ingestion test — does not apply and pretending otherwise would be theatre.
 * What CAN be verified is that the tiles resolve and that the date shown is the date
 * rendered, and that is what the tests do.
 *
 * THE HONESTY PROBLEM THIS LAYER CREATES
 * GIBS imagery is a DAILY COMPOSITE for a specific date. The satellites drawn over it
 * are at their position right now. Putting the two together without saying so would
 * conflate observation time with position time — the precise confusion this product
 * exists to refuse everywhere else. So:
 *
 *   - the layer is off by default, and Natural Earth (bundled, undated, offline) stays
 *     the base map;
 *   - when it is on, the imagery date is displayed, not implied;
 *   - the date is chosen conservatively, because today's composite frequently does not
 *     exist yet and a missing tile is worse than a day-old one.
 *
 * OFFLINE
 * Natural Earth ships inside the app bundle. GIBS does not, so this layer needs the
 * network — another reason it is opt-in rather than the default.
 */

export interface GibsLayer {
  readonly id: string;
  readonly label: string;
  /** What it shows, in a sentence a non-specialist can act on. */
  readonly description: string;
  /** GIBS layer identifier, used verbatim in the tile URL. */
  readonly product: string;
  readonly format: "jpg" | "png";
  /**
   * Whether GIBS publishes this product per day or as one fixed composite.
   *
   * It changes the URL — a fixed product has no Time dimension and rejects a date
   * segment — and it changes what the caveat can honestly say. Not every layer here is
   * a daily observation, and claiming a date for one that has none would be its own
   * small lie.
   */
  readonly cadence: "daily" | "fixed";
  /**
   * The GIBS tile matrix set this layer is published in.
   *
   * Not a shared constant: it varies by product, and asking for the wrong one is an
   * HTTP 400 (`TILEMATRIXSET is invalid for LAYER`) on every single tile, which renders
   * as a layer that simply does nothing. That is exactly what happened when `250m` was
   * hard-coded here and night lights is only published at `500m`.
   */
  readonly tileMatrixSet: "250m" | "500m";
  /**
   * Deepest TileMatrix GIBS publishes for this layer's matrix set. Requesting past it
   * returns an exception rather than a tile.
   */
  readonly deepestMatrix: number;
}

export const GIBS_LAYERS: readonly GibsLayer[] = [
  {
    id: "true-color",
    label: "Earth today",
    description:
      "Daily true-colour composite from VIIRS on Suomi NPP. Shows real cloud cover for " +
      "the imagery date — not for right now.",
    product: "VIIRS_SNPP_CorrectedReflectance_TrueColor",
    format: "jpg",
    cadence: "daily",
    tileMatrixSet: "250m",
    deepestMatrix: 8,
  },
  {
    id: "night-lights",
    label: "Night lights",
    description:
      "Cloud-free global composite of city lights. Useful for observing: the bright " +
      "areas are where light pollution will hide all but the brightest passes. Not a " +
      "view of tonight — it is the same map every night.",
    /*
     * WHY THIS PRODUCT AND NOT THE DAY/NIGHT BAND
     * The obvious choice, VIIRS_SNPP_DayNightBand_At_Sensor_Radiance, is at-sensor
     * radiance across the whole disc — so the daylit half is sunlight, and on the half
     * anyone would look at there are no city lights to see at all. It renders, but it
     * does not show the thing the label promises, which is the same class of mistake
     * this product exists to refuse.
     *
     * VIIRS_CityLights_2012 is the cloud-free global night composite. It is fixed
     * rather than daily, and that suits the question: light pollution is a standing
     * property of a place, not an observation of a particular night. Black Marble was
     * the other candidate and exists only for 2012 and 2016, so a dated request for it
     * fails outright.
     */
    product: "VIIRS_CityLights_2012",
    format: "jpg",
    cadence: "fixed",
    // Published at 500m only. Asking for it at 250m returns
    // `TILEMATRIXSET is invalid for LAYER` on every tile, which looks like nothing
    // happening; 500m also stops one matrix shallower than 250m.
    tileMatrixSet: "500m",
    deepestMatrix: 7,
  },
];

/** GIBS WMTS endpoint for the geographic (EPSG:4326) projection. */
const GIBS_BASE = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best";

/**
 * How many days back to ask for.
 *
 * Today's composite is assembled through the day and is frequently absent or partial
 * when asked for early; yesterday's is complete. One day back trades a small staleness
 * — which is displayed, so it is not a hidden cost — for a layer that actually renders.
 */
export const IMAGERY_LAG_DAYS = 1;

/**
 * The imagery date to request for a given moment.
 *
 * UTC deliberately: GIBS composites are defined on UTC days, so using the viewer's
 * local date would request tomorrow's imagery for anyone east of Greenwich in the
 * evening and get nothing back.
 */
export function imageryDateFor(now: Date, lagDays = IMAGERY_LAG_DAYS): string {
  const shifted = new Date(now.getTime() - lagDays * 24 * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * WMTS template for a layer on a date.
 *
 * `{TileMatrix}`, `{TileRow}` and `{TileCol}` are Cesium's placeholders and are left
 * for it to substitute; everything else is fixed here so a caller cannot accidentally
 * build a URL for a layer that does not exist.
 */
export function gibsTileUrl(layer: GibsLayer, date: string): string {
  // A fixed product has no Time dimension, and a date segment in its path is not
  // ignored — it is a different, non-existent resource.
  const time = layer.cadence === "daily" ? `${date}/` : "";
  return (
    `${GIBS_BASE}/${layer.product}/default/${time}` +
    `${layer.tileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.${layer.format}`
  );
}

/**
 * The caveat shown beside the layer, derived from the layer rather than assumed.
 *
 * Kept here so the words and the product cannot come apart: whatever else changes, a
 * layer that is not live must never be presented as live, and a layer with no date must
 * never be given one.
 */
export function imageryCaveat(layer: GibsLayer, now: Date): string {
  const what =
    layer.cadence === "daily"
      ? `Imagery from ${imageryDateFor(now)}`
      : "Fixed composite, not tonight";
  return `${what} · satellite positions are live`;
}

/**
 * Every GIBS EPSG:4326 tile is 512 pixels square.
 *
 * Cesium's WMTS provider defaults to 256 and has no way to discover otherwise, so this
 * has to be told to it explicitly or it picks its detail level against a tile twice the
 * size it thinks it is.
 */
export const GIBS_TILE_SIZE = 512;

/**
 * The first GIBS TileMatrix that Cesium can render at all.
 *
 * GIBS's EPSG:4326 matrix sets are NOT a power-of-two pyramid. Read from the service's
 * own WMTSCapabilities, the grid goes:
 *
 *   matrix 0: 2 x 1     tiles of 288 deg     spans 576 x 288 deg
 *   matrix 1: 3 x 2     tiles of 144 deg     spans 432 x 288 deg
 *   matrix 2: 5 x 3     tiles of  72 deg     spans 360 x 216 deg
 *   matrix 3: 10 x 5    tiles of  36 deg     spans 360 x 180 deg   <- exact
 *   matrix 4: 20 x 10 ... doubling cleanly from here to 320 x 160 at matrix 8
 *
 * The widths are ceil(360 / tile), so the shallow levels have tiles hanging off the
 * edge of the world. Cesium addresses a tile by a geographic rectangle and cannot
 * represent one that runs past +/-180, so matrices 0-2 are not merely awkward, they
 * are unrepresentable. Matrix 3 is the first that tiles the globe exactly, and from
 * there the grid doubles, which is precisely what GeographicTilingScheme produces.
 *
 * So Cesium level 0 is GIBS matrix 3, and `tileMatrixLabels` carries the offset. The
 * cost is that a whole-globe view starts at 50 tiles instead of 2; the alternative was
 * imagery squeezed into a corner of the Earth, which is what a power-of-two scheme
 * pointed at this grid actually draws.
 */
export const GIBS_BASE_MATRIX = 3;

/** Grid at {@link GIBS_BASE_MATRIX}, and therefore Cesium's level zero. */
export const GIBS_LEVEL_ZERO_TILES_X = 10;
export const GIBS_LEVEL_ZERO_TILES_Y = 5;

/**
 * GIBS matrix numbers indexed by Cesium level, for `tileMatrixLabels`.
 *
 * Without this Cesium substitutes its own level number into `{TileMatrix}` and asks
 * matrix 0 for a rectangle belonging to matrix 3.
 */
export function gibsTileMatrixLabels(layer: GibsLayer): string[] {
  const labels: string[] = [];
  for (let matrix = GIBS_BASE_MATRIX; matrix <= layer.deepestMatrix; matrix += 1) {
    labels.push(String(matrix));
  }
  return labels;
}

/** Deepest Cesium level for a layer: its deepest matrix, shifted into Cesium's numbering. */
export function gibsMaximumLevel(layer: GibsLayer): number {
  return layer.deepestMatrix - GIBS_BASE_MATRIX;
}

export function findGibsLayer(id: string): GibsLayer | undefined {
  return GIBS_LAYERS.find((layer) => layer.id === id);
}

/**
 * Attribution, which NASA asks for and which travels with the layer.
 *
 * Written here rather than in a component so that turning the layer on and crediting it
 * cannot come apart.
 */
export const GIBS_ATTRIBUTION =
  "Imagery courtesy of NASA EOSDIS Global Imagery Browse Services (GIBS).";
