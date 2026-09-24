import cron from 'node-cron';
import pool from '../config/database';
import { recordJobRun } from '../services/jobRunRecorder';
import {
  assessRelevance,
  extractStatusClaim,
  mentionedCities,
} from '../services/officialStatusExtractor';

/**
 * SHADOW-MODE news→incident verification.
 *
 * Reads every article the scraper stored, runs the official-status extractor
 * over it, tries to attach the claim to exactly one fire incident, and writes
 * the whole verdict — including every refusal and its reason — into
 * incident_news_claims. That table is the shadow run: a human reads the
 * report at GET /api/health/status-claims until the matching is trusted.
 *
 * THIS JOB NEVER WRITES fire_incidents.official_state. Promotion of a claim
 * to the official axis is a separate, deliberate, later step — the schema's
 * provenance constraint and the safety rule ("nothing may call a fire out
 * without an official source") stay intact until then.
 *
 * REFUSE-OVER-GUESS runs through the matching exactly as it runs through the
 * extractor. An article naming two provinces is probably a roundup of several
 * fires; a province with two open incidents is ambiguous. Both are recorded
 * and skipped, never resolved by picking the nearest or newest.
 */

/** An incident is a candidate if it was seen this recently before the article. */
const LOOKBACK_DAYS = 7;
/**
 * ... and had already started by this long after publication. A thermal
 * anomaly normally precedes or coincides with the wire story; a fire that
 * first shows up on satellite a day AFTER the article is a different fire.
 */
const LOOKAHEAD_HOURS = 24;
/** Articles older than this are never (re)judged — matching against long-gone
 *  incidents produces noise, not evidence. */
const NEWS_WINDOW_DAYS = 3;

interface PendingNews {
  id: number;
  title: string;
  summary: string | null;
  published_at: Date | null;
  created_at: Date;
}

class NewsVerificationJob {
  start() {
    console.log('📋 News Verification Job (shadow mode) starting...');
    // Half an hour after each scraper tick, so the fresh articles are in.
    cron.schedule('30 */6 * * *', async () => {
      await this.runVerification();
    });
    this.runVerification();
  }

  async runVerification() {
    const startedAt = new Date();
    const stats: Record<string, number> = {
      considered: 0,
      irrelevant: 0,
      no_claim: 0,
      no_city: 0,
      multiple_cities: 0,
      no_incident: 0,
      multiple_incidents: 0,
      matched: 0,
      deferred: 0,
      errors: 0,
    };

    try {
      const cities = await this.loadCities();
      if (cities.size === 0) {
        // Without the province table nothing can be matched; recording a
        // skip is more honest than 0-stat success.
        await recordJobRun('news_verify', startedAt, 'skipped', {
          reason: 'turkey_cities empty or missing',
        });
        return;
      }

      const pending = await pool.query(
        `SELECT n.id, n.title, n.summary, n.published_at, n.created_at
           FROM news n
           LEFT JOIN incident_news_claims c ON c.news_id = n.id
          WHERE c.id IS NULL
            AND n.created_at > NOW() - make_interval(days => $1)
          ORDER BY n.id`,
        [NEWS_WINDOW_DAYS]
      );

      for (const article of pending.rows as PendingNews[]) {
        stats.considered++;
        // One bad article (e.g. pruned between the SELECT and the INSERT)
        // must not leave every article after it unjudged for six hours.
        try {
          const outcome = await this.judgeArticle(article, cities);
          stats[outcome] = (stats[outcome] ?? 0) + 1;
        } catch (error) {
          if ((error as { code?: string }).code === '42P01') throw error;
          stats.errors = (stats.errors ?? 0) + 1;
          console.error(
            `News verification: article ${article.id} failed:`,
            (error as Error).message
          );
        }
      }

      const allFailed = stats.considered > 0 && stats.errors === stats.considered;
      await recordJobRun(
        'news_verify',
        startedAt,
        allFailed ? 'failed' : 'ok',
        stats,
        allFailed ? new Error('every article failed') : undefined
      );
      console.log(
        `📋 News verification done. Considered: ${stats.considered}, matched: ${stats.matched} ` +
        `(irrelevant ${stats.irrelevant}, no claim ${stats.no_claim}, ` +
        `no city ${stats.no_city}, ambiguous ${stats.multiple_cities + stats.multiple_incidents}, ` +
        `no incident ${stats.no_incident}, deferred ${stats.deferred ?? 0}, errors ${stats.errors ?? 0})`
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '42P01') {
        // Migration 007 not applied yet — deploying ahead of it is harmless.
        await recordJobRun('news_verify', startedAt, 'skipped', {
          reason: 'incident_news_claims missing — apply migration 007',
        });
        return;
      }
      console.error('News verification failed:', (error as Error).message);
      await recordJobRun('news_verify', startedAt, 'failed', stats, error);
    }
  }

