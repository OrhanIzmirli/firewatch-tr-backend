-- Migration 009 — news-reported fire sightings awaiting satellite confirmation
--
-- ADDITIVE. Creates one table. NOTHING here writes fire_incidents, and a
-- sighting is never a fire_incidents row: it is a claim that a fire EXISTS
-- somewhere, made by a newspaper, waiting for the satellite to agree.
--
-- How this differs from incident_news_claims (007): that table judges what
-- an article says about the STATUS of a fire the satellite already found,
-- and its verdicts are immutable by design. This table holds articles about
-- fires the satellite has NOT found (yet) and therefore needs a lifecycle:
--
--   news_reported        created; shown to the user as "reported, awaiting
--                        satellite confirmation"
--   satellite_confirmed  a NEW fire_incidents row started within the match
--                        radius during the sighting's life
--   unconfirmed_expired  the window closed with no such detection
--
-- SAFETY. The status set is CHECK-constrained, so no code path can invent a
-- fourth state; 'satellite_confirmed' cannot be written without the incident
-- it points at and a timestamp (same provenance rule as official_state);
-- and nothing in this table can ever say a fire is out — expiry means the
-- satellite did not confirm the report, which is a statement about evidence,
-- not about the fire.
--
-- ---------------------------------------------------------------------------
-- PRE-FLIGHT
--
--   SELECT to_regclass('public.fire_incidents')          AS must_exist,
--          to_regclass('public.turkey_districts')        AS must_exist_too,
--          to_regclass('public.news_reported_sightings') AS must_be_null;
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS news_reported_sightings (
  id                     BIGSERIAL PRIMARY KEY,

  -- Where the article says the fire is. Only district-level geocodes create
  -- a sighting; a province centroid is too coarse to confirm against
  -- (backtest: it matched unrelated single-pixel detections).
  district_id            INTEGER NOT NULL,
  district_name          TEXT NOT NULL,
  province_id            INTEGER,
  region_key             TEXT,
  location               geometry(Point, 4326) NOT NULL,

  -- Every article folded into this sighting, first one first. A second
  -- source naming the same district inside the window corroborates rather
  -- than duplicates. The count is denormalised for the read path.
  corroborating_news_ids INTEGER[] NOT NULL,
  corroborating_count    INTEGER NOT NULL,

  status                 TEXT NOT NULL DEFAULT 'news_reported',
  confirmed_incident_id  BIGINT REFERENCES fire_incidents(id) ON DELETE SET NULL,
  confirmed_at           TIMESTAMPTZ,
  -- Distance from the district centroid to the confirming incident, kept so
  -- the 15 km radius can be re-tuned from real confirmations rather than
  -- from the backtest alone.
  confirmed_distance_m   NUMERIC(10,1),

  first_reported_at      TIMESTAMPTZ NOT NULL,
  last_reported_at       TIMESTAMPTZ NOT NULL,
  expires_at             TIMESTAMPTZ NOT NULL,
  resolved_at            TIMESTAMPTZ,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT news_reported_sightings_status_check
    CHECK (status IN ('news_reported', 'satellite_confirmed', 'unconfirmed_expired')),

  -- Confirmation without provenance is unrepresentable.
  CONSTRAINT news_reported_sightings_confirmed_provenance_check
    CHECK (status <> 'satellite_confirmed'
           OR (confirmed_incident_id IS NOT NULL AND confirmed_at IS NOT NULL)),

  -- A resolved row must say when; an open row must not.
  CONSTRAINT news_reported_sightings_resolved_check
    CHECK ((status = 'news_reported') = (resolved_at IS NULL)),

  CONSTRAINT news_reported_sightings_corroboration_check
    CHECK (corroborating_count >= 1
           AND corroborating_count = cardinality(corroborating_news_ids)),

  CONSTRAINT news_reported_sightings_window_check
    CHECK (expires_at > first_reported_at AND last_reported_at >= first_reported_at)
);

-- The job's two hot paths: "is there an open sighting for this district"
-- and "which open sightings need checking".
CREATE INDEX IF NOT EXISTS idx_news_reported_sightings_open
  ON news_reported_sightings (district_id, first_reported_at DESC)
  WHERE status = 'news_reported';
CREATE INDEX IF NOT EXISTS idx_news_reported_sightings_location
  ON news_reported_sightings USING GIST (location);
-- Anti-join for "has this article already been folded into a sighting".
CREATE INDEX IF NOT EXISTS idx_news_reported_sightings_news_ids
  ON news_reported_sightings USING GIN (corroborating_news_ids);
CREATE INDEX IF NOT EXISTS idx_news_reported_sightings_region
  ON news_reported_sightings (region_key, first_reported_at DESC)
  WHERE status = 'news_reported';

COMMIT;

-- ---------------------------------------------------------------------------
-- POST-CHECK
--
--   SELECT conname, contype FROM pg_constraint
--   WHERE conrelid = 'news_reported_sightings'::regclass ORDER BY conname;
--
--   -- These MUST fail:
--   --   UPDATE news_reported_sightings SET status = 'satellite_confirmed';  -- no incident
--   --   UPDATE news_reported_sightings SET status = 'extinguished';         -- not a state
--
-- ROLLBACK (only while unused):
--   DROP TABLE IF EXISTS news_reported_sightings;
-- ---------------------------------------------------------------------------
