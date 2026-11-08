import type { Pool } from 'pg';
import { heatSourceSqlCondition } from './heatSource';
import { NEARBY_FIRE_PIPELINE_JOBS, isPipelineFresh } from './nearbyFireCount';

/**
 * What the app needs to tell "no detections" apart from "we don't know".
 *
 * An empty incident list alone cannot say which it is: a quiet winter day and
 * a pipeline that stopped three hours ago both produce no rows. So the app
 * asks here, and says "no strong detections" only when pipeline_fresh is true
 * and strong_detections_24h is a real 0. "Strong" is the events layer's bar:
 * lone weak pixels are still on the map's possible-points layer.
 */

/**
 * The evidence bar an incident must clear before it is counted as a fire that
 * was burning and is no longer being detected. Mirrors IncidentSignificance
 * in the Flutter client, which is what the map filter uses — if one moves,
 * both move, or the home card and the map disagree about how many fires
 * there were.
 *
 * Of 237 live incidents, 149 were seen on exactly one overpass and never
 * again. Counting all 227 no-longer-detected incidents put "194" on the home
 * screen next to a map showing 15 — and a number that large, next to the
 * words "detection ended", reads as a body count of extinguished fires.
 *
 * The power floor is 8 MW rather than a higher overpass count on purpose:
 * requiring four passes admits ~24-hour, 1-4 MW sources that are visible on
 * every pass, which is the signature of a gas flare, not a wildfire.
 */
export const SIGNIFICANT_MIN_OVERPASSES = 2;
export const SIGNIFICANT_MIN_FRP_MW = 8;

const STRONG_SQL = (alias: string): string =>
  `${alias}.overpass_count >= ${SIGNIFICANT_MIN_OVERPASSES}
   AND COALESCE(${alias}.max_frp_mw, 0) >= ${SIGNIFICANT_MIN_FRP_MW}
   AND ${alias}.peak_confidence_tier IS DISTINCT FROM 'low'`;

export interface PipelineState {
  fresh: boolean;
  /** The older of the ingest and cluster runs: the data is only as new as that. */
  lastUpdateAt: Date | null;
}

export async function loadPipelineState(db: Pick<Pool, 'query'>): Promise<PipelineState> {
  const runs = await db.query(
    `SELECT j.job, now() AS db_now,
            (SELECT max(r.finished_at) FROM job_runs r
              WHERE r.job = j.job AND r.status = 'ok') AS last_ok
       FROM unnest($1::text[]) AS j(job)`,
    [[...NEARBY_FIRE_PIPELINE_JOBS]]
  );
  if (runs.rows.length === 0) return { fresh: false, lastUpdateAt: null };
  const now = new Date(runs.rows[0].db_now);
  const lastOk: Record<string, Date | null> = {};
  for (const r of runs.rows) lastOk[r.job] = r.last_ok ? new Date(r.last_ok) : null;
  const times = Object.values(lastOk);
  const lastUpdateAt = times.every(Boolean)
    ? new Date(Math.min(...times.map((t) => (t as Date).getTime())))
    : null;
  return { fresh: isPipelineFresh(lastOk, now), lastUpdateAt };
}

export interface DetectionStatus {
  last_update_at: string | null;
  pipeline_fresh: boolean;
  /** Multi-pass events in 24 h. Null when the pipeline is stale: unknown, never zero. */
  strong_detections_24h: number | null;
  latest_detection: { detected_at: string; city: string | null } | null;
}

export function detectionSummarySql(): string {
  return `SELECT count(*) FILTER (WHERE i.last_detected_at > now() - interval '24 hours')::int AS n,
                 max(i.last_detected_at) AS latest
            FROM fire_incidents i
           WHERE ${STRONG_SQL('i')}
             AND NOT COALESCE((${heatSourceSqlCondition('i')}), false)`;
}

export function latestDetectionCitySql(): string {
  return `SELECT c.name AS city
            FROM fire_incidents i
            LEFT JOIN turkey_cities c ON c.id = i.city_id
           WHERE i.last_detected_at = $1
             AND ${STRONG_SQL('i')}
             AND NOT COALESCE((${heatSourceSqlCondition('i')}), false)
           LIMIT 1`;
}

export async function loadDetectionStatus(db: Pick<Pool, 'query'>): Promise<DetectionStatus> {
  const [pipeline, summary] = await Promise.all([
    loadPipelineState(db),
    db.query(detectionSummarySql()),
  ]);
  const latest: Date | null = summary.rows[0].latest ? new Date(summary.rows[0].latest) : null;
  const city = latest ? (await db.query(latestDetectionCitySql(), [latest])).rows[0]?.city ?? null : null;
  return {
    last_update_at: pipeline.lastUpdateAt?.toISOString() ?? null,
    pipeline_fresh: pipeline.fresh,
    strong_detections_24h: pipeline.fresh ? Number(summary.rows[0].n) : null,
    latest_detection: latest ? { detected_at: latest.toISOString(), city } : null,
  };
}
