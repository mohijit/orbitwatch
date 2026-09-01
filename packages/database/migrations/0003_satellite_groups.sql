-- Group membership, as published by a provider.
--
-- WHY THIS EXISTS
-- GP elements say where an object is. They say nothing about how bright it is: no
-- size, no albedo, no shape, no attitude. So "Visible Tonight" computed from elements
-- alone returns every sunlit object that clears the horizon in the dark — measured at
-- 3,614 passes over Sydney in a single night, most of them Starlink and debris nobody
-- can pick out. That list is worse than no list, because it implies a promise the data
-- cannot support.
--
-- CelesTrak publishes a curated `visual` group for exactly this purpose: the objects
-- bright enough to be worth looking for with the naked eye. Membership of that group
-- IS the missing brightness information, in the only form a public catalog offers it.
-- It cannot be derived from the elements, so it has to be stored.
--
-- Deliberately a join table rather than an array column or a JSONB blob on satellites:
--
--   * an object belongs to several groups, and groups are added over time, so this is a
--     many-to-many relationship and modelling it as one keeps the queries honest;
--   * `provider` is part of the key because "visual" means whatever CelesTrak says it
--     means, and a second provider's group of the same name would be a different claim;
--   * first_seen_at and last_seen_at are separate because membership CHANGES. An object
--     that drops out of `visual` should stop being offered as a naked-eye target, and
--     the only way to notice is to record when we last saw it listed.

CREATE TABLE IF NOT EXISTS satellite_groups (
    catalog_id    TEXT        NOT NULL REFERENCES satellites (catalog_id) ON DELETE CASCADE,
    -- Who says so. Not a display name: this is the provider id from policy.ts.
    provider      TEXT        NOT NULL,
    group_name    TEXT        NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Updated on every ingestion that still lists the object. Stale rows are how a
    -- departed member is detected, so this is never allowed to lag behind a run.
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (catalog_id, provider, group_name)
);

-- The dominant query: "give me every member of this group", which is what the
-- observer's visible-object list is built from.
CREATE INDEX IF NOT EXISTS satellite_groups_group_idx
    ON satellite_groups (provider, group_name, catalog_id);
