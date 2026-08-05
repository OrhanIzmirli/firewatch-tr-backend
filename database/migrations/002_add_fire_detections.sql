-- Migration 002 — persist raw FIRMS thermal detections
--
-- STRICTLY ADDITIVE. Creates one new table; touches nothing that exists.
-- /api/thermal keeps working exactly as before — ingest runs alongside it,
-- not instead of it.
--
-- ---------------------------------------------------------------------------
-- PRE-FLIGHT — run against the live database and read the output BEFORE
-- applying anything below.
--
--   -- 1. PostGIS must be installed; geom/GIST below fail without it.
--   SELECT extname, extversion FROM pg_extension WHERE extname = 'postgis';
--   -- Expect exactly one row. If empty, STOP: this migration cannot run.
--
--   -- 2. The table must not already exist in some other shape.
--   SELECT to_regclass('public.fire_detections') AS already_exists;
--   -- Expect NULL. If it returns a name, STOP and diff the columns first —
--   -- CREATE TABLE IF NOT EXISTS would silently keep a mismatched table.
--
--   -- 3. turkey_cities is what ingest resolves city_id against.
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'turkey_cities' ORDER BY ordinal_position;
--   -- Expect at least: id (integer), name, region, location (USER-DEFINED).
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS fire_detections (
  id              BIGSERIAL PRIMARY KEY,

  -- Which FIRMS product this row came from. Part of the identity: the same
  -- fire seen by VIIRS and by MODIS is two independent observations, not a
  -- duplicate.
  product         TEXT        NOT NULL,

  -- acq_date + acq_time combined, in UTC. FIRMS emits acq_time as an
  -- unpadded HHMM integer ("3" means 00:03) — see fireIngestJob.
  acquired_at     TIMESTAMPTZ NOT NULL,

  -- Stored as fixed-precision NUMERIC, not float, because these two columns
  -- are part of the UNIQUE key. See the constraint comment below.
  latitude        NUMERIC(9,5) NOT NULL,
  longitude       NUMERIC(9,5) NOT NULL,

  -- Derived from latitude/longitude purely so spatial queries and the GIST
  -- index have something to work with. Never used for identity.
  geom            geometry(Point, 4326) NOT NULL,

  satellite       TEXT,
  instrument      TEXT,

  -- confidence as FIRMS sent it: 'l'/'n'/'h' for VIIRS, '0'-'100' for MODIS.
  confidence_raw  TEXT NOT NULL,
  -- Normalised tier. Thresholds are identical to the Flutter client's
  -- FirePoint.riskTier (>=80 / >=30 numeric, h / n letters), so "high
  -- confidence" means the same thing on both ends. Note the vocabulary
  -- differs by one word: 'nominal' here is the client's 'medium'.
  confidence_tier TEXT NOT NULL,

  -- bright_ti4 (VIIRS) or brightness (MODIS); bright_ti5 or bright_t31.
  brightness_k    NUMERIC(7,2),
  brightness2_k   NUMERIC(7,2),
  frp_mw          NUMERIC(9,2),
  scan_km         NUMERIC(5,2),
  track_km        NUMERIC(5,2),
  daynight        CHAR(1),

  -- Nearest Turkish province and how far away it is. No FOREIGN KEY, for the
  -- same reason as migration 001: an FK would lock turkey_cities and would
  -- fail outright if its primary key is not what we assume. The distance is
  -- stored so a stricter country filter can be applied later WITHOUT
  -- re-ingesting (province centroids are points, so they cannot trace the
  -- actual border — see fireIngestJob for the tolerance actually used).
  city_id         INTEGER,
  nearest_city_km NUMERIC(7,2),

  -- Same seven keys as the Flutter client and src/utils/regions.ts.
  region_key      TEXT,

  -- Filled by the clustering step in migration 003 / step 2. Deliberately
  -- carries NO foreign key yet because fire_incidents does not exist: an FK
  -- to a missing table is impossible, and creating a placeholder table now
  -- would be dead schema nobody writes to. Step 2 adds the constraint with a
  -- single ALTER ... ADD CONSTRAINT ... NOT VALID, which does not rewrite
  -- this table. The column lives here from the start so that step 2 never has
  -- to ALTER what by then is the largest table in the database.
  incident_id     BIGINT,

  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Idempotency key. Deliberately built from (product, acquired_at, lat, lng)
  -- rather than including `geom`:
  --   * latitude/longitude are NUMERIC, so equality is exact and decided by
  --     the stored decimal value — re-ingesting the same CSV always collides.
  --   * a UNIQUE on `geometry` compares the binary representation through
  --     float8 coordinates. Any round-trip difference in how the point is
  --     constructed would produce a value that is "the same place" to a human
  --     but a distinct key to Postgres, silently duplicating rows.
  -- FIRMS emits coordinates as fixed decimal text (5 dp), so NUMERIC(9,5)
  -- stores exactly what arrived with no rounding of our own.
  CONSTRAINT fire_detections_natural_key
    UNIQUE (product, acquired_at, latitude, longitude),

  CONSTRAINT fire_detections_confidence_tier_check
    CHECK (confidence_tier IN ('low', 'nominal', 'high'))
);

CREATE INDEX IF NOT EXISTS idx_fire_detections_geom
  ON fire_detections USING GIST (geom);

-- Every "what is burning now" query is a recency window.
CREATE INDEX IF NOT EXISTS idx_fire_detections_acquired_at
  ON fire_detections (acquired_at DESC);

-- Step 2 walks unclustered rows; partial keeps the index tiny.
CREATE INDEX IF NOT EXISTS idx_fire_detections_unclustered
  ON fire_detections (acquired_at) WHERE incident_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_fire_detections_incident
  ON fire_detections (incident_id) WHERE incident_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fire_detections_region
  ON fire_detections (region_key, acquired_at DESC);

CREATE INDEX IF NOT EXISTS idx_fire_detections_city
  ON fire_detections (city_id, acquired_at DESC);

COMMIT;

-- ---------------------------------------------------------------------------
-- POST-CHECK
--
--   -- Columns landed as expected:
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'fire_detections' ORDER BY ordinal_position;
--
--   -- Indexes and constraints:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'fire_detections';
--   SELECT conname, contype FROM pg_constraint
--   WHERE conrelid = 'fire_detections'::regclass;
--
--   -- After the first ingest run, sanity-check what landed:
--   SELECT product, confidence_tier, count(*),
--          min(acquired_at) AS oldest, max(acquired_at) AS newest
--   FROM fire_detections GROUP BY 1, 2 ORDER BY 1, 2;
--
--   -- Nothing should be outside Turkey's neighbourhood:
--   SELECT max(nearest_city_km) FROM fire_detections;
--
-- ROLLBACK (only if the table is empty and unused):
--   DROP TABLE IF EXISTS fire_detections;
-- ---------------------------------------------------------------------------
