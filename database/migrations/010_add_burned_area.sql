-- Migration 010 — satellite-mapped burned area (NASA MCD64A1) per district
--
-- ADDITIVE. Creates four tables. Nothing existing is dropped, retyped or
-- rewritten. The only existing columns this feature ever writes are the
-- fire_incidents.optical_* columns that migration 003 created for exactly
-- this purpose ("AXIS 2 — optical burnt-area confirmation").
--
-- What this is: NASA's MCD64A1 (MODIS, 500 m) monthly burned-area product,
-- fetched for the whole country once per month through AppEEARS, reduced to
-- the burned pixels, and summed per district. It answers "how many hectares
-- did the satellite map as burned in district X in month M".
--
-- What this is NOT:
--   * not forest loss — MCD64A1 does not know land cover; stubble burning in
--     Çukurova is a burned pixel like any other. The client says so.
--   * not complete — 500 m pixels miss small fires. Every number is a floor.
--   * not restoration — there is NO restoration table here, on purpose. No
--     source for restoration exists; the API returns a fixed "no data,
--     tracking" object and nothing in this schema can hold an estimate.
--
-- Latency, measured from the CMR catalogue for the six tiles that cover
-- Türkiye (h19–h21 / v04–v05): a month is published 38–50 days after it
-- ends (Mar 2026 → 20 May, Apr → 10 Jun, May → 8 Jul, Jun → 11 Aug,
-- Jul → 11 Sep). The job therefore polls daily and never assumes a date.
--
-- ---------------------------------------------------------------------------
-- PRE-FLIGHT
--
--   SELECT extname FROM pg_extension WHERE extname = 'postgis';  -- one row
--   SELECT to_regclass('public.turkey_districts')          AS must_exist,
--          to_regclass('public.fire_incidents')            AS must_exist_too,
--          to_regclass('public.country_borders')           AS must_exist_three,
--          to_regclass('public.turkey_district_boundaries') AS must_be_null,
--          to_regclass('public.burned_area_fetches')        AS must_be_null_too;
-- ---------------------------------------------------------------------------

BEGIN;

