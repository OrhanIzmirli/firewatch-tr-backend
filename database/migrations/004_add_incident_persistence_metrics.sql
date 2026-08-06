-- 004: metrics that can tell a fire from a fixed heat source.
--
-- DO NOT RUN THIS IN PRODUCTION FROM A DEVELOPMENT MACHINE.
-- Additive only: every column is nullable or defaulted, so an older server
-- keeps working against a migrated database and a newer server keeps working
-- against an un-migrated one (the cluster job writes these behind a column
-- check).
--
-- WHY
--
-- 38 of 262 live incidents are long-lived, weak and visible on nearly every
-- overpass; one of them reached the home screen as the country's
-- longest-running fire at a flat 4.35 MW in urban Istanbul. Neither of the
-- two signals available today can separate them:
--
--   * Duration is censored by the two-day ingest window. The longest event in
--     the entire feed is 34.5 h and the values pile up at 24.0 h and 24.8 h,
--     so a flare burning for a month and a wildfire burning for three days
--     report the same number. Any duration threshold is unfounded and would
--     break silently the day INGEST_DAYS changes.
--
--   * Overpass density does not separate the populations: 0.083-0.422 per
--     hour for suspects against 0.134-0.238 for credible long-lived fires.
--
-- The two that should work cannot be computed from what is stored today.
-- This migration adds them.
--
--   distinct_days_seen  beats the duration ceiling outright. Something seen
--                       on thirty separate days is infrastructure, whatever
--                       the ingest window says about "duration".
--
--   frp_mean/frp_stddev a fire fluctuates as fuel and wind change; a burner
--                       does not. Sampled by hand on the five incidents that
--                       could be matched to enough raw detections, the
--                       coefficient of variation was 0.31 and 0.52 for
--                       constant sources against 1.07 for a real fire. That
--                       is a direction, not a threshold — five samples cannot
--                       set one. These columns exist so the threshold can be
--                       measured rather than guessed, some weeks from now.
--
-- NOTHING READS THESE YET, and no rule uses them. They accumulate first.

BEGIN;

ALTER TABLE fire_incidents
  -- Every UTC date this incident was detected on, folded across merges the
  -- same way overpass_times is. Storing the days rather than a counter is
  -- what makes the fold idempotent: re-processing a detection cannot inflate
  -- it, because a set union of the same date changes nothing.
  ADD COLUMN IF NOT EXISTS seen_days DATE[] NOT NULL DEFAULT '{}',

  -- Cardinality of seen_days, denormalised for cheap reads, exactly as
  -- overpass_count is for overpass_times.
  ADD COLUMN IF NOT EXISTS distinct_days_seen INTEGER NOT NULL DEFAULT 0,

  -- Running accumulators, not the statistics themselves. A mean cannot be
  -- merged with another mean without its weight, and this job folds new
  -- clusters into existing incidents rather than recomputing from
  -- fire_detections — which is precisely what keeps the 90-day detection
  -- prune safe. Sums fold by addition; means do not.
  ADD COLUMN IF NOT EXISTS frp_sum NUMERIC(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS frp_sum_sq NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS frp_sample_count INTEGER NOT NULL DEFAULT 0;

-- Derived, so they can never drift from the accumulators they come from.
-- Population standard deviation (the incident is the whole population of its
-- own detections, not a sample of some larger one). GREATEST guards the
-- floating-point case where E[x^2] - E[x]^2 lands a hair below zero on a
-- constant series, which is exactly the series a burner produces.
ALTER TABLE fire_incidents
  ADD COLUMN IF NOT EXISTS frp_mean NUMERIC
    GENERATED ALWAYS AS (
      CASE WHEN frp_sample_count > 0
           THEN frp_sum / frp_sample_count
           ELSE NULL END
    ) STORED,
  ADD COLUMN IF NOT EXISTS frp_stddev NUMERIC
    GENERATED ALWAYS AS (
      CASE WHEN frp_sample_count > 0
           THEN sqrt(GREATEST(
                  (frp_sum_sq / frp_sample_count)
                    - (frp_sum / frp_sample_count) ^ 2,
                  0))
           ELSE NULL END
    ) STORED;

-- Consistency the application cannot violate by accident.
ALTER TABLE fire_incidents
  DROP CONSTRAINT IF EXISTS fire_incidents_days_match_counter;
ALTER TABLE fire_incidents
  ADD CONSTRAINT fire_incidents_days_match_counter
  CHECK (distinct_days_seen = COALESCE(array_length(seen_days, 1), 0));

-- Only useful once there are weeks of history; cheap to add now.
CREATE INDEX IF NOT EXISTS idx_fire_incidents_persistence
  ON fire_incidents (distinct_days_seen DESC)
  WHERE distinct_days_seen >= 3;

COMMIT;

-- Backfill for incidents that predate this migration lives in a file of its
-- own: 004b_backfill_persistence_metrics.sql.
--
-- It used to be a commented-out block here, which is how it came to be
-- skipped: "apply the migration" means "run the file", the DDL succeeded, and
-- the backfill sat inert inside `--` comments. 285 of 289 incidents kept
-- distinct_days_seen = 0, which silently disabled the fixed-source exclusion
-- downstream. Run 004b after this one.
