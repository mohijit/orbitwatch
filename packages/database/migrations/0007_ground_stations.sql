-- Ground stations, from SatNOGS Network.
--
-- WHY THIS EXISTS
-- SatNOGS DB says what a satellite transmits. The Network says who can hear it.
-- Between them a user can ask the question a ground station operator actually has:
-- is anyone positioned to receive this pass, and on what band.
--
-- STATUS IS STORED, NOT FILTERED AWAY AT INGESTION
-- Of 4,452 stations in the captured listing, 4,119 were Offline, 317 Online and 16
-- Testing. A volunteer network is mostly dormant at any moment. Storing only the
-- online ones would make the data useless the next time a station comes back, and
-- presenting the total as receiving capacity would overstate coverage tenfold — so
-- everything is kept and the reader decides.
--
-- MIN_HORIZON IS PER STATION, AND THAT IS THE POINT
-- A site in a valley may not observe below 40 degrees. "Above 10 degrees" is not the
-- same question for every receiver, so the station's own horizon is stored rather than
-- a global default being assumed.
--
-- BANDS AS AN ARRAY
-- A station's antennas are its own sub-resource, but the only question asked of them
-- here is "which bands can this station receive". Deduplicated to an array rather than
-- a child table: a station with four UHF antennas covers one band, and a join table
-- would make the common query a join to answer something already known.

CREATE TABLE IF NOT EXISTS ground_stations (
    id                  TEXT        PRIMARY KEY,
    provider            TEXT        NOT NULL,
    name                TEXT        NOT NULL,

    latitude            DOUBLE PRECISION NOT NULL,
    longitude           DOUBLE PRECISION NOT NULL,
    altitude_m          DOUBLE PRECISION NOT NULL,
    -- Degrees. The station's own lowest observable elevation.
    min_horizon_degrees DOUBLE PRECISION NOT NULL,

    -- 'Online' | 'Offline' | 'Testing', exactly as the Network publishes it.
    status              TEXT        NOT NULL,
    bands               TEXT[]      NOT NULL DEFAULT '{}',
    observations        INTEGER     NOT NULL DEFAULT 0,
    -- NULL for a station that has never checked in.
    last_seen           TIMESTAMPTZ,

    retrieved_at        TIMESTAMPTZ NOT NULL,
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The dominant query is "which stations are working", and after that a geographic
-- filter. Partial on status because the online set is a tenth of the table.
CREATE INDEX IF NOT EXISTS ground_stations_status_idx ON ground_stations (status);
CREATE INDEX IF NOT EXISTS ground_stations_position_idx ON ground_stations (latitude, longitude);
