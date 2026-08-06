import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { rateLimit } from '../middleware/security';
import { isRegionKey } from '../utils/regions';

const router = Router();

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/** Incidents older than this are excluded unless ?days= asks for more. */
const DEFAULT_WINDOW_DAYS = 7;

/**
 * Mirrors RECENT_DETECTION_HOURS in fireClusterJob. The summary recomputes
 * freshness from last_detected_at rather than reading the stored
 * satellite_state, because that column is only as fresh as the last cluster
 * run — if the job is late, a stored 'detected_recently' would report a fire
 * as currently burning when the newest evidence is hours old.
 */
const RECENT_DETECTION_HOURS = 6;

/**
 * GET /api/incidents/summary — the last 24 hours in three numbers.
 *
 * Registered before '/' so the literal path wins over any future ':id' route.
 *
 * `detection_ended_24h` counts incidents that crossed the recency threshold
 * during the last 24 hours. It is NOT a count of fires that were put out:
 * a satellite that sees nothing has not seen anything, which is a statement
 * about the satellite. The client must label it accordingly.
 */
router.get(
  '/summary',
  rateLimit('incidents_summary', 60, 60_000),
  async (_req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `WITH windowed AS (
           SELECT i.id,
                  i.first_detected_at,
                  i.last_detected_at,
                  i.city_id,
                  EXTRACT(EPOCH FROM (i.last_detected_at - i.first_detected_at))
                    / 3600.0 AS duration_hours,
                  i.last_detected_at > NOW() - ($1 || ' hours')::interval
                    AS is_active
           FROM fire_incidents i
           WHERE i.last_detected_at > NOW() - INTERVAL '14 days'
         ),
         counts AS (
           SELECT
             COUNT(*) FILTER (WHERE is_active) AS active_count,
             -- Crossed the threshold within the last 24 h: the crossing
             -- moment is last_detected_at + threshold.
             COUNT(*) FILTER (
               WHERE NOT is_active
                 AND last_detected_at
                     > NOW() - (($1::int + 24) || ' hours')::interval
             ) AS detection_ended_24h
           FROM windowed
         ),
         longest AS (
           SELECT w.id, w.duration_hours, w.first_detected_at,
                  w.last_detected_at, c.name AS city_name
           FROM windowed w
           LEFT JOIN turkey_cities c ON c.id = w.city_id
           WHERE w.is_active
           ORDER BY w.duration_hours DESC NULLS LAST
           LIMIT 1
         )
         SELECT counts.active_count,
                counts.detection_ended_24h,
                longest.id AS longest_id,
                longest.duration_hours AS longest_duration_hours,
                longest.city_name AS longest_city_name,
                longest.first_detected_at AS longest_first_detected_at,
                longest.last_detected_at AS longest_last_detected_at
         FROM counts LEFT JOIN longest ON TRUE`,
        [RECENT_DETECTION_HOURS]
      );

      const row = result.rows[0] ?? {};

      res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
      res.json({
        status: 'success',
        data: {
          recent_detection_hours: RECENT_DETECTION_HOURS,
          active_count: Number(row.active_count ?? 0),
          detection_ended_24h: Number(row.detection_ended_24h ?? 0),
          longest_active:
            row.longest_id === null || row.longest_id === undefined
              ? null
              : {
                  id: Number(row.longest_id),
                  city_name: row.longest_city_name ?? null,
                  duration_hours: round(row.longest_duration_hours, 2),
                  first_detected_at: row.longest_first_detected_at,
                  last_detected_at: row.longest_last_detected_at,
                },
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code === '42P01') {
        res.status(503).json({
          status: 'error',
          message: 'Incident data is not available yet',
        });
        return;
      }
      console.error('incidents summary error:', error);
      res
        .status(500)
        .json({ status: 'error', message: 'Unable to load incident summary' });
    }
  }
);

/**
 * GET /api/incidents — clustered fire incidents.
 *
 * This is a NEW endpoint. /api/thermal is untouched and still serves the
 * shipped app its raw CSV; nothing here replaces it.
 *
 * Query: ?days=7 &region_key= &city_id= &limit=100 &state=
 *
 * The response deliberately separates the three verification axes instead of
 * flattening them into one "status" field. A caller must not be able to read
 * "no recent detection" as "the fire is out" — the satellite cannot know
 * that. Only `official` carries a containment or extinction claim, and only
 * when a named source confirmed it.
 */
