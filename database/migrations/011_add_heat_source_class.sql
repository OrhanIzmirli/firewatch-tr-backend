-- Migration 011 — mark incidents that behave like fixed heat sources
--
-- ADDITIVE. Three nullable columns on fire_incidents. Nothing is deleted or
-- hidden: an incident that carries the class is still an incident, still
-- listed, still on the map — it is LABELLED, so the app can draw it grey
-- instead of red and the home screen can leave it out of "active fires".
--
-- WHY
--
-- After 50 days of history the picture migration 004 hoped for is here.
-- Measured on the 500 most recent incidents (2026-09-24):
--
--   fixed sources   distinct_days 7–51, frp_mean 0.8–3.7 MW, max_frp 1–14 MW,
--                   drift ≤ 1.5 m/h — Ereğli and Aliağa steelworks, İzmir and
--                   İzmit refineries, Soma and Karabük plants, SE gas flares
--   real long fires distinct_days 9–23, frp_mean 7.5–13.4 MW, max_frp 32–140 MW,
--                   drift 3–16 m/h — the late-August Osmaniye complex, Mardin
--
-- The two populations do not touch on either power measure, so the rule is
--
--     distinct_days_seen >= 7 AND frp_mean < 5 AND max_frp_mw < 20
--
-- It replaces the interim (days ≥ 2, max_frp < 10, overpass ≥ 6) gate, which
-- the steelworks slipped through at 11–14 MW peaks. Recomputed on EVERY
-- cluster run for EVERY incident, so the class appears and disappears with
-- the evidence; there is no manual list of plants.
--
-- The class is a statement about the heat source, never about a fire being
-- out. It must not be read as "extinguished" anywhere.
--
-- PRE-FLIGHT
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'fire_incidents' AND column_name = 'distinct_days_seen';
--   -- one row: migration 004 must already be applied

BEGIN;

ALTER TABLE fire_incidents
  ADD COLUMN IF NOT EXISTS heat_source_class      TEXT,
  ADD COLUMN IF NOT EXISTS heat_source_reason     TEXT,
  ADD COLUMN IF NOT EXISTS heat_source_flagged_at TIMESTAMPTZ;

-- One class today; the CHECK keeps a second from arriving without a migration
-- that says what it means.
ALTER TABLE fire_incidents
  DROP CONSTRAINT IF EXISTS fire_incidents_heat_source_class_check;
ALTER TABLE fire_incidents
  ADD CONSTRAINT fire_incidents_heat_source_class_check
  CHECK (heat_source_class IS NULL OR heat_source_class IN ('persistent_heat_source'));

-- A class always says when and why; no class carries neither.
ALTER TABLE fire_incidents
  DROP CONSTRAINT IF EXISTS fire_incidents_heat_source_provenance_check;
ALTER TABLE fire_incidents
  ADD CONSTRAINT fire_incidents_heat_source_provenance_check
  CHECK ((heat_source_class IS NULL) = (heat_source_flagged_at IS NULL)
         AND (heat_source_class IS NULL) = (heat_source_reason IS NULL));

CREATE INDEX IF NOT EXISTS idx_fire_incidents_heat_source
  ON fire_incidents (heat_source_class) WHERE heat_source_class IS NOT NULL;

COMMIT;

-- POST-CHECK (after the next cluster run, ~30 min)
--   SELECT id, city_id, distinct_days_seen, round(frp_mean,1), max_frp_mw
--     FROM fire_incidents WHERE heat_source_class IS NOT NULL ORDER BY distinct_days_seen DESC;
--   -- expect the 50-day rows (Zonguldak, İzmir ×2, Osmaniye, İstanbul, Karaman,
--   -- Gaziantep, Kahramanmaraş, İçel) and none of the Osmaniye late-August fires
--
-- ROLLBACK
--   ALTER TABLE fire_incidents
--     DROP COLUMN heat_source_class, DROP COLUMN heat_source_reason, DROP COLUMN heat_source_flagged_at;
