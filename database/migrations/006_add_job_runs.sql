-- 006: make the pipeline's own execution observable.
--
-- DO NOT RUN THIS IN PRODUCTION FROM A DEVELOPMENT MACHINE.
--
-- WHY
--
-- The clustering transaction rolled back on every round for three and a half
-- hours and nothing outside the process could tell. From the API the symptom
-- was that counts stopped moving — which is exactly what a quiet FIRMS feed
-- looks like. The two states were indistinguishable, so the only thing that
-- eventually exposed it was noticing that hours_since_last_detection had
-- drifted 1.25 h from the real age of every incident.
--
-- The lesson is not "add a test". A test only catches the bug you thought of.
-- What was missing is that the LIVENESS OF THE PIPELINE was inferred from the
-- VOLUME OF THE DATA, and those are different questions:
--
--   * "Did the job run and commit?"  -> must be answerable at any time,
--                                       whether or not there was work to do.
--   * "Did it produce anything?"     -> only meaningful once you know there
--                                       was something to produce.
--
-- A round that commits having found nothing new is healthy. Zero output is
-- only a problem when there was input. This table records both halves so the
-- distinction can be made from outside.
--
-- WHY A TABLE AND NOT JUST A LOG LINE
--
-- The job already logged its failure. Two reasons that was not enough. Render
-- free-tier logs are ephemeral and nobody is watching them at 14:00 on a
-- Thursday. And more fundamentally, a log line is not queryable by the health
-- endpoint, so the failure could not surface anywhere a person would look.
--
-- CRITICAL: rows here are written OUTSIDE the job's own transaction. Writing
-- them inside would mean a rollback erased the record of its own failure,
-- which is the precise trap this is meant to close.

BEGIN;

CREATE TABLE IF NOT EXISTS job_runs (
  id           BIGSERIAL PRIMARY KEY,
  job          TEXT        NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL,
  finished_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 'ok'      committed, whatever it found
  -- 'failed'  threw; the work was rolled back
  -- 'skipped' preconditions absent (a migration not applied yet), which is a
  --           normal state during a staged rollout and must not read as a
  --           failure
  status       TEXT        NOT NULL,

  -- Whatever the job counted. Deliberately schemaless: the useful counters
  -- differ per job and change as jobs change, and a JSON column costs nothing
  -- next to a migration per counter.
  stats        JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- Message only, never a stack trace: this is served over HTTP by the
  -- pipeline health endpoint.
  error        TEXT,

  CONSTRAINT job_runs_status_values
    CHECK (status IN ('ok', 'failed', 'skipped'))
);

-- The health endpoint asks "when did this job last succeed" and "what was the
-- most recent failure", both per job, both newest-first.
CREATE INDEX IF NOT EXISTS idx_job_runs_job_finished
  ON job_runs (job, finished_at DESC);

CREATE INDEX IF NOT EXISTS idx_job_runs_job_status_finished
  ON job_runs (job, status, finished_at DESC);

COMMIT;

-- Retention. This table grows by a handful of rows an hour; a fortnight is
-- plenty to investigate an incident and keeps it far inside the free tier.
-- The cluster job prunes it on the same schedule it prunes detections:
--
--   DELETE FROM job_runs WHERE finished_at < NOW() - INTERVAL '14 days';
