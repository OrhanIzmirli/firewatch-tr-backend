-- 005: is the fire getting stronger or weaker?
--
-- DO NOT RUN THIS IN PRODUCTION FROM A DEVELOPMENT MACHINE.
-- Additive only; the cluster job writes these behind a column check, so a
-- server ahead of its database keeps working.
--
-- WHAT IS STORED
--
--   frp_trend            'intensifying' | 'stable' | 'weakening', or NULL
--   frp_trend_ratio      mean FRP of the later passes / mean of the earlier
--   frp_trend_passes     how many passes the comparison used
--   frp_geometry_ratio   largest / smallest mean pixel area across those
--                        passes — the honesty check, see below
--
-- THE VIEW-ANGLE PROBLEM, AND WHY IT IS NOT WHAT IT LOOKS LIKE
--
-- FRP depends on viewing geometry, so a naive "FRP fell" can be measuring the
-- satellite rather than the fire. Measured on 852 live VIIRS detections, the
-- relationship is:
--
--   log(FRP) = a + 3.384 * pixel_area_km2      (r = 0.343)
--
-- The sign is POSITIVE: a bigger pixel reports MORE power, because FRP is
-- integrated over the pixel and a wider pixel gathers more of the fire. The
-- intuition that off-nadir looks dimmer is backwards.
--
-- The consequence still lands on the dangerous side. Moving TOWARD nadir
-- shrinks the pixel and deflates FRP, which fabricates a "weakening" for a
-- fire that is burning exactly as hard as before. Magnitudes from that fit:
--
--   1.5x pixel-area swing  ->  FRP biased by  +40%
--   2.0x                   ->  +97%
--   2.8x                   ->  +227%
--   3.6x                   ->  +481%
--
-- These swings are not rare. Across incidents with three or more passes, the
-- median pixel-area swing was 1.71x and half exceeded 1.5x.
--
-- NORMALISE OR GATE? GATE.
--
-- The fit could in principle be inverted to correct FRP, but r = 0.343 means
-- it explains about 12% of the variance; the other 88% is real fire-to-fire
-- difference. Applying a correction of +40% to +481% on the strength of that
-- would inject more error than it removes, and the bigger the swing the more
-- the correction's own uncertainty dominates. Gating is exact: when the
-- geometry barely moved, the confound is bounded by construction.
--
-- So a trend is published only when frp_geometry_ratio <= 1.5, and the
-- "stable" band is set to exactly the bias that gate still permits (+/-40%,
-- i.e. ratio 0.60 to 1.67). The band is not a taste judgement — it is the
-- residual error the gate allows, so nothing inside it can be distinguished
-- from geometry.
--
-- In the measured sample this matters: every incident whose late/early ratio
-- fell below 0.92 had moved 2.1x or more, except one that dropped 320 MW to
-- 4.5 MW — a 70x fall that no geometry swing can manufacture.

BEGIN;

ALTER TABLE fire_incidents
  ADD COLUMN IF NOT EXISTS frp_trend TEXT,
  ADD COLUMN IF NOT EXISTS frp_trend_ratio NUMERIC(8,3),
  ADD COLUMN IF NOT EXISTS frp_trend_passes INTEGER,
  ADD COLUMN IF NOT EXISTS frp_geometry_ratio NUMERIC(8,3);

-- Same discipline as satellite_state: the values that must never exist are
-- unrepresentable rather than merely unused. There is no 'extinguished' and
-- no 'being extinguished' here — this axis measures radiated heat, and
-- nothing about whether anyone is fighting the fire.
ALTER TABLE fire_incidents
  DROP CONSTRAINT IF EXISTS fire_incidents_frp_trend_values;
ALTER TABLE fire_incidents
  ADD CONSTRAINT fire_incidents_frp_trend_values
  CHECK (frp_trend IS NULL
         OR frp_trend IN ('intensifying', 'stable', 'weakening'));

-- A trend without the evidence behind it is not publishable, so the row
-- cannot carry one. Three passes is the minimum for a comparison to mean
-- anything, and the geometry gate is enforced here as well as in the job.
ALTER TABLE fire_incidents
  DROP CONSTRAINT IF EXISTS fire_incidents_frp_trend_evidence;
ALTER TABLE fire_incidents
  ADD CONSTRAINT fire_incidents_frp_trend_evidence
  CHECK (frp_trend IS NULL
         OR (frp_trend_passes >= 3
             AND frp_trend_ratio IS NOT NULL
             AND frp_geometry_ratio IS NOT NULL
             AND frp_geometry_ratio <= 1.5));

COMMIT;
