import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { rateLimit } from '../middleware/security';

const router = Router();

/**
 * How often each job is expected to commit, and how late it may be before
 * something is wrong. Ingest and clustering both run on a 30-minute cron and
 * clustering runs inside the ingest tick, so a job that has not committed for
 * more than two intervals is not merely quiet — it is stuck.
 */
const EXPECTED: Record<
  string,
  { intervalMinutes: number; job: string; skippedIsAlive?: boolean }
> = {
  ingest: { intervalMinutes: 30, job: 'ingest' },
  cluster: { intervalMinutes: 30, job: 'cluster' },
  // Shadow-mode news verification runs 30 minutes after each 6-hour scrape.
  // Until migration 007 is applied it deliberately records 'skipped' every
  // run; that is the job proving it is alive, not failing, and must not put
  // the whole endpoint into 503.
  news_verify: { intervalMinutes: 360, job: 'news_verify', skippedIsAlive: true },
  // News-reported sightings run 45 minutes after each scrape. Records
  // 'skipped' until migrations 008/009 are applied and districts seeded.
  news_sighting: { intervalMinutes: 360, job: 'news_sighting', skippedIsAlive: true },
};

const STALE_AFTER_INTERVALS = 2;

/**
 * GET /api/health/pipeline — is the data pipeline alive?
 *
 * This exists because of a specific failure. The clustering transaction rolled
 * back on every round for three and a half hours, and from outside that was
 * indistinguishable from a quiet FIRMS feed: in both cases the incident count
 * simply stops moving. /api/health said OK the whole time, because the web
 * process was fine — it was the pipeline that was dead.
 *
 * The fix is to stop inferring liveness from data volume. Two questions,
 * answered separately:
 *
 *   healthy   did the job run and COMMIT recently? True even when it found
 *             nothing, because finding nothing is a valid outcome.
 *   anomaly   did it have input and produce no output? That is the only
 *             shape of "zero" that is worth an alarm.
 *
 * A quiet feed reads healthy=true, anomaly=false. The bug that prompted this
 * would have read healthy=false within an hour of starting.
 */
