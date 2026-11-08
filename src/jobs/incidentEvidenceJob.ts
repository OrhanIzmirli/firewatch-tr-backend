import type { Pool } from 'pg';
import pool from '../config/database';
import { recordJobRun } from '../services/jobRunRecorder';
import { MatchArticle, MatchIncident, matchIncidentsToNews } from '../services/incidentNewsMatch';
import { LandCoverSampler, classifyLandCover, sampleWorldCover } from '../services/landCover';
import { DistrictRef } from '../services/placeMention';
import { withFormerNames } from '../services/provinces';

/**
 * Two facts about each incident that decide where it may be shown: what the
 * ground is, and whether a news story confirms it. Runs in the ingest tick
 * between clustering and the alerts, so an alert already knows both.
 * Never throws: a failed lookup leaves the incident unclassified.
 */

type Db = Pick<Pool, 'query'>;

export const LAND_COVER_LOOKBACK_DAYS = 30;
export const LAND_COVER_BATCH = 80;
export const NEWS_MATCH_LOOKBACK_DAYS = 14;

export interface EvidenceStats {
  classified: number;
  failed: number;
  matched: number;
}

export function pendingLandCoverSql(): string {
  return `SELECT id, ST_Y(centroid) AS lat, ST_X(centroid) AS lng
            FROM fire_incidents
           WHERE land_cover IS NULL
             AND last_detected_at > now() - make_interval(days => $1)
           ORDER BY last_detected_at DESC
           LIMIT $2`;
}

export async function classifyPendingLandCover(
  db: Db,
  sample: LandCoverSampler,
  stats: EvidenceStats
): Promise<void> {
  const { rows } = await db.query(pendingLandCoverSql(), [LAND_COVER_LOOKBACK_DAYS, LAND_COVER_BATCH]);
  for (const row of rows) {
    try {
      const shares = await sample(Number(row.lat), Number(row.lng));
      await db.query(
        `UPDATE fire_incidents SET land_cover = $2, land_cover_shares = $3::jsonb WHERE id = $1`,
        [row.id, Object.keys(shares).length === 0 ? 'unknown' : classifyLandCover(shares), JSON.stringify(shares)]
      );
      stats.classified++;
    } catch (error) {
      stats.failed++;
      console.error('land cover lookup failed:', (error as Error).message);
    }
  }
}

export async function matchRecentNews(db: Db, stats: EvidenceStats): Promise<void> {
  const [incidents, news, cities, districts] = await Promise.all([
    db.query(
      `SELECT i.id, c.name AS city, ST_Y(i.centroid) AS lat, ST_X(i.centroid) AS lng,
              i.first_detected_at, i.last_detected_at
         FROM fire_incidents i
         JOIN turkey_cities c ON c.id = i.city_id
        WHERE i.news_verified_id IS NULL
          AND i.last_detected_at > now() - make_interval(days => $1)`,
      [NEWS_MATCH_LOOKBACK_DAYS]
    ),
    db.query(
      `SELECT id, title, summary, COALESCE(published_at, created_at) AS at
         FROM news
        WHERE COALESCE(published_at, created_at) > now() - make_interval(days => $1)`,
      [NEWS_MATCH_LOOKBACK_DAYS + 1]
    ),
    db.query(`SELECT name FROM turkey_cities`),
    db.query(
      `SELECT id, name, province_id, province_name, ST_Y(location) AS lat, ST_X(location) AS lng
         FROM turkey_districts`
    ),
  ]);
  const matches = matchIncidentsToNews(
    incidents.rows.map(
      (r: any): MatchIncident => ({
        id: Number(r.id),
        city: r.city,
        lat: Number(r.lat),
        lng: Number(r.lng),
        firstAt: new Date(r.first_detected_at),
        lastAt: new Date(r.last_detected_at),
      })
    ),
    news.rows.map(
      (r: any): MatchArticle => ({ id: Number(r.id), title: r.title, summary: r.summary, publishedAt: new Date(r.at) })
    ),
    {
      cityNames: withFormerNames(cities.rows.map((r: any) => String(r.name))),
      districts: districts.rows.map(
        (r: any): DistrictRef => ({
          id: Number(r.id),
          name: String(r.name),
          provinceId: Number(r.province_id),
          provinceName: String(r.province_name),
          lat: Number(r.lat),
          lng: Number(r.lng),
        })
      ),
    }
  );
  for (const [incident, article] of matches) {
    await db.query(`UPDATE fire_incidents SET news_verified_id = $2 WHERE id = $1 AND news_verified_id IS NULL`, [
      incident,
      article,
    ]);
    stats.matched++;
  }
}

export async function runIncidentEvidence(db: Db, sample: LandCoverSampler): Promise<EvidenceStats> {
  const stats: EvidenceStats = { classified: 0, failed: 0, matched: 0 };
  await classifyPendingLandCover(db, sample, stats);
  await matchRecentNews(db, stats);
  return stats;
}

class IncidentEvidenceJob {
  async run(): Promise<void> {
    const startedAt = new Date();
    try {
      const stats = await runIncidentEvidence(pool, sampleWorldCover);
      await recordJobRun('incident_evidence', startedAt, 'ok', { ...stats });
    } catch (error) {
      console.error('incident evidence failed:', (error as Error).message);
    }
  }
}

export default new IncidentEvidenceJob();
