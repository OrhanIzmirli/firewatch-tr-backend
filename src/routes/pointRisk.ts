import { Router } from 'express';
import { rateLimit } from '../middleware/security';
import { PointRiskDeps, computePointRisk } from '../services/pointRisk';
import { isWithinTurkeyBbox } from '../services/trackedPlaces';

/**
 * Risk at one point ("Konumum", a saved place). POST, so coordinates stay out
 * of URLs and therefore out of the access log.
 */
export function pointRiskRouter(deps: () => PointRiskDeps): Router {
  const router = Router();
  router.post('/point', rateLimit('risk-point', 120, 60 * 60_000), async (req, res) => {
    const lat = Number(req.body?.latitude);
    const lng = Number(req.body?.longitude);
    if (req.body?.latitude == null || req.body?.longitude == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.status(400).json({ status: 'error', code: 'invalid_point', message: 'latitude and longitude are required' });
      return;
    }
    if (!isWithinTurkeyBbox(lat, lng)) {
      res.status(422).json({ status: 'error', code: 'outside_turkey', message: 'The point must be in Turkey' });
      return;
    }
    try {
      res.json({ status: 'success', data: await computePointRisk(lat, lng, deps()) });
    } catch (error) {
      console.error('point risk failed:', (error as Error).message);
      res.status(503).json({ status: 'error', code: 'risk_unavailable', message: 'Risk is not available right now' });
    }
  });
  return router;
}
