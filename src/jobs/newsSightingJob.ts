import cron from 'node-cron';
import pool from '../config/database';
import { recordJobRun } from '../services/jobRunRecorder';
import {
  assessRelevance,
  extractStatusClaim,
  mentionedCities,
} from '../services/officialStatusExtractor';
import {
  DistrictRef,
  mentionedDistricts,
  singleDistrict,
} from '../services/placeMention';
import { regionKeyForCoordinates } from '../utils/regions';

/**
 * Fires the newspapers know about and the satellite does not (yet).
 *
 * FIRMS publishes three to six hours after the overpass and sees nothing
 * through cloud or smoke. A wire story about a fire being fought is often
 * the first evidence there is. This job turns such stories into
 * news_reported_sightings rows — "reported, awaiting satellite" — and then
 * watches for the satellite to catch up.
 *
 * THIS JOB NEVER WRITES fire_incidents. A sighting is a claim by a
 * newspaper, kept in its own table under its own status set, and the
 * client labels it as such. It becomes 'satellite_confirmed' only when a
 * NEW fire_incidents row starts inside the radius, and it can never say a
 * fire is out: an expired sighting means the satellite did not agree, which
 * is a fact about evidence, not about the fire.
 *
 * REFUSE-OVER-GUESS, as in newsVerificationJob: two districts in one
 * article is a roundup; a district name the province cannot disambiguate
 * is unknown; a province with no district is too coarse to confirm
 * against. All of these are counted and skipped, never resolved by
 * picking one.
 *
 * Every number below was measured on 89 in-window articles (05 Aug –
 * 20 Sep 2026) before this file was written; see the migration 009 header.
 */

/** Match radius, metres. p90 of confirmed distances was 13.3 km. */
const MATCH_RADIUS_METRES = 15_000;

/** A sighting waits this long for the satellite. p90 lag was 33.8 h. */
const SIGHTING_WINDOW_HOURS = 48;

/**
 * The satellite may have acquired the pixel before the story ran and
 * published it after: FIRMS latency. An incident that STARTED up to this
 * long before the report still counts as the one it reported.
 */
const CONFIRM_GRACE_HOURS = 6;

/**
 * An incident seen within this long before the article, inside the radius,
 * means the satellite already knows — the story belongs to
 * incident_news_claims, not here.
 */
const NEARBY_ACTIVE_HOURS = 24;

/** Articles older than this are never (re)judged. */
const NEWS_WINDOW_DAYS = 2;

interface PendingNews {
  id: number;
  title: string;
  summary: string | null;
  published_at: Date | null;
  created_at: Date;
}

export interface SightingStats extends Record<string, number> {
  considered: number;
  irrelevant: number;
  status_claim_excluded: number;
  no_place: number;
  province_only: number;
  ambiguous_district: number;
  stale: number;
  incident_nearby: number;
  corroborated: number;
  created: number;
  confirmed: number;
  expired: number;
  errors: number;
}

class NewsSightingJob {
  start() {
    console.log('📰 News Sighting Job starting...');
    // A quarter past the verification tick, so both see the same scrape.
    cron.schedule('45 */6 * * *', async () => {
      await this.runSightings();
    });
    this.runSightings();
  }

