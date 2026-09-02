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
  /** Deepest zoom GIBS publishes for this product. Requesting past it returns nothing. */
  readonly maxLevel: number;
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
    maxLevel: 8,
  },
  {
    id: "night-lights",
    label: "Night lights",
    description:
      "VIIRS day/night band. Useful for observing: the bright areas are where light " +
      "pollution will hide all but the brightest passes.",
    product: "VIIRS_SNPP_DayNightBand_At_Sensor_Radiance",
    format: "png",
    maxLevel: 8,
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
  return (
    `${GIBS_BASE}/${layer.product}/default/${date}/` +
    `250m/{TileMatrix}/{TileRow}/{TileCol}.${layer.format}`
  );
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
