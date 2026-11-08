import { Router } from 'express';
import pool from '../config/database';
import newsController from '../controllers/newsController';
import { rateLimit } from '../middleware/security';
import cacheService from '../services/cacheService';
import { relatedNews } from '../services/relatedNews';
import { provinceThumb } from '../services/newsThumbs';
import { buildStories } from '../utils/newsStories';
import { isInFiresFeed } from '../utils/newsRelevance';
import { sourceLogoUrl } from '../utils/newsSourceLogos';
import { REMOVED_NEWS_SOURCES } from '../config/newsSources';
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

/** GET /api/news/stories — headlines about the same fire, oldest first. */
router.get('/stories', rateLimit('news-stories', 60, 60_000), async (_req, res) => {
  try {
    const key = 'news:stories:v1';
    let data = await cacheService.get<unknown[]>(key);
    if (!data) {
      const { rows } = await pool.query(
        `SELECT id, title, source, source_url, COALESCE(published_at, created_at) AS published_at
           FROM news
          WHERE COALESCE(published_at, created_at) > NOW() - INTERVAL '120 days'
            AND source <> ALL($1::text[])
          ORDER BY 4 DESC
          LIMIT 500`,
        [REMOVED_NEWS_SOURCES]
      );
      data = buildStories(rows.filter(isInFiresFeed).map((r: any) => ({ ...r, published_at: new Date(r.published_at) }))).map((s) => ({
        ...s,
        items: s.items.map((i) => ({ ...i, source_logo_url: sourceLogoUrl(i.source) })),
      }));
      await cacheService.set(key, data, 600);
    }
    res.json({ status: 'success', data });
  } catch (error) {
    console.error('news stories failed:', (error as Error).message);
    res.status(503).json({ status: 'error', code: 'stories_unavailable' });
  }
});

/** GET /api/news/thumb/:province/:date — NASA picture of the province that day. */
router.get('/thumb/:province/:date', rateLimit('news-thumb', 120, 60_000), async (req, res) => {
  const date = String(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).getTime() > Date.now()) {
    res.status(400).json({ status: 'error', code: 'bad_date' });
    return;
  }
  try {
    const { rows } = await pool.query('SELECT id, lat, lng FROM turkey_cities WHERE name = $1 LIMIT 1', [String(req.params.province)]);
    if (rows.length === 0) {
      res.status(404).json({ status: 'error', code: 'unknown_province' });
      return;
    }
    const image = await provinceThumb(String(rows[0].id), Number(rows[0].lat), Number(rows[0].lng), date);
    if (!image) {
      res.status(404).json({ status: 'error', code: 'no_image' });
      return;
    }
    res.set('Cache-Control', 'public, max-age=2592000, immutable');
    res.type('jpeg').send(image);
  } catch (error) {
    console.error('news thumb failed:', (error as Error).message);
    res.status(503).json({ status: 'error', code: 'thumb_unavailable' });
  }
});

// GET /api/news/:id - Get single news
router.get('/:id', (req, res) => newsController.getNewsById(req, res));

export default router;