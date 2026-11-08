import { Router } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { rateLimit } from '../middleware/security';

const router = Router();
const FILE = path.join(process.cwd(), 'public', 'nature', 'facts.json');

/**
 * GET /api/nature/facts: the "Did you know?" pool. Every entry was checked
 * against the page it links to (FACTS-DOGRULAMA.md in the app repo). Lives
 * in a file so facts can be added with a backend deploy and no app update.
 */
router.get('/facts', rateLimit('nature-facts', 60, 60_000), async (_req, res) => {
  try {
    const facts = JSON.parse(await fs.readFile(FILE, 'utf8'));
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ status: 'success', data: facts });
  } catch (error) {
    console.error('nature facts failed:', (error as Error).message);
    res.status(503).json({ status: 'error', code: 'facts_unavailable' });
  }
});

export default router;
