import { Router } from 'express';
import pool from '../config/database';
import newsController from '../controllers/newsController';
import { rateLimit } from '../middleware/security';
import cacheService from '../services/cacheService';
import { relatedNews } from '../services/relatedNews';
const router = Router();

// GET /api/news - Get all news
router.get('/', (req, res) => newsController.getAllNews(req, res));

/**
 * GET /api/news/related?city=&from=&to=&limit= — forest-fire stories about
 * one province (or, without city, anywhere) in a date range. An empty list
 * is a normal answer; the app then shows nothing.
 */
router.get('/related', rateLimit('news-related', 120, 60_000), async (req, res) => {
  const city = typeof req.query.city === 'string' && req.query.city.trim() ? req.query.city.trim().slice(0, 40) : null;
  const to = new Date(String(req.query.to ?? ''));
  const from = new Date(String(req.query.from ?? ''));
  const end = Number.isNaN(to.getTime()) ? new Date() : to;
  const start = Number.isNaN(from.getTime()) ? new Date(end.getTime() - 7 * 86_400_000) : from;
  const limit = Math.min(10, Math.max(1, Number(req.query.limit) || 3));
  try {
    const key = `news:related:v1:${city ?? '*'}:${start.toISOString().slice(0, 13)}:${end.toISOString().slice(0, 13)}:${limit}`;
    let data = await cacheService.get<unknown[]>(key);
    if (!data) {
      data = await relatedNews(pool, city, start, end, limit);
      await cacheService.set(key, data, 600);
    }
    res.json({ status: 'success', data });
  } catch (error) {
    console.error('related news failed:', (error as Error).message);
    res.status(503).json({ status: 'error', code: 'related_unavailable' });
  }
});

// GET /api/news/:id - Get single news
router.get('/:id', (req, res) => newsController.getNewsById(req, res));

export default router;