  async runSightings(): Promise<SightingStats> {
    const startedAt = new Date();
    const stats: SightingStats = {
      considered: 0,
      irrelevant: 0,
      status_claim_excluded: 0,
      no_place: 0,
      province_only: 0,
      ambiguous_district: 0,
      stale: 0,
      incident_nearby: 0,
      corroborated: 0,
      created: 0,
      confirmed: 0,
      expired: 0,
      errors: 0,
    };

    try {
      const districts = await this.loadDistricts();
      if (districts.length === 0) {
        await recordJobRun('news_sighting', startedAt, 'skipped', {
          reason: 'turkey_districts empty or missing — apply migration 008 and run npm run seed:districts',
        });
        return stats;
      }
      const cityNames = await this.loadCityNames();

      // Resolve before creating: an incident that arrived since the last
      // run should confirm the sighting it belongs to, and only then may
      // the window close on the rest.
      stats.confirmed = await this.confirmOpenSightings();
      stats.expired = await this.expireOpenSightings();

      const pending = await pool.query(
        `SELECT n.id, n.title, n.summary, n.published_at, n.created_at
           FROM news n
          WHERE n.created_at > NOW() - make_interval(days => $1)
            AND NOT EXISTS (
              SELECT 1 FROM news_reported_sightings s
               WHERE s.corroborating_news_ids @> ARRAY[n.id]
            )
          ORDER BY n.id`,
        [NEWS_WINDOW_DAYS]
      );

      for (const article of pending.rows as PendingNews[]) {
        stats.considered++;
        try {
          const outcome = await this.judgeArticle(article, districts, cityNames);
          stats[outcome] = (stats[outcome] ?? 0) + 1;
        } catch (error) {
          if ((error as { code?: string }).code === '42P01') throw error;
          stats.errors++;
          console.error(
            `News sighting: article ${article.id} failed:`,
            (error as Error).message
          );
        }
      }

      const allFailed = stats.considered > 0 && stats.errors === stats.considered;
      await recordJobRun(
        'news_sighting',
        startedAt,
        allFailed ? 'failed' : 'ok',
        stats,
        allFailed ? new Error('every article failed') : undefined
      );
      console.log(
        `📰 News sighting done. Considered ${stats.considered}: created ${stats.created}, ` +
          `corroborated ${stats.corroborated}, incident nearby ${stats.incident_nearby}; ` +
          `resolved: confirmed ${stats.confirmed}, expired ${stats.expired}`
      );
      return stats;
    } catch (error) {
      if ((error as { code?: string }).code === '42P01') {
        // Migration 008/009 not applied yet — deploying ahead of it is harmless.
        await recordJobRun('news_sighting', startedAt, 'skipped', {
          reason: 'news_reported_sightings or turkey_districts missing — apply migrations 008 and 009',
        });
        return stats;
      }
      console.error('News sighting failed:', (error as Error).message);
      await recordJobRun('news_sighting', startedAt, 'failed', stats, error);
      return stats;
    }
  }

  private async loadDistricts(): Promise<DistrictRef[]> {
    try {
      const result = await pool.query(
        `SELECT id, name, province_id, province_name,
                ST_Y(location) AS lat, ST_X(location) AS lng
           FROM turkey_districts`
      );
      return result.rows.map((row: any) => ({
        id: Number(row.id),
        name: String(row.name),
        provinceId: Number(row.province_id),
        provinceName: String(row.province_name),
        lat: Number(row.lat),
        lng: Number(row.lng),
      }));
    } catch (error) {
      if ((error as { code?: string }).code === '42P01') return [];
      throw error;
    }
  }

  private async loadCityNames(): Promise<string[]> {
    const result = await pool.query(`SELECT name FROM turkey_cities`);
    return result.rows.map((row: any) => String(row.name));
  }