router.get('/', rateLimit('incidents', 60, 60_000), async (req: Request, res: Response) => {
  try {
    const days = clampInt(req.query.days, DEFAULT_WINDOW_DAYS, 1, 365);
    const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

    const conditions: string[] = [
      `last_detected_at > NOW() - ($1 || ' days')::interval`,
    ];
    const params: unknown[] = [days];

    const regionKey = req.query.region_key;
    if (typeof regionKey === 'string' && regionKey !== '') {
      if (!isRegionKey(regionKey)) {
        res.status(400).json({ status: 'error', message: 'Unknown region_key' });
        return;
      }
      params.push(regionKey);
      conditions.push(`region_key = $${params.length}`);
    }

    const cityId = req.query.city_id;
    if (typeof cityId === 'string' && cityId !== '') {
      const parsed = Number(cityId);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        res.status(400).json({ status: 'error', message: 'city_id must be a positive integer' });
        return;
      }
      params.push(parsed);
      conditions.push(`city_id = $${params.length}`);
    }

    const state = req.query.state;
    if (typeof state === 'string' && state !== '') {
      if (state !== 'detected_recently' && state !== 'no_recent_detection') {
        res.status(400).json({
          status: 'error',
          message: "state must be 'detected_recently' or 'no_recent_detection'",
        });
        return;
      }
      params.push(state);
      conditions.push(`satellite_state = $${params.length}`);
    }

    params.push(limit);

    const result = await pool.query(
      `SELECT id,
              first_detected_at,
              last_detected_at,
              EXTRACT(EPOCH FROM (last_detected_at - first_detected_at)) / 3600.0
                AS duration_hours,
              detection_count,
              overpass_count,
              ST_Y(centroid) AS latitude,
              ST_X(centroid) AS longitude,
              max_frp_mw,
              peak_confidence_tier,
              city_id,
              region_key,
              satellite_state,
              hours_since_last_detection,
              optical_burnt_area_ha,
              optical_fire_date,
              optical_source,
              official_state,
              official_source,
              official_source_url,
              official_confirmed_at,
              spread_bearing_deg,
              spread_speed_mh,
              spread_confidence
       FROM fire_incidents
       WHERE ${conditions.join(' AND ')}
       ORDER BY last_detected_at DESC
       LIMIT $${params.length}`,
      params
    );

    const data = result.rows.map((row: any) => ({
      id: Number(row.id),
      first_detected_at: row.first_detected_at,
      last_detected_at: row.last_detected_at,
      duration_hours: round(row.duration_hours, 2),
      detection_count: row.detection_count,
      overpass_count: row.overpass_count,
      latitude: round(row.latitude, 5),
      longitude: round(row.longitude, 5),
      max_frp_mw: numeric(row.max_frp_mw),
      peak_confidence_tier: row.peak_confidence_tier,
      city_id: row.city_id,
      region_key: row.region_key,

      // AXIS 1 — what the satellite saw. Never a claim about extinction.
      satellite: {
        state: row.satellite_state,
        hours_since_last_detection: round(row.hours_since_last_detection, 2),
      },

      // AXIS 2 — optical burnt-area confirmation. Confirms an area burned,
      // not that it stopped burning. Populated from phase B onward.
      optical: {
        burnt_area_ha: numeric(row.optical_burnt_area_ha),
        fire_date: row.optical_fire_date,
        source: row.optical_source,
      },

      // AXIS 3 — the only axis that may claim containment or extinction, and
      // only ever with a named, linked, timestamped source.
      official: {
        state: row.official_state,
        source: row.official_source,
        source_url: row.official_source_url,
        confirmed_at: row.official_confirmed_at,
      },

      // Derived from how the detection pattern moved, which is not the same
      // as how the fire moved. Null whenever the evidence is too thin.
      spread: {
        bearing_deg: numeric(row.spread_bearing_deg),
        speed_m_per_hour: numeric(row.spread_speed_mh),
        confidence: row.spread_confidence,
      },
    }));

    res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
    res.json({ status: 'success', count: data.length, data });
  } catch (error) {
    // A missing table means migration 003 has not been applied yet.
    if ((error as { code?: string }).code === '42P01') {
      res.status(503).json({
        status: 'error',
        message: 'Incident data is not available yet',
      });
      return;
    }
    console.error('incidents list error:', error);
    res.status(500).json({ status: 'error', message: 'Unable to load incidents' });
  }
});

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function round(value: unknown, digits: number): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default router;
