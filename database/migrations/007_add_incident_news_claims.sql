-- Migration 007 — shadow table for news-derived fire status claims
--
-- ADDITIVE. Creates one table. Nothing existing is dropped, retyped or
-- rewritten, and NOTHING here may write to fire_incidents.official_state.
--
-- This is the shadow run the extractor was written for: every news article
-- that survives the scraper's whitelist gets one verdict row recording what
-- officialStatusExtractor read out of it and whether it could be attached to
-- exactly one incident. A human reads the report (GET /api/health/status-claims)
-- for a while before any of this is allowed to touch the official axis.
--
-- ---------------------------------------------------------------------------
-- PRE-FLIGHT — run first and read the output.
--
--   SELECT to_regclass('public.news')                 AS must_exist,
--          to_regclass('public.fire_incidents')       AS must_exist_too,
--          to_regclass('public.incident_news_claims') AS must_be_null;
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS incident_news_claims (
  id                BIGSERIAL PRIMARY KEY,

  -- One verdict per article, ever. Re-running the job must be a no-op for
  -- articles already judged, so the verdict is keyed on the article itself.
  news_id           INTEGER NOT NULL UNIQUE
                    REFERENCES news(id) ON DELETE CASCADE,

  -- Set only when the article could be attached to exactly one incident.
  -- SET NULL rather than CASCADE: if an incident row ever disappears, the
  -- record that a claim was made (and what it said) is still evidence.
  incident_id       BIGINT
                    REFERENCES fire_incidents(id) ON DELETE SET NULL,

  -- What the text claimed, verbatim from the extractor. NULL when the
  -- article was irrelevant or carried no unambiguous claim.
  claim_state       TEXT,
  claim_phrase      TEXT,
  claim_rule        TEXT,
  suppressed_rules  TEXT[] NOT NULL DEFAULT '{}',

  -- Why the relevance gate decided what it decided ('vegetation_fire',
  -- 'structure_or_vehicle_fire', 'foreign_country', ...).
  relevance_reason  TEXT NOT NULL,

  -- The single province the article named, when it named exactly one.
  city_name         TEXT,
  -- How many open incidents were candidates in that province/time window.
  candidate_count   INTEGER NOT NULL DEFAULT 0,

  -- Where the pipeline stopped for this article. Every refusal is its own
  -- value so the report can show WHY matches are not happening.
  outcome           TEXT NOT NULL,

  news_published_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT incident_news_claims_state_check
    CHECK (claim_state IS NULL
           OR claim_state IN ('ongoing', 'contained', 'extinguished')),

  CONSTRAINT incident_news_claims_outcome_check
    CHECK (outcome IN ('irrelevant', 'no_claim', 'no_city',
                       'multiple_cities', 'no_incident',
                       'multiple_incidents', 'matched')),

  -- 'matched' is the only outcome that points at an incident, and it must
  -- always carry the claim that would (one day) be applied.
  CONSTRAINT incident_news_claims_matched_check
    CHECK (outcome <> 'matched'
           OR (incident_id IS NOT NULL AND claim_state IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_incident_news_claims_outcome
  ON incident_news_claims (outcome, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incident_news_claims_incident
  ON incident_news_claims (incident_id) WHERE incident_id IS NOT NULL;

COMMIT;

-- ---------------------------------------------------------------------------
-- POST-CHECK
--
--   SELECT conname, contype FROM pg_constraint
--   WHERE conrelid = 'incident_news_claims'::regclass ORDER BY conname;
--
--   -- This MUST fail (matched without incident/claim):
--   --   INSERT INTO incident_news_claims (news_id, relevance_reason, outcome)
--   --   VALUES (1, 'vegetation_fire', 'matched');
--
-- ROLLBACK (only while the table is unused):
--   DROP TABLE IF EXISTS incident_news_claims;
-- ---------------------------------------------------------------------------
