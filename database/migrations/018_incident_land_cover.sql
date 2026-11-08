-- Migration 018 — what the ground is under an incident, and whether a news
-- story confirms it. Decides the main map layer and fire alerts.
--
-- land_cover: natural | agriculture | built | other | unknown; NULL until
-- the job has looked. land_cover_shares keeps the percentages per class so
-- the rule can be re-checked without another lookup.
--
-- Take a Neon backup branch before applying to production.

BEGIN;

ALTER TABLE fire_incidents
  ADD COLUMN IF NOT EXISTS land_cover TEXT,
  ADD COLUMN IF NOT EXISTS land_cover_shares JSONB,
  ADD COLUMN IF NOT EXISTS news_verified_id INTEGER;

CREATE INDEX IF NOT EXISTS fire_incidents_land_cover_pending
  ON fire_incidents (last_detected_at DESC) WHERE land_cover IS NULL;

COMMIT;
