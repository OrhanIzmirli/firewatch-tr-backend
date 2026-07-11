import axios from 'axios';
import { Router } from 'express';
import cacheService from '../services/cacheService';
import { rateLimit } from '../middleware/security';

const router = Router();
const TURKEY_AREA = '25,35,45,43';
const FIRMS_BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';

type ThermalPayload = { csv: string; product: string; days: number; fetchedAt: string };

function hasData(csv: string): boolean {
  return csv.trim().split(/\r?\n/).filter(Boolean).length > 1;
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

  const attempts = [
    { product: 'VIIRS_SNPP_NRT', days: 1 },
    { product: 'MODIS_NRT', days: 1 },
    { product: 'VIIRS_SNPP_NRT', days: 2 },
  ];

  try {
    for (const attempt of attempts) {
      const url = `${FIRMS_BASE}/${encodeURIComponent(apiKey)}/${attempt.product}/${TURKEY_AREA}/${attempt.days}`;
      const response = await axios.get<string>(url, { timeout: 20_000, responseType: 'text' });
      const csv = response.data;
      if (!hasData(csv)) continue;
      const payload: ThermalPayload = { csv, ...attempt, fetchedAt: new Date().toISOString() };
      await cacheService.set('thermal:turkey:current', payload, 300);
      res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
      res.setHeader('X-Data-Source', `${attempt.product}/${attempt.days}`);
      res.type('text/csv').send(csv);
      return;
    }
    res.status(503).json({ status: 'error', message: 'No current thermal data available' });
  } catch (error) {
    console.error('Thermal proxy failed:', (error as Error).message);
    res.status(502).json({ status: 'error', message: 'Thermal provider unavailable' });
  }
});

export default router;
