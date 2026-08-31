import {
  invjday,
  json2satrec,
  twoline2satrec,
  type OMMJsonObject,
  type SatRec,
} from "satellite.js";

import type { DataProvider, OrbitalElements } from "./types.js";
import {
  degrees,
  radians,
  radiansPerMinute,
  radiansPerMinuteToRevolutionsPerDay,
  revolutionsPerDay,
  toDegrees,
} from "./units.js";

/**
 * Normalisation of orbital elements into one internal representation.
 *
 * OrbitWatch is OMM-first: CCSDS OMM (JSON) is the canonical input, and TLE is
 * supported as a compatibility format for older objects and user imports. Both
 * collapse into `OrbitalElements` plus a satellite.js `SatRec`, so nothing
 * downstream needs to know which format the data arrived in.
 */

export class ElementParseError extends Error {
  constructor(
    message: string,
    readonly detail: { readonly catalogId?: string; readonly reason: string },
  ) {
    super(message);
    this.name = "ElementParseError";
  }
}

/** An `OrbitalElements` bundled with the satellite.js record built from it. */
export interface ParsedElements {
  readonly elements: OrbitalElements;
  readonly satrec: SatRec;
}

export interface ParseOmmOptions {
  readonly provider?: DataProvider;
  /** When OrbitWatch fetched these elements. Defaults to now. */
  readonly retrievedAt?: Date;
  /**
   * SGP4 operation mode. "i" (improved) is correct for modern data; "a" reproduces
   * legacy AFSPC behaviour and exists only for comparison against old tooling.
   */
  readonly opsmode?: "a" | "i";
}

/**
 * Parse a CCSDS OMM JSON object.
 *
 * Numeric OMM fields may legitimately arrive as strings or numbers — CelesTrak emits
 * numbers, Space-Track emits strings — so every numeric read goes through
 * `readNumber` rather than assuming a type.
 */
export function parseOmm(
  omm: OMMJsonObject,
  options: ParseOmmOptions = {},
): ParsedElements {
  const catalogId = normalizeCatalogId(omm.NORAD_CAT_ID);
  if (catalogId === undefined) {
    throw new ElementParseError("OMM is missing a usable NORAD_CAT_ID", {
      reason: "missing-catalog-id",
    });
  }

  const epoch = parseUtcTimestamp(omm.EPOCH);
  if (epoch === undefined || Number.isNaN(epoch.getTime())) {
    throw new ElementParseError(`OMM EPOCH is not a valid date: ${omm.EPOCH}`, {
      catalogId,
      reason: "invalid-epoch",
    });
  }

  let satrec: SatRec;
  try {
    satrec = json2satrec(omm, options.opsmode ?? "i");
  } catch (error) {
    throw new ElementParseError(
      `satellite.js rejected OMM for ${catalogId}: ${describe(error)}`,
      { catalogId, reason: "satrec-construction-failed" },
    );
  }

  const elements: OrbitalElements = {
    catalogId,
    name: typeof omm.OBJECT_NAME === "string" ? omm.OBJECT_NAME : catalogId,
    internationalDesignator:
      typeof omm.OBJECT_ID === "string" && omm.OBJECT_ID.length > 0
        ? omm.OBJECT_ID
        : undefined,
    epoch,
    retrievedAt: options.retrievedAt ?? new Date(),
    provider: options.provider ?? "celestrak",
    format: "OMM_JSON",
    meanMotion: revolutionsPerDay(readNumber(omm.MEAN_MOTION, "MEAN_MOTION", catalogId)),
    eccentricity: readNumber(omm.ECCENTRICITY, "ECCENTRICITY", catalogId),
    inclination: degrees(readNumber(omm.INCLINATION, "INCLINATION", catalogId)),
    raan: degrees(readNumber(omm.RA_OF_ASC_NODE, "RA_OF_ASC_NODE", catalogId)),
    argumentOfPerigee: degrees(
      readNumber(omm.ARG_OF_PERICENTER, "ARG_OF_PERICENTER", catalogId),
    ),
    meanAnomaly: degrees(readNumber(omm.MEAN_ANOMALY, "MEAN_ANOMALY", catalogId)),
    bstar: readNumber(omm.BSTAR, "BSTAR", catalogId),
    elementSetNumber: readOptionalNumber(omm.ELEMENT_SET_NO),
    revolutionAtEpoch: readOptionalNumber(omm.REV_AT_EPOCH),
    classification:
      typeof omm.CLASSIFICATION_TYPE === "string" ? omm.CLASSIFICATION_TYPE : undefined,
    rawOmm: omm as Readonly<Record<string, unknown>>,
    rawTle: undefined,
  };

  return { elements, satrec };
}

export interface ParseTleOptions extends ParseOmmOptions {
  /** TLE line 0 (the name line) is optional and not part of the two-line set. */
  readonly name?: string;
}

/**
 * Parse a legacy two-line element set.
 *
 * Retained for compatibility with older data and user imports. New ingestion paths
 * should prefer OMM: the fixed-width catalog-number field in TLE cannot represent
 * modern six-digit identifiers without the lossy Alpha-5 encoding.
 */
