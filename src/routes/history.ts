import { Router, Request, Response } from 'express';
import pool from '../config/database';
import cacheService from '../services/cacheService';
import { rateLimit } from '../middleware/security';
import {
  HISTORY_MIN_DETECTIONS,
  HISTORY_TIME_ZONE,
  historySql,
  parseHistoryRange,
  toHistoryCollection,
} from '../services/fireHistory';

const router = Router();

/** Incidents only change while burning; past days are settled. */
const CACHE_TTL_SECONDS = 1800;

/**
 * GET /api/history?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * GeoJSON FeatureCollection of past satellite-detected fires for the app's
 * history screen (FIRE_HISTORY_URL). See services/fireHistory.ts for what
 * the geometry and every property mean, and what they do not.
 */
router.get('/', rateLimit('history', 30, 60_000), async (req: Request, res: Response) => {
  const range = parseHistoryRange(req.query);
  if ('error' in range) {
    res.status(400).json({ status: 'error', message: range.error });
    return;
  }

  try {
    const cacheKey = `history:v2:${range.from}:${range.to}`;
    const cached = await cacheService.get<unknown>(cacheKey);
    if (cached) {
      res.set('Cache-Control', 'public, max-age=900');
      res.set('X-Cache', 'HIT');
      res.json(cached);
      return;
    }

    const [rows, coverage] = await Promise.all([
      pool.query(historySql(), [range.from, range.to, HISTORY_MIN_DETECTIONS]),
      pool.query(
        `SELECT to_char(min(first_detected_at) AT TIME ZONE '${HISTORY_TIME_ZONE}', 'YYYY-MM-DD') AS d
           FROM fire_incidents`
      ),
    ]);
    const payload = toHistoryCollection(rows.rows, range, coverage.rows[0]?.d ?? null);

    await cacheService.set(cacheKey, payload, CACHE_TTL_SECONDS);
    res.set('Cache-Control', 'public, max-age=900');
    res.set('X-Cache', 'MISS');
    res.json(payload);
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({ status: 'error', message: 'Fire history unavailable' });
  }
});

export default router;