  /**
   * Runs one article through the gates in order and returns where it
   * stopped, as a stats key.
   */
  private async judgeArticle(
    article: PendingNews,
    districts: readonly DistrictRef[],
    cityNames: readonly string[]
  ): Promise<keyof SightingStats> {
    const text = `${article.title} ${article.summary ?? ''}`;
    const publishedAt = article.published_at ?? article.created_at;

    if (!assessRelevance(text).relevant) return 'irrelevant';

    // A story that says the fire is contained or out is not a report of an
    // unseen fire. 'ongoing' and no claim at all both pass; measured, they
    // confirmed at 38% and 31% respectively.
    const claim = extractStatusClaim(text);
    if (claim !== null && claim.state !== 'ongoing') return 'status_claim_excluded';

    const provinces = mentionedCities(text, [...cityNames]);
    const mentions = mentionedDistricts(text, districts, provinces);
    const mention = singleDistrict(mentions);
    if (mention === null) {
      if (mentions.length > 0) return 'ambiguous_district';
      // A province centroid is 50–100 km from most of its districts; the
      // backtest matched it to unrelated single-pixel detections. Counted
      // so the shadow report shows how much the gazetteer is missing.
      return provinces.length === 1 ? 'province_only' : 'no_place';
    }

    // An article already older than the window would expire on creation.
    if (Date.now() - publishedAt.getTime() > SIGHTING_WINDOW_HOURS * 3_600_000) {
      return 'stale';
    }

    const { district } = mention;

    // Already known to the satellite: leave it to incident_news_claims.
    const nearby = await pool.query(
      `SELECT 1 FROM fire_incidents
        WHERE ST_DWithin(
                centroid::geography,
                ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                $3
              )
          AND last_detected_at >= $4::timestamptz - make_interval(hours => $5)
          AND official_state IS DISTINCT FROM 'extinguished'
        LIMIT 1`,
      [district.lng, district.lat, MATCH_RADIUS_METRES, publishedAt, NEARBY_ACTIVE_HOURS]
    );
    if (nearby.rows.length > 0) return 'incident_nearby';

    // Same district, still open at publication: a second source, not a
    // second fire.
    const open = await pool.query(
      `SELECT id FROM news_reported_sightings
        WHERE district_id = $1
          AND status = 'news_reported'
          AND expires_at > $2::timestamptz
        ORDER BY first_reported_at DESC
        LIMIT 1`,
      [district.id, publishedAt]
    );
    if (open.rows.length > 0) {
      await pool.query(
        `UPDATE news_reported_sightings
            SET corroborating_news_ids = array_append(corroborating_news_ids, $2),
                corroborating_count    = cardinality(corroborating_news_ids) + 1,
                last_reported_at       = GREATEST(last_reported_at, $3::timestamptz),
                updated_at             = NOW()
          WHERE id = $1
            AND NOT (corroborating_news_ids @> ARRAY[$2::int])`,
        [Number(open.rows[0].id), article.id, publishedAt]
      );
      return 'corroborated';
    }

    await pool.query(
      `INSERT INTO news_reported_sightings
         (district_id, district_name, province_id, region_key, location,
          corroborating_news_ids, corroborating_count,
          first_reported_at, last_reported_at, expires_at)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326),
               ARRAY[$7::int], 1,
               $8, $8, $8::timestamptz + make_interval(hours => $9))`,
      [
        district.id,
        district.name,
        district.provinceId,
        regionKeyForCoordinates(district.lat, district.lng),
        district.lng,
        district.lat,
        article.id,
        publishedAt,
        SIGHTING_WINDOW_HOURS,
      ]
    );
    return 'created';
  }

  /**
   * Confirms every open sighting that a NEW incident has appeared next to.
   *
   * "New" is first_detected_at at or after the report (minus the FIRMS
   * grace). Merely overlapping in time is not enough: measured, overlap
   * semantics confirmed sightings against a fixed heat source seen on 83
   * passes over 41 days at 2 MW — a plant, not a fire. The same signature
   * fireClusterJob uses to withhold an FRP trend is excluded here outright,
   * so a flare inside the radius cannot confirm every report in its
   * district forever.
   *
   * The nearest qualifying incident wins; its distance is recorded so the
   * radius can be re-tuned from real confirmations.
   */
  private async confirmOpenSightings(): Promise<number> {
    const result = await pool.query(
      `WITH candidates AS (
         SELECT s.id AS sighting_id,
                i.id AS incident_id,
                ST_Distance(i.centroid::geography, s.location::geography) AS distance_m,
                row_number() OVER (
                  PARTITION BY s.id
                  ORDER BY ST_Distance(i.centroid::geography, s.location::geography)
                ) AS rn
           FROM news_reported_sightings s
           JOIN fire_incidents i
             ON ST_DWithin(i.centroid::geography, s.location::geography, $1)
            AND i.first_detected_at >= s.first_reported_at - make_interval(hours => $2)
            AND i.first_detected_at <= s.expires_at
            AND NOT (COALESCE(i.distinct_days_seen, 0) >= 2
                     AND COALESCE(i.max_frp_mw, 0) < 10
                     AND i.overpass_count >= 6)
          WHERE s.status = 'news_reported'
       )
       UPDATE news_reported_sightings s
          SET status               = 'satellite_confirmed',
              confirmed_incident_id = c.incident_id,
              confirmed_at         = NOW(),
              confirmed_distance_m = round(c.distance_m::numeric, 1),
              resolved_at          = NOW(),
              updated_at           = NOW()
         FROM candidates c
        WHERE c.rn = 1
          AND s.id = c.sighting_id`,
      [MATCH_RADIUS_METRES, CONFIRM_GRACE_HOURS]
    );
    return result.rowCount ?? 0;
  }

  private async expireOpenSightings(): Promise<number> {
    const result = await pool.query(
      `UPDATE news_reported_sightings
          SET status      = 'unconfirmed_expired',
              resolved_at = NOW(),
              updated_at  = NOW()
        WHERE status = 'news_reported'
          AND expires_at <= NOW()`
    );
    return result.rowCount ?? 0;
  }
}

export default new NewsSightingJob();
