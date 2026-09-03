-- Moving a watchlist between devices, without an account.
--
-- WHAT THIS DELIBERATELY DOES NOT HOLD
-- No email, no password, no device identifier, and above all no observing location.
-- That location is a home address to within a few metres; it is computed against on the
-- device and it stays there, and the app says so on screen. What syncs is a list of
-- catalog numbers — the objects someone chose to follow — and nothing else.
--
-- THE CODE IS A BEARER SECRET, SO ONLY ITS HASH IS STORED
-- Anyone holding the code can read and replace that list, which makes it a credential
-- even though nobody signed up for anything. Storing it in the clear would mean a
-- database dump handed over every watchlist along with the means to overwrite them.
-- The server hashes what the client sends and looks up by hash, so this table cannot
-- give up a working code even to someone holding all of it.
--
-- SHA-256 WITHOUT A WORK FACTOR, ON PURPOSE
-- A password is guessable and needs bcrypt or argon2 to slow an attacker down. This is
-- 50 bits of server-generated randomness with no structure to guess at, so stretching
-- it would cost every request time while doing nothing an attacker would notice. What
-- protects it is entropy and the API's rate limit, not the cost of a hash.
--
-- IT EXPIRES
-- An abandoned pairing should not sit here indefinitely. Rows untouched for 90 days are
-- deleted, so the store holds what is being used rather than everything that ever was.

CREATE TABLE IF NOT EXISTS watchlist_sync (
    -- SHA-256 of the pairing code, hex. The code itself is never written down here.
    code_hash    TEXT        PRIMARY KEY,

    -- Catalog numbers only. Stored as JSONB rather than a join table because it is
    -- read and written whole, never queried into: there is no question this data
    -- answers other than "what was on this list".
    catalog_ids  JSONB       NOT NULL,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports the expiry sweep, which is the only query that is not a primary-key lookup.
CREATE INDEX IF NOT EXISTS watchlist_sync_updated_at_idx
    ON watchlist_sync (updated_at);
