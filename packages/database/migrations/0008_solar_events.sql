-- Solar and geomagnetic events, from NASA DONKI.
--
-- HOW THIS DIFFERS FROM space_weather
-- NOAA reports the CURRENT level on the R/S/G scales: a number describing right now.
-- DONKI publishes discrete EVENTS with narrative — a coronal mass ejection was
-- observed, a geomagnetic storm began, a radiation belt enhancement was detected. The
-- two answer different questions, and both belong: the scales say what conditions are,
-- the events say what happened and why.
--
-- THE BODY IS STORED VERBATIM
-- DONKI bodies are prose written for humans, and their layout varies by message type.
-- Parsing them into columns would be inventing structure NASA did not publish, so the
-- narrative is kept whole and only a summary line is derived for list views.
--
-- MESSAGE TYPE IS TEXT, NOT AN ENUM
-- NASA adds types. A CHECK constraint or a Postgres enum would make a new one an
-- ingestion failure rather than a row this product simply cannot yet explain, which is
-- the wrong trade for a feed whose value is telling you something unusual happened.

CREATE TABLE IF NOT EXISTS solar_events (
    -- NASA's own id, e.g. "20260831-AL-004".
    id           TEXT        PRIMARY KEY,
    provider     TEXT        NOT NULL,
    -- CME | GST | FLR | SEP | RBE | IPS | MPC | Report | anything NASA adds later.
    type         TEXT        NOT NULL,
    -- Whether this product recognises the type well enough to explain it.
    known_type   BOOLEAN     NOT NULL DEFAULT FALSE,

    -- Minute precision, as published: DONKI issues times without seconds.
    issued_at    TIMESTAMPTZ NOT NULL,
    url          TEXT        NOT NULL,
    summary      TEXT        NOT NULL,
    body         TEXT        NOT NULL,

    retrieved_at TIMESTAMPTZ NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The only query: the most recent events, newest first, optionally by type.
CREATE INDEX IF NOT EXISTS solar_events_issued_idx ON solar_events (issued_at DESC);
CREATE INDEX IF NOT EXISTS solar_events_type_idx ON solar_events (type, issued_at DESC);
