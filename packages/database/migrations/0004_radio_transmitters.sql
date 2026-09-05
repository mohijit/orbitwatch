-- Radio transmitters, as published by the SatNOGS DB.
--
-- WHY THIS EXISTS
-- Orbital elements say where an object is. They say nothing about what it transmits,
-- and for a large part of this product's audience — amateur radio operators, ground
-- station builders, anyone with an SDR — the frequency IS the point. Knowing that
-- an object passes overhead at 18:42 is only actionable if you also know what to tune
-- to. SatNOGS is the community database that publishes exactly that, and nothing in
-- the GP catalog can be made to yield it.
--
-- KEYED ON THE PROVIDER'S UUID, NOT ON ANYTHING WE INVENT
-- One satellite has many transmitters, they change over time, and SatNOGS gives each a
-- stable UUID. Using it as the primary key means an update is an update rather than a
-- duplicate, and a transmitter that is edited upstream converges instead of accreting.
--
-- NOT A FOREIGN KEY TO satellites
-- `norad_cat_id` is deliberately a plain column with an index, not a REFERENCES
-- constraint. SatNOGS carries entries for objects that are not in the GP catalog we
-- ingest — pre-launch payloads, objects CelesTrak has dropped, and a few with no NORAD
-- id at all — and a foreign key would make ingestion fail on exactly the records that
-- are most interesting to a ground station. Orphans are tolerated and joined
-- opportunistically; losing data to satisfy referential tidiness is the worse trade.
--
-- FREQUENCIES ARE STORED IN HERTZ, AS INTEGERS
-- SatNOGS publishes them as integer Hz. Keeping that verbatim avoids a unit conversion
-- on the way in, which is the classic place for a factor of a thousand to hide. BIGINT
-- because 24 GHz does not fit in a 32-bit integer.

CREATE TABLE IF NOT EXISTS radio_transmitters (
    -- SatNOGS's own identifier for this transmitter.
    uuid              TEXT        PRIMARY KEY,
    -- Which provider said so. Present for the same reason as in satellite_groups: a
    -- second source's transmitter list would be a different claim about the same object.
    provider          TEXT        NOT NULL,
    -- Nullable: some SatNOGS entries have no NORAD id yet.
    norad_cat_id      TEXT,
    -- SatNOGS's stable per-satellite id, which survives a NORAD id being assigned late.
    sat_id            TEXT,
    description       TEXT        NOT NULL,
    -- Transceiver / Transmitter / Transponder.
    type              TEXT,
    status            TEXT        NOT NULL,
    -- Whether the provider currently considers this transmitter operational. Stored
    -- separately from `status` because they are different claims and SatNOGS publishes
    -- both; collapsing them would be our interpretation, not their data.
    alive             BOOLEAN     NOT NULL,

    uplink_low_hz     BIGINT,
    uplink_high_hz    BIGINT,
    downlink_low_hz   BIGINT,
    downlink_high_hz  BIGINT,

    mode              TEXT,
    uplink_mode       TEXT,
    baud              DOUBLE PRECISION,
    inverted          BOOLEAN,
    service           TEXT,
    -- Where the frequency information came from, as published. Kept because a
    -- transmitter listing without a source is folklore, and users of this data check.
    citation          TEXT,

    -- The provider's own last-modified timestamp, distinct from when we fetched it.
    -- Same discipline as element epoch versus retrieval time everywhere else here.
    updated_at        TIMESTAMPTZ,
    retrieved_at      TIMESTAMPTZ NOT NULL,
    first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The dominant query: "what does this object transmit", asked once per selected
-- satellite. Partial on alive because a ground station wants what is working now, and
-- the dead entries are history rather than the answer.
CREATE INDEX IF NOT EXISTS radio_transmitters_norad_idx
    ON radio_transmitters (norad_cat_id, alive);

CREATE INDEX IF NOT EXISTS radio_transmitters_sat_id_idx
    ON radio_transmitters (sat_id);
