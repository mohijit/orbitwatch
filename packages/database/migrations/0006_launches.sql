-- Upcoming launches, from Launch Library 2.
--
-- WHY A TRACKER STORES THIS
-- Every object in the catalog got there by being launched, and the next few days of
-- launches are the next few days of new objects. It is also the one part of the product
-- that looks forward: everything else describes what is already up.
--
-- NET_PRECISION IS THE POINT, NOT A DETAIL
-- Launch Library publishes a T-0 together with how precise that T-0 actually is:
-- Minute, Hour, Day, Week, Month, Quarter, Year. A launch known only to the month
-- still arrives as a full ISO timestamp, so rendering it verbatim produces
-- "14:32:00 on 3 November" for something that might slip four weeks. That is invented
-- precision of exactly the kind this product refuses everywhere else, so the precision
-- is stored alongside the time and the UI is obliged to consult it.
--
-- KEYED ON THE PROVIDER'S UUID
-- Launches slip constantly — a NET moves by hours or months, and the same launch is
-- republished under the same id. Keying on it makes a slip an update rather than a
-- duplicate row.
--
-- NOT LINKED TO satellites
-- A launch has no NORAD id: the objects it delivers are catalogued days later, by a
-- different provider, under numbers nobody knows in advance. Inventing a join here
-- would be asserting a relationship the data does not contain.

CREATE TABLE IF NOT EXISTS launches (
    id                  TEXT        PRIMARY KEY,
    provider            TEXT        NOT NULL,
    name                TEXT        NOT NULL,

    -- No Earlier Than: the scheduled T-0.
    net                 TIMESTAMPTZ NOT NULL,
    -- 'Minute' | 'Hour' | 'Day' | 'Month' | ... NULL means the provider did not say,
    -- which the UI must treat as unknown rather than as exact.
    net_precision       TEXT,
    window_start        TIMESTAMPTZ,
    window_end          TIMESTAMPTZ,

    status_name         TEXT,
    status_abbrev       TEXT,

    service_provider    TEXT,
    rocket_name         TEXT,
    mission_name        TEXT,
    mission_orbit       TEXT,
    pad_name            TEXT,
    pad_location        TEXT,
    -- Present only when the pad has usable coordinates; the globe can then mark it.
    pad_latitude        DOUBLE PRECISION,
    pad_longitude       DOUBLE PRECISION,

    webcast_live        BOOLEAN     NOT NULL DEFAULT FALSE,

    retrieved_at        TIMESTAMPTZ NOT NULL,
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The only query that matters: the next launches from now, soonest first.
CREATE INDEX IF NOT EXISTS launches_net_idx ON launches (net);
