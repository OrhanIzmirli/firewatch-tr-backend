-- 004b: backfill the persistence metrics for incidents that predate 004.
--
-- SEPARATE FILE ON PURPOSE. This was originally written as a commented-out
-- block at the bottom of 004_add_incident_persistence_metrics.sql, which was
-- a mistake: "apply the migration" reasonably means "run the file", and the
-- file's DDL succeeded while the backfill sat inert inside `--` comments. The
-- symptom was distinct_days_seen = 0 on 285 of 289 incidents after the
-- migration was reported as applied, which in turn kept the fixed-source
-- exclusion switched off, because it keys on distinct_days_seen >= 2.
--
-- A required step belongs in a file you can run, not in prose.
--
-- SAFE TO RE-RUN. It recomputes from fire_detections rather than folding, so
-- running it twice produces the same answer. Incidents whose detections have
-- aged past the 90-day prune keep whatever they already had rather than being
-- reset to zero — the counts they carry are still the best record of what was
-- seen, and clearing them would lose information the raw rows no longer hold.
--
--   psql "$DATABASE_URL" -f database/migrations/004b_backfill_persistence_metrics.sql

\set ON_ERROR_STOP on

BEGIN;

UPDATE fire_incidents fi SET
  seen_days          = d.days,
  distinct_days_seen = COALESCE(array_length(d.days, 1), 0),
  frp_sum            = d.frp_sum,
  frp_sum_sq         = d.frp_sum_sq,
  frp_sample_count   = d.frp_sample_count
FROM (
  SELECT incident_id,
         array_agg(DISTINCT (acquired_at AT TIME ZONE 'UTC')::date) AS days,
         COALESCE(sum(frp_mw), 0)                                   AS frp_sum,
         COALESCE(sum(frp_mw * frp_mw), 0)                          AS frp_sum_sq,
         count(frp_mw)::int                                         AS frp_sample_count
    FROM fire_detections
   WHERE incident_id IS NOT NULL
   GROUP BY incident_id
) d
WHERE fi.id = d.incident_id;

-- What changed, printed before the commit so it can be sanity-checked.
DO $$
DECLARE with_days INT; total INT; multi INT;
BEGIN
  SELECT count(*) INTO total FROM fire_incidents;
  SELECT count(*) INTO with_days
    FROM fire_incidents WHERE distinct_days_seen > 0;
  SELECT count(*) INTO multi
    FROM fire_incidents WHERE distinct_days_seen >= 2;
  RAISE NOTICE 'incidents: %', total;
  RAISE NOTICE 'distinct_days_seen > 0 : %', with_days;
  RAISE NOTICE 'distinct_days_seen >= 2: %  <- the fixed-source exclusion can only act on these', multi;
END $$;

COMMIT;
