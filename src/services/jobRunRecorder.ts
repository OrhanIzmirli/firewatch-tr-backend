import pool from '../config/database';

export type JobRunStatus = 'ok' | 'failed' | 'skipped';

/**
 * Records what a background job did, so that "is the pipeline alive" can be
 * answered without guessing from how much data appeared.
 *
 * The clustering transaction once rolled back on every round for three and a
 * half hours. Externally that looked exactly like a quiet FIRMS feed: counts
 * stopped moving, and nothing said whether the job had run at all. Recording
 * the run separates the two questions.
 *
 * EVERY WRITE HERE IS OUTSIDE THE CALLER'S TRANSACTION, on its own pool
 * connection. That is the whole point: a job that rolls back must not roll
 * back the evidence that it failed.
 *
 * Failures to record are swallowed. Observability must never be the reason a
 * working job reports an error — this is a witness, not a participant.
 */
export async function recordJobRun(
  job: string,
  startedAt: Date,
  status: JobRunStatus,
  stats: Record<string, unknown> = {},
  error?: unknown
): Promise<void> {
  const message =
    error === undefined || error === null
      ? null
      : // Message only. This is served over HTTP by the health endpoint, and
        // a stack trace there leaks paths for no diagnostic gain.
        String((error as Error).message ?? error).slice(0, 500);

  try {
    await pool.query(
      `INSERT INTO job_runs (job, started_at, status, stats, error)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [job, startedAt, status, JSON.stringify(stats), message]
    );
  } catch (recordError) {
    const code = (recordError as { code?: string }).code;
    // 42P01 = table missing, i.e. migration 006 is not applied yet. That is a
    // normal state during a staged rollout, not something to shout about on
    // every run.
    if (code !== '42P01') {
      console.error(
        'job_runs insert failed (job continues regardless):',
        (recordError as Error).message
      );
    }
  }
}

/** Keeps the table to a fortnight. Called from the same place as the detection prune. */
export async function pruneJobRuns(): Promise<number> {
  try {
    const result = await pool.query(
      `DELETE FROM job_runs WHERE finished_at < NOW() - INTERVAL '14 days'`
    );
    return result.rowCount ?? 0;
  } catch {
    return 0;
  }
}
