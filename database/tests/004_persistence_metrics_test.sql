-- Test for migration 004's folding behaviour.
--
-- SAFE TO RUN ANYWHERE, INCLUDING AGAINST PRODUCTION: every statement below
-- touches a TEMP table cloned from fire_incidents. No row of the real table
-- is read or written, and the whole thing is wrapped in a transaction that
-- rolls back regardless.
--
-- WHAT IS BEING TESTED, AND WHY IT MATTERS
--
-- The incident match rule keeps an incident open for 72 hours within 2 km, so
-- the cluster job merges into the SAME incident run after run. Anything that
-- accumulates additively across those merges will drift upwards: a counter
-- incremented once per run counts the number of runs, not the number of days.
--
-- distinct_days_seen must therefore fold as a SET UNION and be idempotent —
-- re-seeing a day it already knows about must change nothing. The FRP
-- accumulators must fold ADDITIVELY, which is correct for them because each
-- detection is linked exactly once (linkDetections sets incident_id, and the
-- cluster query only reads rows where it is NULL).
--
--   psql "$DATABASE_URL" -f database/tests/004_persistence_metrics_test.sql

\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE t (LIKE fire_incidents INCLUDING ALL) ON COMMIT DROP;

-- ── 1. create ──────────────────────────────────────────────────────────────
-- Two detections, both on 2026-08-05, FRP 4.0 and 6.0.
INSERT INTO t (first_detected_at, last_detected_at, detection_count,
               overpass_times, overpass_count, centroid, footprint,
               max_frp_mw, satellite_state, hours_since_last_detection,
               seen_days, distinct_days_seen,
               frp_sum, frp_sum_sq, frp_sample_count)
VALUES ('2026-08-05T06:00:00Z', '2026-08-05T18:00:00Z', 2,
        ARRAY['2026-08-05T06:00:00Z','2026-08-05T18:00:00Z']::timestamptz[], 2,
        ST_SetSRID(ST_MakePoint(35, 39), 4326),
        ST_Multi(ST_SetSRID(ST_MakePoint(35, 39), 4326)),
        6.0, 'no_recent_detection', 10,
        ARRAY['2026-08-05']::date[], 1,
        10.0, 52.0, 2);

DO $$
DECLARE d INT; m NUMERIC; s NUMERIC;
BEGIN
  SELECT distinct_days_seen, frp_mean, frp_stddev INTO d, m, s FROM t;
  ASSERT d = 1, format('after create: distinct_days_seen expected 1, got %s', d);
  ASSERT round(m, 4) = 5.0, format('after create: frp_mean expected 5, got %s', m);
  -- population sd of {4,6} is 1
  ASSERT round(s, 4) = 1.0, format('after create: frp_stddev expected 1, got %s', s);
  RAISE NOTICE 'PASS 1/5  create: 1 day, mean 5.0, sd 1.0';
END $$;

-- ── 2. merge SAME day: the counter must not move ───────────────────────────
-- This is the case the 72-hour match rule produces on every subsequent run.
UPDATE t SET
  detection_count = detection_count + 1,
  seen_days = sub.days,
  distinct_days_seen = COALESCE(array_length(sub.days, 1), 0),
  frp_sum = frp_sum + 8.0,
  frp_sum_sq = frp_sum_sq + 64.0,
  frp_sample_count = frp_sample_count + 1
FROM (
  SELECT ARRAY(SELECT DISTINCT unnest(t2.seen_days || ARRAY['2026-08-05']::date[])
               ORDER BY 1) AS days
  FROM t t2
) sub;

DO $$
DECLARE d INT; n INT;
BEGIN
  SELECT distinct_days_seen, frp_sample_count INTO d, n FROM t;
  ASSERT d = 1, format('same-day merge inflated the day counter to %s', d);
  ASSERT n = 3, format('same-day merge lost an FRP sample: %s', n);
  RAISE NOTICE 'PASS 2/5  same-day merge: still 1 day, 3 FRP samples';
END $$;

-- ── 3. merge a NEW day: exactly one more ───────────────────────────────────
UPDATE t SET
  seen_days = sub.days,
  distinct_days_seen = COALESCE(array_length(sub.days, 1), 0)
FROM (
  SELECT ARRAY(SELECT DISTINCT unnest(t2.seen_days || ARRAY['2026-08-06']::date[])
               ORDER BY 1) AS days
  FROM t t2
) sub;

DO $$
DECLARE d INT;
BEGIN
  SELECT distinct_days_seen INTO d FROM t;
  ASSERT d = 2, format('new-day merge expected 2 days, got %s', d);
  RAISE NOTICE 'PASS 3/5  new-day merge: 2 days';
END $$;

-- ── 4. idempotence: replaying the same two days ten times changes nothing ──
DO $$
DECLARE i INT; d INT;
BEGIN
  FOR i IN 1..10 LOOP
    UPDATE t SET
      seen_days = sub.days,
      distinct_days_seen = COALESCE(array_length(sub.days, 1), 0)
    FROM (
      SELECT ARRAY(SELECT DISTINCT
                     unnest(t2.seen_days || ARRAY['2026-08-05','2026-08-06']::date[])
                   ORDER BY 1) AS days
      FROM t t2
    ) sub;
  END LOOP;
  SELECT distinct_days_seen INTO d FROM t;
  ASSERT d = 2, format('ten replays drifted the counter to %s (must stay 2)', d);
  RAISE NOTICE 'PASS 4/5  ten replays of known days: still 2';
END $$;

-- ── 5. a constant source must give sd 0, not NaN or a negative root ────────
-- This is the series a gas flare produces, and the one the GREATEST() guard
-- in the generated column exists for.
INSERT INTO t (first_detected_at, last_detected_at, detection_count,
               overpass_times, overpass_count, centroid, footprint,
               satellite_state, hours_since_last_detection,
               seen_days, distinct_days_seen,
               frp_sum, frp_sum_sq, frp_sample_count)
VALUES ('2026-08-05T00:00:00Z', '2026-08-06T00:00:00Z', 20,
        ARRAY['2026-08-05T00:00:00Z']::timestamptz[], 1,
        ST_SetSRID(ST_MakePoint(28.55479, 41.02057), 4326),
        ST_Multi(ST_SetSRID(ST_MakePoint(28.55479, 41.02057), 4326)),
        'detected_recently', 1,
        ARRAY['2026-08-05','2026-08-06']::date[], 2,
        -- twenty samples of exactly 4.35 MW
        87.0, 378.45, 20);

DO $$
DECLARE m NUMERIC; s NUMERIC;
BEGIN
  SELECT frp_mean, frp_stddev INTO m, s
  FROM t ORDER BY frp_sample_count DESC LIMIT 1;
  ASSERT round(m, 4) = 4.35, format('constant source mean expected 4.35, got %s', m);
  ASSERT s = 0, format('constant source sd expected 0, got %s', s);
  RAISE NOTICE 'PASS 5/5  constant 4.35 MW source: mean 4.35, sd 0';
END $$;

ROLLBACK;
