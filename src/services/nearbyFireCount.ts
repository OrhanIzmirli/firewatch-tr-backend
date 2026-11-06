import type { Pool } from 'pg';
import { heatSourceSqlCondition } from './heatSource';
import { RegionKey, regionKeyForRegionName } from '../utils/regions';

/**
 * `nearby_fire_count` for GET /api/risk/summary: how many satellite fire
 * incidents were detected in the same region during the last 24 hours,
 * fixed heat sources (steelworks, refineries, flares) excluded.
 *
 * "Missing means unavailable, never zero" (app contract). So the count is
 * null — for every region at once — whenever the satellite pipeline cannot
 * vouch for the last few hours: the ingest or cluster job has not finished
 * successfully within NEARBY_FIRE_MAX_STALENESS_HOURS, job_runs is missing,
 * or the count query fails. A region the pipeline covers but where nothing
 * was detected is a real 0.
 *
 * Heat sources are excluded with the SQL form of the rule
 * (heatSourceSqlCondition) rather than the heat_source_class column, so the
 * count is right whether or not migration 011 has been applied.
 */

export const NEARBY_FIRE_WINDOW_HOURS = 24;
/** Chosen 2026-11-06: with real ingest gaps this is null ~17% of the time. */
export const NEARBY_FIRE_MAX_STALENESS_HOURS = 6;
/** Both must be fresh: ingest fetches the pixels, cluster turns them into incidents. */
export const NEARBY_FIRE_PIPELINE_JOBS = ['ingest', 'cluster'] as const;

/** True when every pipeline job has a successful run recent enough. */
export function isPipelineFresh(
  lastOk: Partial<Record<string, Date | null>>,
  now: Date,
  maxStalenessHours = NEARBY_FIRE_MAX_STALENESS_HOURS
): boolean {
  const limitMs = maxStalenessHours * 3_600_000;
  return NEARBY_FIRE_PIPELINE_JOBS.every((job) => {
    const at = lastOk[job];
    if (!at || Number.isNaN(at.getTime())) return false;
    const age = now.getTime() - at.getTime();
    return age >= 0 && age <= limitMs;
  });
}

/**
 * Adds nearby_fire_count to each risk row. `counts` null → every row null;
 * a row whose region name is not a known region → null; otherwise the count
 * for its region, 0 when none.
 */
export function attachNearbyFireCounts<T extends { region: string }>(
  rows: T[],
  counts: Map<RegionKey, number> | null
): (T & { nearby_fire_count: number | null })[] {
  return rows.map((row) => {
    const key = regionKeyForRegionName(row.region);
    const count = counts && key ? counts.get(key) ?? 0 : null;
    return { ...row, nearby_fire_count: count };
  });
}

/** SQL for the per-region count; exported so the test can pin its shape. */
export function nearbyFireCountSql(): string {
  return `SELECT i.region_key, count(*)::int AS n
            FROM fire_incidents i
           WHERE i.last_detected_at > now() - make_interval(hours => $1)
             AND i.region_key IS NOT NULL
             AND NOT COALESCE((${heatSourceSqlCondition('i')}), false)
           GROUP BY i.region_key`;
}

/** Per-region counts, or null when the pipeline is stale or unreadable. */
export async function loadNearbyFireCounts(db: Pool): Promise<Map<RegionKey, number> | null> {
  try {
    // "now" comes from the database, the same clock that stamped
    // finished_at, so server/DB clock skew cannot make a fresh run look
    // like it finished in the future.
    const runs = await db.query(
      `SELECT j.job, now() AS db_now,
              (SELECT max(r.finished_at) FROM job_runs r
                WHERE r.job = j.job AND r.status = 'ok') AS last_ok
         FROM unnest($1::text[]) AS j(job)`,
      [[...NEARBY_FIRE_PIPELINE_JOBS]]
    );
    if (runs.rows.length === 0) return null;
    const now = new Date(runs.rows[0].db_now);
    const lastOk: Record<string, Date | null> = {};
    for (const r of runs.rows) lastOk[r.job] = r.last_ok ? new Date(r.last_ok) : null;
    if (!isPipelineFresh(lastOk, now)) return null;

    const result = await db.query(nearbyFireCountSql(), [NEARBY_FIRE_WINDOW_HOURS]);
    const counts = new Map<RegionKey, number>();
    for (const r of result.rows) counts.set(r.region_key as RegionKey, Number(r.n));
    return counts;
  } catch (error) {
    console.error('nearby_fire_count unavailable:', (error as Error).message);
    return null;
  }
}

/**
 * What the risk calculator's fire component needs per region, from the
 * same rows as nearby_fire_count: incidents seen in the window (fixed heat
 * sources excluded) and how many of their detections in the window carried
 * NASA's high confidence tier. Until 2026-11-07 the calculator counted raw
 * FIRMS pixels in a 4°x4° box around one point per region, which crossed
 * borders and counted flares; the app's own count is the one users see.
 */
export interface RegionFireStats {
  incidents: number;
  highConfidence: number;
}

export function regionFireStatsSql(): string {
  return `SELECT i.region_key,
                 count(*)::int AS incidents,
                 COALESCE(sum(hc.n), 0)::int AS high_confidence
            FROM fire_incidents i
            LEFT JOIN LATERAL (
              SELECT count(*) AS n
                FROM fire_detections d
               WHERE d.incident_id = i.id
                 AND d.confidence_tier = 'high'
                 AND d.acquired_at > now() - make_interval(hours => $1)
            ) hc ON true
           WHERE i.last_detected_at > now() - make_interval(hours => $1)
             AND i.region_key IS NOT NULL
             AND NOT COALESCE((${heatSourceSqlCondition('i')}), false)
           GROUP BY i.region_key`;
}

/** Per-region stats, or null when the pipeline is stale or unreadable. */
export async function loadRegionFireStats(db: Pool): Promise<Map<RegionKey, RegionFireStats> | null> {
  try {
    const runs = await db.query(
      `SELECT j.job, now() AS db_now,
              (SELECT max(r.finished_at) FROM job_runs r
                WHERE r.job = j.job AND r.status = 'ok') AS last_ok
         FROM unnest($1::text[]) AS j(job)`,
      [[...NEARBY_FIRE_PIPELINE_JOBS]]
    );
    if (runs.rows.length === 0) return null;
    const now = new Date(runs.rows[0].db_now);
    const lastOk: Record<string, Date | null> = {};
    for (const r of runs.rows) lastOk[r.job] = r.last_ok ? new Date(r.last_ok) : null;
    if (!isPipelineFresh(lastOk, now)) return null;

    const result = await db.query(regionFireStatsSql(), [NEARBY_FIRE_WINDOW_HOURS]);
    const stats = new Map<RegionKey, RegionFireStats>();
    for (const r of result.rows) {
      stats.set(r.region_key as RegionKey, {
        incidents: Number(r.incidents),
        highConfidence: Number(r.high_confidence),
      });
    }
    return stats;
  } catch (error) {
    console.error('region fire stats unavailable:', (error as Error).message);
    return null;
  }
}
