"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = __importDefault(require("../config/database"));
const newsController_1 = __importDefault(require("../controllers/newsController"));
const security_1 = require("../middleware/security");
const cacheService_1 = __importDefault(require("../services/cacheService"));
const relatedNews_1 = require("../services/relatedNews");
const newsThumbs_1 = require("../services/newsThumbs");
const newsStories_1 = require("../utils/newsStories");
const newsRelevance_1 = require("../utils/newsRelevance");
const newsSourceLogos_1 = require("../utils/newsSourceLogos");
const newsSources_1 = require("../config/newsSources");
const router = (0, express_1.Router)();
// GET /api/news - Get all news
router.get('/', (req, res) => newsController_1.default.getAllNews(req, res));
/**
 * GET /api/news/related?city=&from=&to=&limit= — forest-fire stories about
 * one province (or, without city, anywhere) in a date range. An empty list
 * is a normal answer; the app then shows nothing.
 */
router.get('/related', (0, security_1.rateLimit)('news-related', 120, 60000), async (req, res) => {
    const city = typeof req.query.city === 'string' && req.query.city.trim() ? req.query.city.trim().slice(0, 40) : null;
    const to = new Date(String(req.query.to ?? ''));
    const from = new Date(String(req.query.from ?? ''));
    const end = Number.isNaN(to.getTime()) ? new Date() : to;
    const start = Number.isNaN(from.getTime()) ? new Date(end.getTime() - 7 * 86400000) : from;
    const limit = Math.min(10, Math.max(1, Number(req.query.limit) || 3));
    try {
        const key = `news:related:v1:${city ?? '*'}:${start.toISOString().slice(0, 13)}:${end.toISOString().slice(0, 13)}:${limit}`;
        let data = await cacheService_1.default.get(key);
        if (!data) {
            data = await (0, relatedNews_1.relatedNews)(database_1.default, city, start, end, limit);
            await cacheService_1.default.set(key, data, 600);
        }
        res.json({ status: 'success', data });
    }
    catch (error) {
        console.error('related news failed:', error.message);
        res.status(503).json({ status: 'error', code: 'related_unavailable' });
    }
});
/** GET /api/news/stories — headlines about the same fire, oldest first. */
router.get('/stories', (0, security_1.rateLimit)('news-stories', 60, 60000), async (_req, res) => {
    try {
        const key = 'news:stories:v1';
        let data = await cacheService_1.default.get(key);
        if (!data) {
            const { rows } = await database_1.default.query(`SELECT id, title, source, source_url, COALESCE(published_at, created_at) AS published_at
           FROM news
          WHERE COALESCE(published_at, created_at) > NOW() - INTERVAL '120 days'
            AND source <> ALL($1::text[])
          ORDER BY 4 DESC
          LIMIT 500`, [newsSources_1.REMOVED_NEWS_SOURCES]);
            data = (0, newsStories_1.buildStories)(rows.filter(newsRelevance_1.isInFiresFeed).map((r) => ({ ...r, published_at: new Date(r.published_at) }))).map((s) => ({
                ...s,
                items: s.items.map((i) => ({ ...i, source_logo_url: (0, newsSourceLogos_1.sourceLogoUrl)(i.source) })),
            }));
            await cacheService_1.default.set(key, data, 600);
        }
        res.json({ status: 'success', data });
    }
    catch (error) {
        console.error('news stories failed:', error.message);
        res.status(503).json({ status: 'error', code: 'stories_unavailable' });
    }
});
/** GET /api/news/thumb/:province/:date — NASA picture of the province that day. */
router.get('/thumb/:province/:date', (0, security_1.rateLimit)('news-thumb', 120, 60000), async (req, res) => {
    const date = String(req.params.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).getTime() > Date.now()) {
        res.status(400).json({ status: 'error', code: 'bad_date' });
        return;
    }
    try {
        const { rows } = await database_1.default.query('SELECT id, lat, lng FROM turkey_cities WHERE name = $1 LIMIT 1', [String(req.params.province)]);
        if (rows.length === 0) {
            res.status(404).json({ status: 'error', code: 'unknown_province' });
            return;
        }
        const image = await (0, newsThumbs_1.provinceThumb)(String(rows[0].id), Number(rows[0].lat), Number(rows[0].lng), date);
        if (!image) {
            res.status(404).json({ status: 'error', code: 'no_image' });
            return;
        }
        res.set('Cache-Control', 'public, max-age=2592000, immutable');
        res.type('jpeg').send(image);
    }
    catch (error) {
        console.error('news thumb failed:', error.message);
        res.status(503).json({ status: 'error', code: 'thumb_unavailable' });
    }
});
// GET /api/news/:id - Get single news
router.get('/:id', (req, res) => newsController_1.default.getNewsById(req, res));
exports.default = router;