export function parseTle(
  line1: string,
  line2: string,
  options: ParseTleOptions = {},
): ParsedElements {
  let satrec: SatRec;
  try {
    satrec = twoline2satrec(line1, line2);
  } catch (error) {
    throw new ElementParseError(`satellite.js rejected TLE: ${describe(error)}`, {
      reason: "satrec-construction-failed",
    });
  }

  // satrec.error is set during construction for malformed element sets.
  if (satrec.error !== 0) {
    throw new ElementParseError(
      `TLE produced an invalid satellite record (SGP4 error ${satrec.error})`,
      { catalogId: satrec.satnum, reason: `sgp4-error-${satrec.error}` },
    );
  }

  const meanMotion = radiansPerMinuteToRevolutionsPerDay(radiansPerMinute(satrec.no));

  // satellite.js preserves the TLE's zero-padded satnum ("00005"); normalise it so
  // the TLE and OMM paths produce identical identifiers for the same object.
  const catalogId = normalizeCatalogId(satrec.satnum) ?? satrec.satnum;

  const elements: OrbitalElements = {
    catalogId,
    name: options.name ?? catalogId,
    internationalDesignator: internationalDesignatorFromTle(line1),
    epoch: epochFromSatrec(satrec),
    retrievedAt: options.retrievedAt ?? new Date(),
    provider: options.provider ?? "user-import",
    format: "TLE",
    meanMotion,
    eccentricity: satrec.ecco,
    inclination: toDegrees(radians(satrec.inclo)),
    raan: toDegrees(radians(satrec.nodeo)),
    argumentOfPerigee: toDegrees(radians(satrec.argpo)),
    meanAnomaly: toDegrees(radians(satrec.mo)),
    bstar: satrec.bstar,
    elementSetNumber: undefined,
    revolutionAtEpoch: undefined,
    classification: undefined,
    rawOmm: undefined,
    rawTle: [line1, line2],
  };

  return { elements, satrec };
}

/**
 * Normalise a catalog identifier to its canonical string form.
 *
 * Kept as a string throughout — see the `CatalogId` docs for why numbers are unsafe.
 * Leading zeros are stripped so "00025544" and "25544" are the same object, but
 * Alpha-5 identifiers (a leading letter) are preserved verbatim.
 */
export function normalizeCatalogId(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(Math.trunc(value)) : undefined;
  }
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  // Purely numeric: strip leading zeros. "00025544" -> "25544".
  if (/^\d+$/.test(trimmed)) {
    return trimmed.replace(/^0+(?=\d)/, "");
  }

  // Alpha-5 (e.g. "A0001") or other encodings: preserve exactly, uppercased.
  if (/^[A-Za-z]\d{4}$/.test(trimmed)) return trimmed.toUpperCase();

  return trimmed;
}

/**
 * Reconstruct the element epoch from a SatRec.
 *
 * Derived from `jdsatepoch` (the Julian date of the epoch) rather than from
 * `epochyr` + `epochdays`. The satellite.js type declares `epochyr` as the "full
 * four-digit year", but for a TLE-sourced record it is in fact the two-digit year
 * from the element set: passing 20 to `Date.UTC` yields 1920, because `Date.UTC`
 * maps years 0-99 into the 20th century. Julian date has no such ambiguity.
 */
function epochFromSatrec(satrec: SatRec): Date {
  return invjday(satrec.jdsatepoch);
}

/**
 * Extract the international designator from TLE line 1, columns 10-17.
 *
 * TLE encodes it as YYNNNP (two-digit launch year, launch number, piece); we expand
 * it to the conventional YYYY-NNNP form. The two-digit year uses the usual
 * satellite-era pivot: 57-99 mean 19xx (Sputnik launched in 1957), 00-56 mean 20xx.
 */
function internationalDesignatorFromTle(line1: string): string | undefined {
  if (line1.length < 17) return undefined;
  const field = line1.slice(9, 17).trim();
  if (field.length < 5) return undefined;

  const yearDigits = field.slice(0, 2);
  const remainder = field.slice(2).trim();
  if (!/^\d{2}$/.test(yearDigits) || remainder.length === 0) return undefined;

  const twoDigitYear = Number.parseInt(yearDigits, 10);
  const fullYear = twoDigitYear >= 57 ? 1900 + twoDigitYear : 2000 + twoDigitYear;
  return `${fullYear}-${remainder}`;
}

/**
 * Parse an OMM timestamp as UTC.
 *
 * CCSDS OMM declares TIME_SYSTEM as UTC, but CelesTrak emits EPOCH values with no
 * timezone designator (for example "2020-05-31T07:19:44.211456"). ECMAScript
 * specifies that a date-time string WITHOUT a designator is interpreted as LOCAL
 * time, so `new Date(epoch)` silently shifts every element set by the host machine's
 * UTC offset — ten hours on an Australian developer machine, zero on a UTC server.
 * That is a particularly nasty class of bug: it passes CI, and puts satellites in
 * the wrong hemisphere in production.
 *
 * We therefore append an explicit "Z" whenever no designator is present.
 */
export function parseUtcTimestamp(value: string): Date | undefined {
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  // Already carries "Z" or a numeric offset such as "+00:00" / "-0500".
  const hasDesignator = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const normalized = hasDesignator ? trimmed : `${trimmed}Z`;

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Read an OMM numeric field that may be encoded as a string or a number. */
function readNumber(value: unknown, field: string, catalogId: string): number {
  const parsed = readOptionalNumber(value);
  if (parsed === undefined) {
    throw new ElementParseError(
      `OMM field ${field} is missing or non-numeric for ${catalogId}`,
      { catalogId, reason: `invalid-${field}` },
    );
  }
  return parsed;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
