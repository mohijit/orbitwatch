-- OrbitWatch initial schema
--
-- Design notes that matter:
--
--   * catalog_id is TEXT, not an integer. The public catalog has outgrown the
--     five-digit TLE field, and the Alpha-5 successor encoding uses a leading letter
--     ("A0001" denotes 100001). An integer column silently corrupts those. See
--     docs/adr/0004-orbital-data-model.md.
--
--   * orbital_elements is append-only history, not a mutable "current elements" row.
--     Historical Orbit Replay must use the element set that was current at the time
--     being replayed; propagating today's elements backwards across a manoeuvre
--     produces an orbit the spacecraft was never in. History is what makes correct
--     replay possible, so it is the primary storage model rather than a debugging
--     luxury.
--
--   * Every timestamp is TIMESTAMPTZ. Orbital work is UTC end to end, and a naive
--     timestamp column is how local time silently leaks into a data model.

CREATE TABLE IF NOT EXISTS satellites (
    catalog_id                TEXT PRIMARY KEY,
    name                      TEXT        NOT NULL,
    international_designator  TEXT,
    object_type               TEXT        NOT NULL DEFAULT 'UNKNOWN',
    operational_status        TEXT,
    owner                     TEXT,
    launch_date               DATE,
    launch_site               TEXT,
    decay_date                DATE,
    -- Catalog-reported orbit summary. Authoritative values for a given moment come
    -- from propagating orbital_elements; these support search and filtering without
    -- propagating the whole catalog.
    period_minutes            DOUBLE PRECISION,
    inclination_degrees       DOUBLE PRECISION,
    apogee_km                 DOUBLE PRECISION,
    perigee_km                DOUBLE PRECISION,
    rcs_square_metres         DOUBLE PRECISION,
    orbit_class               TEXT,
    -- Provider fields we do not model explicitly, retained for provenance.
    metadata                  JSONB       NOT NULL DEFAULT '{}'::jsonb,
    source_provider           TEXT        NOT NULL,
    first_seen_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT satellites_object_type_valid
        CHECK (object_type IN ('PAYLOAD', 'ROCKET BODY', 'DEBRIS', 'UNKNOWN'))
);

CREATE INDEX IF NOT EXISTS satellites_name_idx           ON satellites USING gin (to_tsvector('simple', name));
CREATE INDEX IF NOT EXISTS satellites_object_type_idx    ON satellites (object_type);
CREATE INDEX IF NOT EXISTS satellites_orbit_class_idx    ON satellites (orbit_class);
CREATE INDEX IF NOT EXISTS satellites_owner_idx          ON satellites (owner);
CREATE INDEX IF NOT EXISTS satellites_intl_designator_idx ON satellites (international_designator);
CREATE INDEX IF NOT EXISTS satellites_decay_date_idx     ON satellites (decay_date) WHERE decay_date IS NOT NULL;


CREATE TABLE IF NOT EXISTS orbital_elements (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    catalog_id    TEXT        NOT NULL REFERENCES satellites (catalog_id) ON DELETE CASCADE,
    provider      TEXT        NOT NULL,
    format        TEXT        NOT NULL,
    -- When the elements describe the orbit.
    epoch         TIMESTAMPTZ NOT NULL,
    -- When OrbitWatch obtained them. Deliberately distinct from epoch: elements
    -- retrieved two minutes ago can have an epoch eighteen hours old, and the UI must
    -- be able to state both.
    retrieved_at  TIMESTAMPTZ NOT NULL,
    omm           JSONB       NOT NULL,
    tle_line_1    TEXT,
    tle_line_2    TEXT,
    -- Cheap propagation guards, denormalised from the OMM so a query can skip
    -- obviously-unusable sets without parsing JSON.
    mean_motion   DOUBLE PRECISION NOT NULL,
    eccentricity  DOUBLE PRECISION NOT NULL,
    inclination   DOUBLE PRECISION NOT NULL,
    bstar         DOUBLE PRECISION,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT orbital_elements_format_valid CHECK (format IN ('OMM_JSON', 'TLE')),
    CONSTRAINT orbital_elements_eccentricity_valid CHECK (eccentricity >= 0 AND eccentricity < 1),
    CONSTRAINT orbital_elements_mean_motion_positive CHECK (mean_motion > 0),

    -- One row per object per epoch per provider. Re-ingesting an unchanged element
    -- set is a no-op rather than unbounded duplicate history.
    CONSTRAINT orbital_elements_unique_epoch UNIQUE (catalog_id, provider, epoch)
);

-- The dominant query: "elements for object X at or before time T", which is exactly
-- what historical replay and live tracking both need. DESC matches the scan order.
CREATE INDEX IF NOT EXISTS orbital_elements_catalog_epoch_idx
    ON orbital_elements (catalog_id, epoch DESC);

CREATE INDEX IF NOT EXISTS orbital_elements_retrieved_idx
    ON orbital_elements (retrieved_at DESC);


-- Records every ingestion attempt, successful or not. This is what backs the
-- provider status panel and makes "last known good" an auditable claim rather than
-- an assumption.
CREATE TABLE IF NOT EXISTS provider_runs (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider          TEXT        NOT NULL,
    resource          TEXT        NOT NULL,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ,
    status            TEXT        NOT NULL,
    records_fetched   INTEGER     NOT NULL DEFAULT 0,
    records_inserted  INTEGER     NOT NULL DEFAULT 0,
    records_unchanged INTEGER     NOT NULL DEFAULT 0,
    records_rejected  INTEGER     NOT NULL DEFAULT 0,
    -- Upstream's own publication timestamp when it supplies one, so freshness can be
    -- reported against the source rather than against our fetch.
    source_timestamp  TIMESTAMPTZ,
    error_summary     TEXT,

    CONSTRAINT provider_runs_status_valid
        CHECK (status IN ('running', 'success', 'partial', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS provider_runs_provider_started_idx
    ON provider_runs (provider, resource, started_at DESC);


-- Cooperative lease so only one worker ingests a given resource at a time, even
-- across multiple processes or a redeploy overlap. The persistent FetchGuard protects
-- the upstream provider; this protects the database from concurrent writers.
CREATE TABLE IF NOT EXISTS ingestion_leases (
    resource_key  TEXT        PRIMARY KEY,
    holder        TEXT        NOT NULL,
    acquired_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Leases expire so a crashed worker cannot block ingestion indefinitely.
    expires_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS ingestion_leases_expires_idx ON ingestion_leases (expires_at);


-- Schema version tracking for the migration runner.
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT        PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    checksum    TEXT        NOT NULL
);
