import { Router } from 'express';
import { rateLimit } from '../middleware/security';

export const NO_MINIMUM_VERSION = '0.0.0';

/** The lowest app version allowed to run. A bad value forces nobody. */
export function minSupportedVersion(value: string | undefined): string {
  const v = value?.trim() ?? '';
  return /^\d+(\.\d+){0,2}$/.test(v) ? v : NO_MINIMUM_VERSION;
}

const router = Router();

/** GET /api/app-config. Set MIN_SUPPORTED_VERSION in the environment to force an update. */
router.get('/', rateLimit('app-config', 120, 60_000), (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'success', data: { min_supported_version: minSupportedVersion(process.env.MIN_SUPPORTED_VERSION) } });
});

export default router;