-- 1. District polygons. turkey_districts (008) holds centroids only; a pixel
--    needs a boundary to fall inside. Loaded by `npm run seed:district-boundaries`
--    from geoBoundaries TUR ADM2 (OpenStreetMap-derived, ODbL), matched to our
--    districts by name within province; the seed refuses ambiguous matches.
CREATE TABLE IF NOT EXISTS turkey_district_boundaries (
  district_id  INTEGER PRIMARY KEY REFERENCES turkey_districts(id) ON DELETE CASCADE,
  geom         geometry(MultiPolygon, 4326) NOT NULL,
  source       TEXT NOT NULL,
  -- The polygon's own name and id in the source, so a wrong match can be
  -- found by eye ("Yenişehir" polygon attached to our "Sur" would show here).
  source_name  TEXT NOT NULL,
  source_id    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_turkey_district_boundaries_geom
  ON turkey_district_boundaries USING GIST (geom);

-- 2. One row per (product, month): the state machine of the fetch. AppEEARS
--    is asynchronous (submit, poll, download), and a month is not fetchable
--    until NASA has published all six tiles, so the job needs to remember
--    where each month stands between daily ticks.
CREATE TABLE IF NOT EXISTS burned_area_fetches (
  id                  BIGSERIAL PRIMARY KEY,
  product             TEXT NOT NULL,                 -- 'MCD64A1.061'
  year_month          DATE NOT NULL,                 -- first day of the month
  status              TEXT NOT NULL DEFAULT 'awaiting_granules',
  -- Several months may ride in one AppEEARS task (the backfill does); the
  -- task id is therefore not unique here.
  appeears_task_id    TEXT,
  granule_count       INTEGER,                       -- tiles CMR reported
  attempts            INTEGER NOT NULL DEFAULT 0,
  submitted_at        TIMESTAMPTZ,
  downloaded_at       TIMESTAMPTZ,
  pixel_count         INTEGER,                       -- all pixels in the raster
  burned_pixel_count  INTEGER,                       -- Burn_Date between 1 and 366
  unattributed_count  INTEGER,                       -- burned but in no district polygon
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT burned_area_fetches_month_key UNIQUE (product, year_month),
  CONSTRAINT burned_area_fetches_first_of_month_check
    CHECK (year_month = date_trunc('month', year_month)::date),
  CONSTRAINT burned_area_fetches_status_check
    CHECK (status IN ('awaiting_granules', 'submitted', 'downloaded', 'failed')),
  -- A downloaded month always says when and how much.
  CONSTRAINT burned_area_fetches_downloaded_check
    CHECK (status <> 'downloaded'
           OR (downloaded_at IS NOT NULL AND burned_pixel_count IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_burned_area_fetches_status
  ON burned_area_fetches (product, status);

-- 3. The burned pixels themselves, as points at the pixel centre. Kept so
--    the district sums can be recomputed after a boundary fix, an incident
--    can be re-matched with a different radius, and a suspicious number can
--    be traced to the exact pixels behind it. A bad month for Türkiye is a
--    few thousand rows (2021: ~200 000 ha ≈ 9 500 pixels), not millions.
CREATE TABLE IF NOT EXISTS burned_pixels (
  product      TEXT NOT NULL,
  year_month   DATE NOT NULL,
  -- Row/column in the country raster AppEEARS returned. Stable across
  -- re-fetches of the same month because the request polygon is fixed.
  raster_row   INTEGER NOT NULL,
  raster_col   INTEGER NOT NULL,
  burn_date    DATE NOT NULL,
  qa           SMALLINT,
  location     geometry(Point, 4326) NOT NULL,
  -- Resolved after insert by ST_Contains against the boundaries; NULL means
  -- the pixel fell in no polygon (sea edge, border, unmapped district).
  district_id  INTEGER,
  -- Nearest fire_incidents row whose footprint is within the match radius
  -- and whose detection window contains burn_date. SET NULL, not CASCADE:
  -- the pixel is evidence whether or not the incident row survives.
  incident_id  BIGINT REFERENCES fire_incidents(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (product, year_month, raster_row, raster_col)
);

CREATE INDEX IF NOT EXISTS idx_burned_pixels_location
  ON burned_pixels USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_burned_pixels_district_month
  ON burned_pixels (district_id, year_month);
CREATE INDEX IF NOT EXISTS idx_burned_pixels_incident
  ON burned_pixels (incident_id) WHERE incident_id IS NOT NULL;

-- 4. The read model: hectares per district per month. Derived entirely from
--    burned_pixels (hectares = pixel_count × 21.4658, the fixed area of a
--    500 m MODIS sinusoidal pixel), rebuilt whenever a month is (re)ingested.
CREATE TABLE IF NOT EXISTS burned_area_monthly (
  district_id  INTEGER NOT NULL REFERENCES turkey_districts(id) ON DELETE CASCADE,
  year_month   DATE NOT NULL,
  product      TEXT NOT NULL,
  hectares     NUMERIC(12,2) NOT NULL,
  pixel_count  INTEGER NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL,
  source       TEXT NOT NULL,

  PRIMARY KEY (district_id, year_month, product),
  CONSTRAINT burned_area_monthly_positive_check
    CHECK (pixel_count > 0 AND hectares > 0)
);

CREATE INDEX IF NOT EXISTS idx_burned_area_monthly_month
  ON burned_area_monthly (product, year_month DESC);

COMMIT;

-- ---------------------------------------------------------------------------
-- POST-CHECK
--
--   SELECT conname, contype FROM pg_constraint
--   WHERE conrelid = 'burned_area_fetches'::regclass ORDER BY conname;
--
--   -- These MUST fail:
--   --   INSERT INTO burned_area_fetches (product, year_month, status)
--   --   VALUES ('MCD64A1.061', '2026-07-15', 'awaiting_granules');   -- not first of month
--   --   INSERT INTO burned_area_fetches (product, year_month, status)
--   --   VALUES ('MCD64A1.061', '2026-07-01', 'downloaded');          -- no timestamp/count
--
-- Then:  npm run seed:district-boundaries
--        SELECT count(*) FROM turkey_district_boundaries;   -- expect ~972
--
-- ROLLBACK (only while unused):
--   DROP TABLE IF EXISTS burned_area_monthly;
--   DROP TABLE IF EXISTS burned_pixels;
--   DROP TABLE IF EXISTS burned_area_fetches;
--   DROP TABLE IF EXISTS turkey_district_boundaries;
-- ---------------------------------------------------------------------------