  /** Province name → id, from the static 81-row table. */
  private async loadCities(): Promise<Map<string, number>> {
    try {
      const result = await pool.query(`SELECT id, name FROM turkey_cities`);
      const map = new Map<string, number>();
      for (const row of result.rows) map.set(String(row.name), Number(row.id));
      return map;
    } catch {
      return new Map();
    }
  }

  /**
   * Runs one article through the gates in order and records where it stopped.
   * Returns the outcome for the run stats.
   */
  private async judgeArticle(
    article: PendingNews,
    cities: Map<string, number>
  ): Promise<string> {
    const text = `${article.title} ${article.summary ?? ''}`;
    const publishedAt = article.published_at ?? article.created_at;

    const relevance = assessRelevance(text);
    if (!relevance.relevant) {
      await this.saveVerdict(article, publishedAt, {
        outcome: 'irrelevant',
        relevanceReason: relevance.reason,
      });
      return 'irrelevant';
    }

    const claim = extractStatusClaim(text);
    if (claim === null) {
      await this.saveVerdict(article, publishedAt, {
        outcome: 'no_claim',
        relevanceReason: relevance.reason,
      });
      return 'no_claim';
    }

    const named = mentionedCities(text, [...cities.keys()]);
    if (named.length !== 1) {
      const outcome = named.length === 0 ? 'no_city' : 'multiple_cities';
      await this.saveVerdict(article, publishedAt, {
        outcome,
        relevanceReason: relevance.reason,
        claim,
        cityName: named.length > 0 ? named.join(', ') : null,
      });
      return outcome;
    }

    const cityName = named[0];
    const cityId = cities.get(cityName)!;

    // Open incidents only (official_state IS NULL uses the partial index):
    // once a fire has an official status, later articles about it are
    // history, not verification.
    const candidates = await pool.query(
      `SELECT id FROM fire_incidents
        WHERE official_state IS NULL
          AND city_id = $1
          AND last_detected_at >= $2::timestamptz - make_interval(days => $3)
          AND first_detected_at <= $2::timestamptz + make_interval(hours => $4)
        ORDER BY last_detected_at DESC`,
      [cityId, publishedAt, LOOKBACK_DAYS, LOOKAHEAD_HOURS]
    );

    const count = candidates.rows.length;

    // A verdict is final once written, and this job runs within hours of
    // publication — but FIRMS routinely sees a fire hours after the wire
    // story. Refusing to write 'no_incident' until the whole lookahead
    // window has elapsed is what keeps that window from being dead code.
    // The article is simply left unjudged and picked up by a later run.
    if (
      count === 0 &&
      Date.now() - publishedAt.getTime() < LOOKAHEAD_HOURS * 60 * 60 * 1000
    ) {
      return 'deferred';
    }

    const outcome =
      count === 1 ? 'matched' : count === 0 ? 'no_incident' : 'multiple_incidents';

    await this.saveVerdict(article, publishedAt, {
      outcome,
      relevanceReason: relevance.reason,
      claim,
      cityName,
      candidateCount: count,
      incidentId: count === 1 ? Number(candidates.rows[0].id) : null,
    });
    return outcome;
  }

  private async saveVerdict(
    article: PendingNews,
    publishedAt: Date,
    verdict: {
      outcome: string;
      relevanceReason: string;
      claim?: { state: string; phrase: string; rule: string; suppressed: string[] };
      cityName?: string | null;
      candidateCount?: number;
      incidentId?: number | null;
    }
  ): Promise<void> {
    // ON CONFLICT DO NOTHING: the first verdict for an article stands; a
    // concurrent run must not flap it.
    await pool.query(
      `INSERT INTO incident_news_claims
         (news_id, incident_id, claim_state, claim_phrase, claim_rule,
          suppressed_rules, relevance_reason, city_name, candidate_count,
          outcome, news_published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (news_id) DO NOTHING`,
      [
        article.id,
        verdict.incidentId ?? null,
        verdict.claim?.state ?? null,
        verdict.claim?.phrase ?? null,
        verdict.claim?.rule ?? null,
        verdict.claim?.suppressed ?? [],
        verdict.relevanceReason,
        verdict.cityName ?? null,
        verdict.candidateCount ?? 0,
        verdict.outcome,
        publishedAt,
      ]
    );
  }
}

export default new NewsVerificationJob();
