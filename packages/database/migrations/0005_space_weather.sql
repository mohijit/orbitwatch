-- Space weather, from NOAA SWPC.
--
-- WHY A SATELLITE TRACKER STORES THIS
-- Not decoration, and not a weather widget. Elevated geomagnetic activity heats and
-- expands the thermosphere, which raises drag on everything in low orbit. Two
-- consequences matter to this product directly:
--
--   * a propagated position drifts from reality faster during a storm, so the accuracy
--     this app reports for an ageing element set is optimistic exactly when the sky is
--     most disturbed;
--   * radio blackouts (the R scale) degrade the HF and VHF links the ground-station
--     audience is here for.
--
-- So this is context for how far to trust a position, which is the question the whole
-- product is organised around.
--
-- ONE TABLE, THREE SOURCES, NULLABLE COLUMNS
-- NOAA publishes three unrelated shapes: a 3-hourly Kp series, a 1-minute solar wind
-- stream, and a current-conditions scales document. They are stored together keyed on
-- (source, observed_at) with each source populating its own columns.
--
-- The alternative — a generic (metric, value) table — would lose the types and make
-- every read a pivot. Three separate tables would triple the ingestion and the
-- retention policy to express one idea. Nullable columns are the honest middle: a NULL
-- here means "this source does not report that quantity", which is true.
--
-- OBSERVED_AT IS NOT RETRIEVED_AT
-- The same distinction the whole codebase keeps for element epoch versus fetch time.
-- Solar wind samples are additionally propagated from the spacecraft to Earth, so the
-- instant a measurement DESCRIBES and the instant it was TAKEN differ by roughly an
-- hour; `observed_at` is the one a user cares about.

CREATE TABLE IF NOT EXISTS space_weather (
    -- 'planetary-k-index' | 'solar-wind' | 'scales'. Not a display name.
    source                TEXT             NOT NULL,
    observed_at           TIMESTAMPTZ      NOT NULL,

    -- Planetary K index: the 3-hourly geomagnetic index, 0-9.
    kp                    DOUBLE PRECISION,
    a_running             DOUBLE PRECISION,

    -- Solar wind, propagated to Earth.
    solar_wind_speed_km_s DOUBLE PRECISION,
    solar_wind_density    DOUBLE PRECISION,
    -- Bz is the geoeffective component: sustained southward (negative) Bz drives storms.
    bz_nt                 DOUBLE PRECISION,

    -- NOAA's R/S/G scales, 0-5. Stored as integers because they are ordinal levels,
    -- not measurements, and NOAA publishes them as strings that must not be averaged.
    radio_blackout_scale  SMALLINT,
    solar_radiation_scale SMALLINT,
    geomagnetic_scale     SMALLINT,

    retrieved_at          TIMESTAMPTZ      NOT NULL,

    PRIMARY KEY (source, observed_at)
);

-- The dominant query is "the most recent observation from this source", and after that
-- "the last N hours of it" for a sparkline. Descending because both read from the end.
CREATE INDEX IF NOT EXISTS space_weather_recent_idx
    ON space_weather (source, observed_at DESC);
