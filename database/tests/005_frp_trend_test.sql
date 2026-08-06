-- Tests for the FRP trend fold: pass grouping, half-vs-half, and the two
-- gates that stop it lying.
--
-- SAFE TO RUN ANYWHERE. Everything happens in TEMP tables and the whole
-- script rolls back. No row of fire_detections or fire_incidents is read or
-- written.
--
--   psql "$DATABASE_URL" -f database/tests/005_frp_trend_test.sql

\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE d (
  incident_id INT,
  acquired_at TIMESTAMPTZ,
  frp_mw      NUMERIC,
  scan_km     NUMERIC,
  track_km    NUMERIC
) ON COMMIT DROP;

-- ── incident 1: genuinely weakening, geometry steady ───────────────────────
-- Three passes at 40 / 20 / 8 MW. Pixel 0.4x0.4 throughout.
-- early = pass1 = 40, late = pass3 = 8, ratio 0.20 -> weakening.
-- Two rows in pass 1, three minutes apart, to prove they fold into one pass.
INSERT INTO d VALUES
  (1, '2026-08-05T06:00:00Z', 25, 0.4, 0.4),
  (1, '2026-08-05T06:03:00Z', 15, 0.4, 0.4),
  (1, '2026-08-05T18:00:00Z', 20, 0.4, 0.4),
  (1, '2026-08-06T06:00:00Z',  8, 0.4, 0.4);

-- ── incident 2: intensifying, geometry steady ──────────────────────────────
INSERT INTO d VALUES
  (2, '2026-08-05T06:00:00Z',  5, 0.4, 0.4),
  (2, '2026-08-05T18:00:00Z', 20, 0.4, 0.4),
  (2, '2026-08-06T06:00:00Z', 30, 0.4, 0.4);

-- ── incident 3: flat ───────────────────────────────────────────────────────
INSERT INTO d VALUES
  (3, '2026-08-05T06:00:00Z', 20, 0.4, 0.4),
  (3, '2026-08-05T18:00:00Z', 21, 0.4, 0.4),
  (3, '2026-08-06T06:00:00Z', 19, 0.4, 0.4);

-- ── incident 4: THE TRAP ───────────────────────────────────────────────────
-- FRP appears to fall 40 -> 10, but the pixel shrank from 0.72 to 0.16 km2
-- (4.5x). The satellite moved toward nadir; the fire may be unchanged.
-- Must produce NO trend rather than "weakening".
INSERT INTO d VALUES
  (4, '2026-08-05T06:00:00Z', 40, 0.9, 0.8),
  (4, '2026-08-05T18:00:00Z', 25, 0.6, 0.5),
  (4, '2026-08-06T06:00:00Z', 10, 0.4, 0.4);

-- ── incident 5: only two passes ────────────────────────────────────────────
INSERT INTO d VALUES
  (5, '2026-08-05T06:00:00Z', 40, 0.4, 0.4),
  (5, '2026-08-06T06:00:00Z',  4, 0.4, 0.4);

CREATE TEMP TABLE result AS
WITH marked AS (
  SELECT incident_id, acquired_at, frp_mw,
         scan_km * track_km AS pixel_area,
         CASE
           WHEN lag(acquired_at) OVER w IS NULL
             OR acquired_at - lag(acquired_at) OVER w > INTERVAL '10 minutes'
           THEN 1 ELSE 0
         END AS starts_pass
    FROM d
  WINDOW w AS (PARTITION BY incident_id ORDER BY acquired_at)
),
grouped AS (
  SELECT *, sum(starts_pass) OVER (PARTITION BY incident_id
                                   ORDER BY acquired_at) AS pass_idx
    FROM marked
),
passes AS (
  SELECT incident_id, pass_idx,
         sum(frp_mw) AS frp_sum, avg(pixel_area) AS pixel_area
    FROM grouped GROUP BY incident_id, pass_idx
),
ordered AS (
  SELECT incident_id, pass_idx, frp_sum, pixel_area,
         row_number() OVER (PARTITION BY incident_id ORDER BY pass_idx) AS rn,
         count(*)     OVER (PARTITION BY incident_id) AS n
    FROM passes
),
halves AS (
  SELECT incident_id,
         max(n)::int AS pass_count,
         avg(frp_sum) FILTER (WHERE rn <= n / 2)      AS early,
         avg(frp_sum) FILTER (WHERE rn > (n + 1) / 2) AS late,
         max(pixel_area) / NULLIF(min(pixel_area), 0) AS geometry_ratio
    FROM ordered GROUP BY incident_id
),
scored AS (
  SELECT incident_id, pass_count, geometry_ratio,
         late / NULLIF(early, 0) AS ratio
    FROM halves
   WHERE pass_count >= 3 AND early > 0 AND late IS NOT NULL
)
SELECT i AS id,
       s.pass_count,
       round(s.ratio::numeric, 3) AS ratio,
       round(s.geometry_ratio::numeric, 3) AS geometry_ratio,
       CASE
         WHEN s.incident_id IS NULL THEN NULL
         WHEN s.geometry_ratio IS NULL OR s.geometry_ratio > 1.5 THEN NULL
         WHEN s.ratio < 0.6 THEN 'weakening'
         WHEN s.ratio > 1.667 THEN 'intensifying'
         ELSE 'stable'
       END AS trend
  FROM generate_series(1, 5) i
  LEFT JOIN scored s ON s.incident_id = i;

DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM result WHERE id = 1;
  ASSERT r.pass_count = 3,
    format('incident 1: two detections 3 min apart must fold into ONE pass, got %s passes', r.pass_count);
  ASSERT r.trend = 'weakening', format('incident 1 expected weakening, got %s', r.trend);
  RAISE NOTICE 'PASS 1/5  weakening, and the 3-minute pair folded into one pass';

  SELECT * INTO r FROM result WHERE id = 2;
  ASSERT r.trend = 'intensifying', format('incident 2 expected intensifying, got %s', r.trend);
  RAISE NOTICE 'PASS 2/5  intensifying';

  SELECT * INTO r FROM result WHERE id = 3;
  ASSERT r.trend = 'stable', format('incident 3 expected stable, got %s', r.trend);
  RAISE NOTICE 'PASS 3/5  stable';

  SELECT * INTO r FROM result WHERE id = 4;
  ASSERT r.geometry_ratio > 1.5,
    format('incident 4 should have moved geometry, ratio %s', r.geometry_ratio);
  ASSERT r.trend IS NULL,
    format('incident 4: a 4.5x pixel shrink must NOT publish a trend, got %s', r.trend);
  RAISE NOTICE 'PASS 4/5  geometry gate: apparent 40->10 MW fall suppressed (pixel %s x)',
    round(r.geometry_ratio, 2);

  SELECT * INTO r FROM result WHERE id = 5;
  ASSERT r.trend IS NULL,
    format('incident 5: two passes is not a trend, got %s', r.trend);
  RAISE NOTICE 'PASS 5/5  two passes produce no trend';
END $$;

ROLLBACK;
