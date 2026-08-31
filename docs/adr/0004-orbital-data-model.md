# ADR 0004 — OMM-first elements, catalog IDs as strings, branded units

- Status: Accepted
- Date: 2026-08-31
- Milestone: M0/M1

## Context

Three modelling decisions in the orbital core have consequences everywhere downstream,
and each has a wrong answer that looks perfectly reasonable.

## Decisions

### 1. CCSDS OMM is canonical; TLE is a compatibility format

Both normalise into one `OrbitalElements` type plus a satellite.js `SatRec`.

The legacy TLE format has a fixed-width five-digit catalog number field. The public
catalog has outgrown it, and the successor Alpha-5 encoding is lossy and awkward. OMM
JSON has no such limit, and satellite.js `json2satrec` consumes it directly.

TLE parsing is retained for user imports and older data, and the two paths are asserted
to agree: the same orbit expressed both ways propagates to the same position.

### 2. Catalog IDs are strings, never numbers

`CatalogId = string`. Numeric IDs silently corrupt Alpha-5 identifiers (`A0001` denotes
100001) and invite formatting bugs with zero padding. satellite.js also types
`SatRec.satnum` as a string.

Normalisation strips zero padding so `00025544` and `25544` are the same object, while
preserving Alpha-5 verbatim. This was needed in practice: satellite.js returns the
zero-padded `00005` from a TLE but the unpadded form from OMM, so without normalising,
the two paths produced different identifiers for the same object.

### 3. Units are branded types

`Degrees`, `Radians`, `Kilometers`, `KilometersPerSecond`, `Minutes` and others are
branded numbers. A branded value is assignable to `number`, so arithmetic and
third-party interop still work, but a raw `number` is not assignable to a branded type:
passing degrees where radians are expected becomes a compile error.

The classic failure this prevents is handing an observer position in degrees to
`ecfToLookAngles`, which expects radians. It yields plausible-looking but entirely wrong
azimuths, and nothing else catches it.

Physical constants are named and sourced. `EARTH_RADIUS_KM` is the WGS72 value that SGP4
itself uses, so a round trip through `satrec.alta`/`altp` stays self-consistent.
`SIDEREAL_DAY_MINUTES` is 1436.07; using the 1440-minute solar day instead is a
well-known way to misclassify every geostationary satellite.

## Consequences

- One representation downstream; nothing outside `elements.ts` knows the wire format.
- Six-digit and Alpha-5 identifiers work today rather than after a future migration.
- Unit errors surface at compile time instead of as silent wrong answers.
- Every branded value needs an explicit constructor at its boundary. That is mild
  ceremony in exchange for removing an entire bug class.

## Bugs this framing caught during M1

- OMM `EPOCH` carries no timezone designator, so `new Date()` parsed it as local time
  and shifted every element set by the host UTC offset — 10 hours on this machine, 0 on
  a UTC CI runner. It would pass CI and be wrong in production.
- Element epoch derived from `satrec.epochyr` produced 1920 rather than 2020, because
  `Date.UTC` maps years 0–99 into the 20th century.
- `normalizeLongitude` mapped exactly +180 to −180, outside its own stated range.
