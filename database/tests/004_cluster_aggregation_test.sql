-- Regression test for the buildClusters aggregation.
--
-- SAFE TO RUN ANYWHERE. TEMP tables only, rolls back.
--
--   psql "$DATABASE_URL" -f database/tests/004_cluster_aggregation_test.sql
--
-- WHY THIS FILE EXISTS
--
-- The seen_days column was first aggregated as:
--
--   ARRAY(SELECT DISTINCT (acquired_at AT TIME ZONE 'UTC')::date ORDER BY 1)
--
-- which looks like an aggregate and is not. It is an uncorrelated sub-select
-- with no FROM clause, so inside a GROUP BY it neither aggregates over the
-- group nor counts as an aggregate use of acquired_at — Postgres rejects the
-- whole statement. buildClusters is the FIRST statement in the clustering
-- transaction, so every round rolled back: no incidents created, no spread,
-- and satellite_state stopped being refreshed.
--
-- The failure was invisible from the API. Counts simply stopped moving, and
-- the only external symptom was hours_since_last_detection drifting away
-- from the real age of each incident. This test makes the shape of that
-- query checkable without a full ingest.

\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE d (
  cluster_idx     INT,
  acquired_at     TIMESTAMPTZ,
  frp_mw          NUMERIC,
  confidence_tier TEXT
) ON COMMIT DROP;

-- One cluster seen on two UTC dates, five detections, two of them sharing a
-- date. seen_days must come back with exactly two entries, in order.
INSERT INTO d VALUES
  (1, '2026-08-05T06:00:00Z', 4, 'nominal'),
  (1, '2026-08-05T06:03:00Z', 6, 'high'),
  (1, '2026-08-05T18:00:00Z', 5, 'nominal'),
  (1, '2026-08-06T06:00:00Z', 5, 'nominal'),
  (1, '2026-08-06T18:00:00Z', 5, 'low'),
  -- A second cluster, single day, to prove grouping is per cluster.
  (2, '2026-08-06T06:00:00Z', 9, 'nominal');

CREATE TEMP TABLE agg AS
SELECT cluster_idx,
       count(*)::int                                   AS detection_count,
       COALESCE(sum(frp_mw), 0)                        AS frp_sum,
       COALESCE(sum(frp_mw * frp_mw), 0)               AS frp_sum_sq,
       count(frp_mw)::int                              AS frp_sample_count,
       array_agg(DISTINCT (acquired_at AT TIME ZONE 'UTC')::date) AS seen_days,
       (array_agg(confidence_tier ORDER BY
          CASE confidence_tier WHEN 'high' THEN 0
                               WHEN 'nominal' THEN 1
                               ELSE 2 END))[1]         AS peak_confidence_tier
  FROM d
 GROUP BY cluster_idx;

DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM agg WHERE cluster_idx = 1;

  ASSERT array_length(r.seen_days, 1) = 2,
    format('cluster 1: expected 2 distinct days, got %s (%s)',
           array_length(r.seen_days, 1), r.seen_days);
  ASSERT r.seen_days[1] = DATE '2026-08-05' AND r.seen_days[2] = DATE '2026-08-06',
    format('cluster 1: days out of order or wrong: %s', r.seen_days);
  RAISE NOTICE 'PASS 1/4  seen_days aggregates per group: %', r.seen_days;

  ASSERT r.detection_count = 5,
    format('cluster 1: expected 5 detections, got %s', r.detection_count);
  ASSERT r.frp_sum = 25 AND r.frp_sample_count = 5,
    format('cluster 1: frp_sum %s, samples %s', r.frp_sum, r.frp_sample_count);
  -- 4^2+6^2+5^2+5^2+5^2 = 16+36+25+25+25 = 127
  ASSERT r.frp_sum_sq = 127,
    format('cluster 1: expected sum of squares 127, got %s', r.frp_sum_sq);
  RAISE NOTICE 'PASS 2/4  accumulators: sum %, sum_sq %, n %',
    r.frp_sum, r.frp_sum_sq, r.frp_sample_count;

  ASSERT r.peak_confidence_tier = 'high',
    format('cluster 1: expected peak tier high, got %s', r.peak_confidence_tier);
  RAISE NOTICE 'PASS 3/4  peak confidence tier survives alongside the new columns';

  SELECT * INTO r FROM agg WHERE cluster_idx = 2;
  ASSERT array_length(r.seen_days, 1) = 1,
    format('cluster 2: expected 1 day, got %s', array_length(r.seen_days, 1));
  RAISE NOTICE 'PASS 4/4  grouping is per cluster, not global';
END $$;

-- The mean and standard deviation the generated columns will produce from
-- those accumulators: mean 5, population sd sqrt(127/5 - 25) = sqrt(0.4).
DO $$
DECLARE m NUMERIC; s NUMERIC;
BEGIN
  SELECT frp_sum / frp_sample_count,
         sqrt(GREATEST(frp_sum_sq / frp_sample_count
                       - (frp_sum / frp_sample_count) ^ 2, 0))
    INTO m, s
    FROM agg WHERE cluster_idx = 1;
  ASSERT round(m, 4) = 5.0, format('mean expected 5, got %s', m);
  ASSERT round(s, 4) = round(sqrt(0.4)::numeric, 4),
    format('sd expected %s, got %s', round(sqrt(0.4)::numeric, 4), round(s, 4));
  RAISE NOTICE 'BONUS     derived mean % and sd % match the accumulators',
    round(m, 3), round(s, 3);
END $$;

ROLLBACK;
