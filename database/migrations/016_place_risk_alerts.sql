-- Migration 016 — "Yerlerim": per-place fire-danger alerts.
--
-- STRICTLY ADDITIVE: one column with a default and one new table.
--
--   tracked_places.notify_risk  the place's second switch: tell me when the
--                               fire-danger level here reaches High or above.
--   place_risk_state            what the daily check last saw for a place, so
--                               an alert fires when the level rises, at most
--                               once a day. Deleted with the place.
--
-- Take a Neon backup branch before applying to production.

BEGIN;

ALTER TABLE tracked_places
  ADD COLUMN IF NOT EXISTS notify_risk BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS place_risk_state (
  place_id         UUID PRIMARY KEY REFERENCES tracked_places (id) ON DELETE CASCADE,
  -- FWI danger class of the last successful check: 0 very low ... 5 extreme.
  -- NULL when the raster had no data at this point.
  last_class       SMALLINT CHECK (last_class BETWEEN 0 AND 5),
  last_checked_on  DATE NOT NULL,
  last_notified_on DATE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
