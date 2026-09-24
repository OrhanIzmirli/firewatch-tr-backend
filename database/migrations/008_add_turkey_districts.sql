-- Migration 008 — district gazetteer (ilçe → coordinate)
--
-- ADDITIVE. Creates one empty table. Rows are loaded separately by
-- `npm run seed:districts` from database/seed/turkey_districts.json
-- (caglarsarikaya/turkey-geolocations, community-maintained OSM-derived
-- centroids), so the SQL stays reviewable and the data stays a data file.
--
-- Why a second gazetteer next to turkey_cities: an article names the place
-- it is reporting FROM at district level ("Kaş'ta", "Edremit'te"), and a
-- province is ~9,700 km² while a district is ~750 km². Backtested over
-- 89 in-window articles, district centroids put the satellite match at a
-- median 6.3 km / p90 13.3 km; province centroids were routinely 50–100 km
-- off and matched the wrong fire.
--
-- ---------------------------------------------------------------------------
-- PRE-FLIGHT
--
--   SELECT extname FROM pg_extension WHERE extname = 'postgis';  -- one row
--   SELECT to_regclass('public.turkey_cities')    AS must_exist,
--          to_regclass('public.turkey_districts') AS must_be_null;
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS turkey_districts (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  -- References turkey_cities(id). Deliberately NOT a FOREIGN KEY, for the
  -- same reason migration 001 gave: turkey_cities predates the migrations
  -- and its primary key is not something this file should take a lock on
  -- or assume. The seed script refuses to load a district whose province
  -- it cannot resolve, which is where integrity is enforced.
  province_id   INTEGER NOT NULL,
  -- Denormalised so a row is readable without a join and so the seed can
  -- be re-run and diffed by eye.
  province_name TEXT NOT NULL,
  location      geometry(Point, 4326) NOT NULL,
  source        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT turkey_districts_province_name_key UNIQUE (province_id, name)
);

CREATE INDEX IF NOT EXISTS idx_turkey_districts_location
  ON turkey_districts USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_turkey_districts_province
  ON turkey_districts (province_id);

COMMIT;

-- ---------------------------------------------------------------------------
-- POST-CHECK (after `npm run seed:districts`)
--
--   SELECT count(*) FROM turkey_districts;            -- expect ~970
--   SELECT count(DISTINCT province_id) FROM turkey_districts;  -- expect 81
--   SELECT name, province_name FROM turkey_districts
--    WHERE NOT ST_Within(location, (SELECT geom_gate FROM country_borders WHERE iso_a3 = 'TUR'));
--   -- expect zero rows: every district centroid sits inside the country gate
--
-- ROLLBACK (only while unused):
--   DROP TABLE IF EXISTS turkey_districts;
-- ---------------------------------------------------------------------------
