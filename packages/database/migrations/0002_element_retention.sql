-- Orbital element retention.
--
-- orbital_elements is append-only, so without a policy it grows without bound:
-- ~20,000 objects refreshed every 2 hours is ~240,000 rows per day.
--
-- The policy keeps history where history is actually useful and thins it elsewhere:
--
--   * Everything within the recent window is kept at full resolution. This is what
--     live tracking and near-term replay use.
--   * Beyond that, one element set per object per day is kept. Orbital elements are
--     republished far more often than orbits meaningfully change, so daily resolution
--     preserves the ability to replay a past date without storing every duplicate.
--   * The single newest set per object is never deleted, so an object with stale
--     elements remains propagable rather than vanishing from the catalog.
--
-- Retention is applied by the worker calling prune_orbital_elements(), not by a
-- trigger: deletion should be a scheduled, observable operation with a row count that
-- lands in provider_runs, not a hidden side effect of every insert.

CREATE OR REPLACE FUNCTION prune_orbital_elements(
    full_resolution_days INTEGER DEFAULT 7,
    daily_resolution_days INTEGER DEFAULT 365
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    WITH ranked AS (
        SELECT
            id,
            catalog_id,
            epoch,
            -- Newest set per object, which must always survive.
            ROW_NUMBER() OVER (PARTITION BY catalog_id ORDER BY epoch DESC) AS recency_rank,
            -- Position within its day, so one per day can be kept.
            ROW_NUMBER() OVER (
                PARTITION BY catalog_id, date_trunc('day', epoch)
                ORDER BY epoch DESC
            ) AS rank_within_day
        FROM orbital_elements
    ),
    deletable AS (
        SELECT id
        FROM ranked
        WHERE recency_rank > 1
          AND epoch < now() - make_interval(days => full_resolution_days)
          AND (
                -- Older than the daily-resolution window: drop entirely.
                epoch < now() - make_interval(days => daily_resolution_days)
                -- Within it: keep only the last set of each day.
                OR rank_within_day > 1
              )
    )
    DELETE FROM orbital_elements
    WHERE id IN (SELECT id FROM deletable);

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION prune_orbital_elements IS
    'Thins orbital element history: full resolution recently, daily resolution for a '
    'year, and always keeps the newest set per object so nothing becomes unpropagable.';
