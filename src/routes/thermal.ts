import axios from 'axios';
import { Response, Router } from 'express';
import cacheService from '../services/cacheService';
import { rateLimit } from '../middleware/security';

const router = Router();

const TURKEY_AREA = '25,35,45,43';
const FIRMS_BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';

type ThermalPayload = { csv: string; product: string; days: number; fetchedAt: string };

/**
 * A response has to clear this to be accepted outright.
 *
 * The old test was "more than one line", i.e. anything that was not literally
 * empty. FIRMS rolls its day at 00:00 UTC, so for the first hours of every UTC
 * day the one-day window holds only the handful of detections recorded since
 * midnight — measured at 08:29 UTC: 3 rows for one day against 621 for two.
 * Three rows passed "not empty", the fallback never engaged, and the app drew
 * three dots over the whole country from roughly 03:00 to 12:00 Turkish time,
 * every day.
 *
 * Ten is a floor, not a target: it is high enough that a nearly-empty window
 * is recognised as one, low enough that a genuinely quiet winter day is not
 * mistaken for a broken feed. Falling through costs nothing, because every
 * later attempt is a superset of the earlier one.
 */
const MIN_ACCEPTABLE_ROWS = 10;

function rowCount(csv: string): number {
  return Math.max(0, csv.trim().split(/\r?\n/).filter(Boolean).length - 1);
}

/**
 * Single exit point, so the cache entry, the headers and the body cannot drift
 * apart between branches. The response shape is unchanged from the previous
 * version — raw FIRMS CSV, same columns, same X-Data-Source, same cache key
 * and 300s TTL. The shipped app parses this byte for byte.
 */
async function sendCsv(
  res: Response,
  csv: string,
  product: string,
  days: number
): Promise<void> {
  const payload: ThermalPayload = {
    csv,
    product,
    days,
    fetchedAt: new Date().toISOString(),
  };
  await cacheService.set('thermal:turkey:current', payload, 300);
  res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
  res.setHeader('X-Data-Source', `${product}/${days}`);
  res.type('text/csv').send(csv);
}

router.get('/', rateLimit('thermal', 60, 60_000), async (_req, res) => {
  const cached = await cacheService.get<ThermalPayload>('thermal:turkey:current');
  if (cached) {
    res.setHeader('X-Data-Source', `${cached.product}/${cached.days}`);
    res.type('text/csv').send(cached.csv);
    return;
  }

  const apiKey = process.env.NASA_API_KEY;
  if (!apiKey) {
    res.status(503).json({ status: 'error', message: 'Thermal data source is not configured' });
    return;
  }

  // Two days is the primary window, not a fallback. One day is structurally
  // short for the first half of every UTC day and there is no hour at which it
  // is better — only hours at which it is not yet visibly worse. Two days
  // captured 621 detections against three for one day, while three days only
  // added 90 more and those are staler.
  //
  // Age is handled by the client: FirePoint.smartStatus marks anything twelve
  // hours or older 'historical' regardless of confidence, so the extra day
  // shows as past detections rather than as false active fires.
  const attempts = [
    { product: 'VIIRS_SNPP_NRT', days: 2 },
    { product: 'VIIRS_SNPP_NRT', days: 3 },
    { product: 'MODIS_NRT', days: 2 },
  ];

  try {
    // Best non-empty response seen so far, used when nothing clears the floor
    // — returning thin data still beats returning none.
    let fallback: { csv: string; product: string; days: number; rows: number } | null = null;

    for (const attempt of attempts) {
      const url = `${FIRMS_BASE}/${encodeURIComponent(apiKey)}/${attempt.product}/${TURKEY_AREA}/${attempt.days}`;
      const response = await axios.get<string>(url, { timeout: 20_000, responseType: 'text' });
      const csv = response.data;
      const rows = rowCount(csv);
      if (rows === 0) continue;

      if (rows < MIN_ACCEPTABLE_ROWS) {
        if (!fallback || rows > fallback.rows) fallback = { csv, rows, ...attempt };
        continue;
      }
      await sendCsv(res, csv, attempt.product, attempt.days);
      return;
    }

    if (fallback) {
      await sendCsv(res, fallback.csv, fallback.product, fallback.days);
      return;
    }
    res.status(503).json({ status: 'error', message: 'No current thermal data available' });
  } catch (error) {
    console.error('Thermal proxy failed:', (error as Error).message);
    res.status(502).json({ status: 'error', message: 'Thermal provider unavailable' });
  }
});

export default router;