router.get(
  '/pipeline',
  rateLimit('pipeline_health', 60, 60_000),
  async (_req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT j.job,
                (SELECT finished_at FROM job_runs r
                  WHERE r.job = j.job AND r.status = 'ok'
                  ORDER BY finished_at DESC LIMIT 1)  AS last_success_at,
                (SELECT stats FROM job_runs r
                  WHERE r.job = j.job AND r.status = 'ok'
                  ORDER BY finished_at DESC LIMIT 1)  AS last_success_stats,
                (SELECT finished_at FROM job_runs r
                  WHERE r.job = j.job AND r.status = 'skipped'
                  ORDER BY finished_at DESC LIMIT 1)  AS last_skipped_at,
                (SELECT finished_at FROM job_runs r
                  WHERE r.job = j.job AND r.status = 'failed'
                  ORDER BY finished_at DESC LIMIT 1)  AS last_failure_at,
                (SELECT error FROM job_runs r
                  WHERE r.job = j.job AND r.status = 'failed'
                  ORDER BY finished_at DESC LIMIT 1)  AS last_error,
                (SELECT count(*)::int FROM job_runs r
                  WHERE r.job = j.job
                    AND r.status = 'failed'
                    AND r.finished_at > NOW() - INTERVAL '6 hours')
                                                      AS failures_6h
           FROM (SELECT DISTINCT job FROM job_runs) j`
      );

      const now = Date.now();
      const jobs = Object.values(EXPECTED).map((expected) => {
        const row = result.rows.find((r: any) => r.job === expected.job);
        const aliveTimes = [row?.last_success_at];
        if (expected.skippedIsAlive) aliveTimes.push(row?.last_skipped_at);
        const lastSuccess = aliveTimes
          .filter(Boolean)
          .map((t) => new Date(t))
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
        const secondsSince = lastSuccess
          ? Math.round((now - lastSuccess.getTime()) / 1000)
          : null;
        const staleAfter = expected.intervalMinutes * 60 * STALE_AFTER_INTERVALS;

        // No record at all is "unknown", not "healthy": a job that has never
        // reported is exactly the case this endpoint exists to catch.
        const healthy = secondsSince === null ? false : secondsSince <= staleAfter;

        const stats = (row?.last_success_stats ?? {}) as Record<string, number>;

        // The only "zero" worth alarming on: work arrived and nothing came of
        // it. A round that commits with no unclustered detections is a quiet
        // feed, which is normal and must not page anyone.
        const consideredInput = Number(stats.unclusteredConsidered ?? 0);
        const producedOutput =
          Number(stats.incidentsCreated ?? 0) +
          Number(stats.incidentsExtended ?? 0);
        const anomaly =
          expected.job === 'cluster' && consideredInput > 0 && producedOutput === 0;

        return {
          job: expected.job,
          healthy,
          anomaly,
          last_success_at: row?.last_success_at ?? null,
          seconds_since_success: secondsSince,
          stale_after_seconds: staleAfter,
          last_failure_at: row?.last_failure_at ?? null,
          last_error: row?.last_error ?? null,
          failures_last_6h: Number(row?.failures_6h ?? 0),
          last_success_stats: stats,
        };
      });

      const ok = jobs.every((j) => j.healthy && !j.anomaly);

      // 503 so that an uptime check pointed here fails loudly, rather than
      // returning 200 with a sad message nobody parses.
      res.status(ok ? 200 : 503);
      res.set('Cache-Control', 'no-store');
      res.json({ status: ok ? 'ok' : 'degraded', jobs });
    } catch (error) {
      if ((error as { code?: string }).code === '42P01') {
        // Migration 006 not applied yet. Say so plainly instead of implying
        // the pipeline is broken.
        res.status(200).json({
          status: 'unknown',
          message:
            'job_runs table missing — apply ' +
            'database/migrations/006_add_job_runs.sql',
          jobs: [],
        });
        return;
      }
      console.error('pipeline health error:', error);
      res
        .status(500)
        .json({ status: 'error', message: 'Unable to read pipeline health' });
    }
  }
);

/**
 * GET /api/health/status-claims — the shadow run's review report.
 *
 * This page is how a human decides whether the news→incident matching can
 * ever be trusted with the official axis. It answers three questions:
 *
 *   1. Where does the pipeline stop? (outcome counts — if everything dies at
 *      'no_city' the extractor is fine and the matcher is starved)
 *   2. What is it claiming? (state counts over matched rows)
 *   3. Are the individual matches right? (the newest matched rows, with the
 *      exact phrase that decided each, to be read against the article)
 *
 * Nothing here writes anything; official_state promotion stays manual until
 * this report has been boring for a while.
 */
router.get(
  '/status-claims',
  rateLimit('status_claims', 30, 60_000),
  async (_req: Request, res: Response) => {
    try {
      const [outcomes, states, recent] = await Promise.all([
        pool.query(
          `SELECT outcome, count(*)::int AS count
             FROM incident_news_claims
            WHERE created_at > NOW() - INTERVAL '7 days'
            GROUP BY outcome ORDER BY count DESC`
        ),
        pool.query(
          `SELECT claim_state, count(*)::int AS count
             FROM incident_news_claims
            WHERE outcome = 'matched'
              AND created_at > NOW() - INTERVAL '7 days'
            GROUP BY claim_state ORDER BY count DESC`
        ),
        pool.query(
          `SELECT c.id, c.news_id, c.incident_id, c.claim_state, c.claim_phrase,
                  c.claim_rule, c.suppressed_rules, c.city_name,
                  c.news_published_at, c.created_at,
                  n.title, n.source, n.source_url
             FROM incident_news_claims c
             JOIN news n ON n.id = c.news_id
            WHERE c.outcome = 'matched'
            ORDER BY c.created_at DESC
            LIMIT 50`
        ),
      ]);

      res.set('Cache-Control', 'no-store');
      res.json({
        mode: 'shadow',
        note: 'These claims are recorded for review only; official_state is never written by this pipeline.',
        outcomes_7d: outcomes.rows,
        matched_states_7d: states.rows,
        recent_matches: recent.rows,
      });
    } catch (error) {
      if ((error as { code?: string }).code === '42P01') {
        res.status(200).json({
          mode: 'shadow',
          message:
            'incident_news_claims table missing — apply ' +
            'database/migrations/007_add_incident_news_claims.sql',
        });
        return;
      }
      console.error('status-claims report error:', error);
      res
        .status(500)
        .json({ status: 'error', message: 'Unable to read status claims' });
    }
  }
);

export default router;
