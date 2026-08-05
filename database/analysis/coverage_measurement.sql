-- Coverage measurement — READ ONLY. No INSERT, UPDATE, DELETE or DDL.
--
-- Answers one question: after an incident was last detected, did any later
-- satellite pass demonstrably look at its location and not see it?
--
-- FIRMS only reports detections, never "I looked here and saw nothing", so
-- coverage has to be inferred. Three tiers of evidence, strongest first:
--
--   inside_hull  the incident falls INSIDE the convex hull of everything that
--                pass detected. Interpolation, not extrapolation — the sweep
--                provably crossed this location.
--   near_hull    outside the hull but within N km of it. Likely covered,
--                since a VIIRS swath is ~3060 km wide, but not proven.
--   unknown      neither. Say nothing about coverage.
--
-- A pass is a group of acquisition timestamps within 10 minutes of each other:
-- FIRMS stamps each granule separately, so one sweep arrives as several
-- timestamps 1-3 minutes apart and counting them raw doubles the pass count.

WITH distinct_times AS (
  SELECT DISTINCT acquired_at FROM fire_detections
),
marked AS (
  SELECT acquired_at,
         CASE
           WHEN lag(acquired_at) OVER (ORDER BY acquired_at) IS NULL
             OR acquired_at - lag(acquired_at) OVER (ORDER BY acquired_at)
                > INTERVAL '10 minutes'
           THEN 1 ELSE 0
         END AS is_pass_start
  FROM distinct_times
),
pass_of_time AS (
  SELECT acquired_at,
         sum(is_pass_start) OVER (ORDER BY acquired_at) AS pass_id
  FROM marked
),
pass_geom AS (
  SELECT p.pass_id,
         min(d.acquired_at)                     AS pass_start,
         count(*)                               AS pass_detections,
         count(DISTINCT d.product)              AS pass_products,
         string_agg(DISTINCT d.product, '+')    AS products,
         ST_ConvexHull(ST_Collect(d.geom))      AS hull,
         -- A hull needs 3 non-collinear points to be a polygon; below that it
         -- degenerates to a line or a point and can contain nothing.
         GeometryType(ST_ConvexHull(ST_Collect(d.geom))) AS hull_type
  FROM fire_detections d
  JOIN pass_of_time p ON p.acquired_at = d.acquired_at
  GROUP BY p.pass_id
),
-- Every (incident, later pass) pair.
pairs AS (
  SELECT i.id                                   AS incident_id,
         g.pass_id,
         g.products,
         g.hull_type,
         ST_Contains(g.hull, i.centroid)        AS inside_hull,
         ST_Distance(g.hull::geography, i.centroid::geography) / 1000.0
                                                AS dist_km
  FROM fire_incidents i
  JOIN pass_geom g ON g.pass_start > i.last_detected_at
),
per_incident AS (
  SELECT incident_id,
         count(*)                                                   AS passes_after,
         count(*) FILTER (WHERE inside_hull)                        AS inside,
         count(*) FILTER (WHERE NOT inside_hull AND dist_km <=  50) AS near_50,
         count(*) FILTER (WHERE NOT inside_hull AND dist_km <= 100) AS near_100,
         count(*) FILTER (WHERE NOT inside_hull AND dist_km <= 250) AS near_250,
         count(*) FILTER (WHERE NOT inside_hull AND dist_km <= 500) AS near_500,
         min(dist_km) FILTER (WHERE NOT inside_hull)                AS closest_km
  FROM pairs
  GROUP BY incident_id
),
totals AS (SELECT count(*)::numeric AS all_incidents FROM fire_incidents)
SELECT
  (SELECT all_incidents FROM totals)                              AS incidents_total,
  count(*)                                                        AS incidents_with_later_pass,
  round(100 * count(*) / (SELECT all_incidents FROM totals), 1)    AS pct_with_later_pass,
  round(avg(passes_after), 2)                                     AS avg_passes_after,
  count(*) FILTER (WHERE inside   >= 1)                           AS n_inside_hull,
  round(100.0 * count(*) FILTER (WHERE inside   >= 1) / count(*), 1) AS pct_inside_hull,
  count(*) FILTER (WHERE inside = 0 AND near_50  >= 1)            AS n_near_50,
  round(100.0 * count(*) FILTER (WHERE inside = 0 AND near_50  >= 1) / count(*), 1) AS pct_near_50,
  count(*) FILTER (WHERE inside = 0 AND near_100 >= 1)            AS n_near_100,
  round(100.0 * count(*) FILTER (WHERE inside = 0 AND near_100 >= 1) / count(*), 1) AS pct_near_100,
  count(*) FILTER (WHERE inside = 0 AND near_250 >= 1)            AS n_near_250,
  round(100.0 * count(*) FILTER (WHERE inside = 0 AND near_250 >= 1) / count(*), 1) AS pct_near_250,
  count(*) FILTER (WHERE inside = 0 AND near_500 >= 1)            AS n_near_500,
  round(100.0 * count(*) FILTER (WHERE inside = 0 AND near_500 >= 1) / count(*), 1) AS pct_near_500,
  count(*) FILTER (WHERE inside = 0 AND near_500 = 0)             AS n_unknown,
  round(100.0 * count(*) FILTER (WHERE inside = 0 AND near_500 = 0) / count(*), 1) AS pct_unknown,
  round(avg(closest_km) FILTER (WHERE inside = 0)::numeric, 1)    AS avg_closest_km_when_outside
FROM per_incident;
