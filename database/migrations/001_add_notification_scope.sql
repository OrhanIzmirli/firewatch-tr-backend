-- Migration 001 — notification scope preferences on fcm_tokens
--
-- STRICTLY ADDITIVE. No DROP, no type change, no data deletion.
-- Every existing row keeps receiving notifications: alert_scope defaults to
-- 'all', which is exactly the pre-migration behaviour (send to everyone).
--
-- ---------------------------------------------------------------------------
-- PRE-FLIGHT — run this FIRST against the live database and read the output
-- before applying anything below. The live table is known to have drifted from
-- database/schema.sql (subscribeToken writes device_name/device_type/updated_at,
-- none of which are in schema.sql), so confirm what is actually there:
--
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'fcm_tokens'
--   ORDER BY ordinal_position;
--
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'turkey_cities' ORDER BY ordinal_position;
--
-- Expected: none of alert_scope / region_key / city_id exist yet. If any of
-- them do exist with a different type, STOP and re-plan — the IF NOT EXISTS
-- guards below will silently skip them and leave a type mismatch behind.
-- ---------------------------------------------------------------------------
--
-- Rollout note: ADD COLUMN with a constant DEFAULT is a metadata-only
-- operation on PostgreSQL 11+, so this does not rewrite the table and does not
-- hold a long lock even with beta users connected.

BEGIN;

-- 1. Scope selector. 'all' reproduces today's behaviour for every existing row.
ALTER TABLE fcm_tokens
  ADD COLUMN IF NOT EXISTS alert_scope TEXT NOT NULL DEFAULT 'all';

-- 2. Region key — same seven keys the Flutter client uses in
--    lib/models/fire_point.dart::_bboxRegionKey. NULL unless alert_scope='region'.
ALTER TABLE fcm_tokens
  ADD COLUMN IF NOT EXISTS region_key TEXT;

-- 3. City id — references turkey_cities(id). NULL unless alert_scope='city'.
--    Deliberately NOT declared as a FOREIGN KEY: adding one would take a lock
--    on turkey_cities and would fail outright if that table's primary key is
--    not what we assume. Referential integrity is enforced in the API layer,
--    which validates city_id against turkey_cities before writing.
ALTER TABLE fcm_tokens
  ADD COLUMN IF NOT EXISTS city_id INTEGER;

-- 4. Value guard for alert_scope. Added NOT VALID so existing rows are not
--    scanned during the migration (they are all 'all' anyway, but NOT VALID
--    keeps the statement lock-cheap and non-blocking on a live table).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fcm_tokens_alert_scope_check'
  ) THEN
    ALTER TABLE fcm_tokens
      ADD CONSTRAINT fcm_tokens_alert_scope_check
      CHECK (alert_scope IN ('all', 'region', 'city')) NOT VALID;
  END IF;
END $$;

-- 5. Targeting indexes. Partial on is_active because every send path filters
--    on it first.
CREATE INDEX IF NOT EXISTS idx_fcm_tokens_scope_region
  ON fcm_tokens (alert_scope, region_key) WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_fcm_tokens_scope_city
  ON fcm_tokens (alert_scope, city_id) WHERE is_active;

COMMIT;

-- ---------------------------------------------------------------------------
-- POST-CHECK — expect every pre-existing row to read 'all' / NULL / NULL:
--
--   SELECT alert_scope, region_key, city_id, count(*)
--   FROM fcm_tokens GROUP BY 1, 2, 3 ORDER BY 4 DESC;
--
-- Optional, only once the app has been shipping the new fields for a while and
-- you have confirmed there are no violating rows:
--
--   ALTER TABLE fcm_tokens VALIDATE CONSTRAINT fcm_tokens_alert_scope_check;
-- ---------------------------------------------------------------------------
