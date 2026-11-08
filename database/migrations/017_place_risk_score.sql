-- Migration 017 — place alerts use the FireWatch risk score.
--
-- place_risk_state.last_class held a Copernicus FWI class (0-5). It now holds
-- the FireWatch risk level (0 Low, 1 Medium, 2 High, 3 Critical), so the old
-- rows mean something else and are removed. They are derived data: the next
-- check rebuilds them.
--
-- The check now runs every few hours instead of once a day, because the score
-- follows the weather through the day, so it needs a timestamp.
--
-- Take a Neon backup branch before applying to production.

BEGIN;

DELETE FROM place_risk_state;

ALTER TABLE place_risk_state
  ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;

COMMIT;
