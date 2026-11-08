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
// GET /api/news/:id - Get single news
router.get('/:id', (req, res) => newsController_1.default.getNewsById(req, res));
exports.default = router;
