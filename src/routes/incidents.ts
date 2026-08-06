import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { rateLimit } from '../middleware/security';
import { isRegionKey } from '../utils/regions';
import cacheService from '../services/cacheService';

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
const SIGNIFICANT_MIN_OVERPASSES = 2;
const SIGNIFICANT_MIN_FRP_MW = 8;

/**
 * Cache lifetime for incident reads.
 *
 * Five minutes is chosen from the data rate, not from taste: FIRMS publishes
 * three to six hours after acquisition and the cluster job runs on a timer, so
 * nothing in this table can change more often than that. On free-tier Postgres
 * that scales to zero, every avoided query is also an avoided cold start.
 */
const INCIDENTS_CACHE_TTL_SECONDS = 300;

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
                  i.max_frp_mw,
                  i.last_detected_at > NOW() - ($1 || ' hours')::interval
                    AS is_active,
                  (i.overpass_count >= $2
                   AND COALESCE(i.max_frp_mw, 0) >= $3
                   AND i.peak_confidence_tier IS DISTINCT FROM 'low')
                    AS is_significant
           FROM fire_incidents i
           WHERE i.last_detected_at > NOW() - INTERVAL '14 days'
         ),
         counts AS (
           SELECT
             COUNT(*) FILTER (WHERE is_active) AS active_count,
             -- The headline number needs two layers. "60 active detections"
             -- alone reads as sixty fires; most are single fresh pixels that
             -- have not had a second overpass yet.
             COUNT(*) FILTER (WHERE is_active AND is_significant)
               AS active_significant_count,
             -- Crossed the threshold within the last 24 h: the crossing
             -- moment is last_detected_at + threshold. Only incidents with
             -- real evidence behind them are counted; a single-overpass
             -- pixel that is no longer seen is not a fire that stopped.
             COUNT(*) FILTER (
               WHERE NOT is_active
                 AND is_significant
                 AND last_detected_at
                     > NOW() - (($1::int + 24) || ' hours')::interval
             ) AS detection_ended_24h
           FROM windowed
         ),
         longest AS (
           -- Ranked by peak radiative power, NOT by duration.
           --
           -- Duration is censored by the two-day ingest window: the longest
           -- incident in the whole feed is 34.5 h and the values pile up at
           -- 24.0 h and 24.8 h, so "longest running" ranks by how close an
           -- incident is to the window edge. Worse, the thing that reaches
           -- that edge is whatever never stops — a fixed industrial source
           -- beats every real wildfire at staying alight, and one duly
           -- arrived on the home screen as the country's longest-running
           -- fire at a flat 4.35 MW in urban Istanbul.
           --
           -- max_frp_mw has no such ceiling and is the measurement the
           -- satellite actually makes. Duration is still returned, for the
           -- client to render as a lower bound.
           SELECT w.id, w.duration_hours, w.first_detected_at,
                  w.last_detected_at, w.max_frp_mw, c.name AS city_name
           FROM windowed w
           LEFT JOIN turkey_cities c ON c.id = w.city_id
           WHERE w.is_active AND w.is_significant
           ORDER BY w.max_frp_mw DESC NULLS LAST
           LIMIT 1
         )
         SELECT counts.active_count,
                counts.active_significant_count,
                counts.detection_ended_24h,
                longest.id AS longest_id,
                longest.duration_hours AS longest_duration_hours,
                longest.max_frp_mw AS longest_max_frp_mw,
                longest.city_name AS longest_city_name,
                longest.first_detected_at AS longest_first_detected_at,
                longest.last_detected_at AS longest_last_detected_at
         FROM counts LEFT JOIN longest ON TRUE`,
        [RECENT_DETECTION_HOURS, SIGNIFICANT_MIN_OVERPASSES, SIGNIFICANT_MIN_FRP_MW]
      );

      const row = result.rows[0] ?? {};

      res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
      res.json({
        status: 'success',
        data: {
          recent_detection_hours: RECENT_DETECTION_HOURS,
          significance: {
            min_overpasses: SIGNIFICANT_MIN_OVERPASSES,
            min_frp_mw: SIGNIFICANT_MIN_FRP_MW,
            excluded_confidence_tier: 'low',
          },
          active_count: Number(row.active_count ?? 0),
          active_significant_count: Number(row.active_significant_count ?? 0),
          detection_ended_24h: Number(row.detection_ended_24h ?? 0),
          // Named for what it is ranked by. `duration_hours` is a LOWER
          // BOUND, not a measurement: the ingest window truncates it.
          strongest_active:
            row.longest_id === null || row.longest_id === undefined
              ? null
              : {
                  id: Number(row.longest_id),
                  city_name: row.longest_city_name ?? null,
                  max_frp_mw: numeric(row.longest_max_frp_mw),
                  duration_hours_at_least: round(row.longest_duration_hours, 2),
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

    // The key is the full parameter set, in a fixed order. Keying on
    // anything less would serve a Marmara-filtered page to someone who asked
    // for Ege — the kind of bug that looks like missing fires.
    const cacheKey =
      'incidents:v1:' +
      JSON.stringify({
        days,
        limit,
        region_key: typeof regionKey === 'string' ? regionKey : null,
        city_id: typeof cityId === 'string' ? cityId : null,
        state: typeof state === 'string' ? state : null,
      });

    const cached = await cacheService.get<{ count: number; data: unknown[] }>(
      cacheKey
    );
    if (cached) {
      res.set(
        'Cache-Control',
        'public, max-age=120, stale-while-revalidate=300'
      );
      res.set('X-Cache', 'HIT');
      res.json({ status: 'success', count: cached.count, data: cached.data });
      return;
    }

    const result = await pool.query(
      `SELECT i.id,
              -- Which instruments actually contributed, straight from the
              -- linked detections. Without this the panel could only say
              -- "satellite data" and the reader had to take the count on
              -- trust; a claim about evidence should be able to name it.
              (SELECT json_agg(x ORDER BY x->>'product')
                 FROM (
                   SELECT json_build_object(
                            'product', d.product,
                            'satellite', d.satellite,
                            'count', count(*)::int
                          ) AS x
                     FROM fire_detections d
                    WHERE d.incident_id = i.id
                    GROUP BY d.product, d.satellite
                 ) s) AS sources,
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
              -- Joined here so the client stops inferring a province by
              -- proximity to whichever raw detections it happened to have
              -- fetched. That inference tied every incident's label to the
              -- thermal feed being loaded.
              c.name AS city_name,
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
              spread_confidence,
              -- Persistence metrics, exposed so the CV threshold that will
              -- eventually separate gas flares from fires can be measured
              -- from outside the database.
              distinct_days_seen,
              frp_mean,
              frp_stddev,
              frp_trend,
              frp_trend_ratio,
              frp_trend_passes,
              frp_geometry_ratio
       FROM fire_incidents i
       LEFT JOIN turkey_cities c ON c.id = i.city_id
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
      city_name: row.city_name ?? null,
      // Empty rather than null once detections have been pruned at 90 days:
      // "no longer know" and "never had any" must not look the same.
      sources: (row.sources ?? []) as unknown[],
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

      // How the radiated heat is changing. Null unless three passes agree
      // and the viewing geometry held still — see migration 005 for why the
      // second condition is not optional.
      //
      // 'weakening' means the fire is radiating less heat. It does NOT mean
      // anyone is fighting it: a satellite cannot see a crew or an aircraft.
      trend: {
        direction: row.frp_trend ?? null,
        ratio: numeric(row.frp_trend_ratio),
        passes: row.frp_trend_passes ?? null,
        geometry_ratio: numeric(row.frp_geometry_ratio),
      },

      // Raw persistence numbers. Nothing consumes these yet; they exist so a
      // threshold can be measured rather than guessed.
      persistence: {
        distinct_days_seen: row.distinct_days_seen ?? null,
        frp_mean: numeric(row.frp_mean),
        frp_stddev: numeric(row.frp_stddev),
      },

      // Derived from how the detection pattern moved, which is not the same
      // as how the fire moved. Null whenever the evidence is too thin.
      spread: {
        bearing_deg: numeric(row.spread_bearing_deg),
        speed_m_per_hour: numeric(row.spread_speed_mh),
        confidence: row.spread_confidence,
      },
    }));

    await cacheService.set(
      cacheKey,
      { count: data.length, data },
      INCIDENTS_CACHE_TTL_SECONDS
    );

    res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
    res.set('X-Cache', 'MISS');
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
