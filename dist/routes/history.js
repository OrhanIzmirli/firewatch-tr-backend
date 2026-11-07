"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = __importDefault(require("../config/database"));
const provinces_1 = require("../services/provinces");
const cacheService_1 = __importDefault(require("../services/cacheService"));
const security_1 = require("../middleware/security");
const fireHistory_1 = require("../services/fireHistory");
const router = (0, express_1.Router)();
/** Incidents only change while burning; past days are settled. */
const CACHE_TTL_SECONDS = 1800;
/**
 * GET /api/history?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * GeoJSON FeatureCollection of past satellite-detected fires for the app's
 * history screen (FIRE_HISTORY_URL). See services/fireHistory.ts for what
 * the geometry and every property mean, and what they do not.
 */
router.get('/', (0, security_1.rateLimit)('history', 30, 60000), async (req, res) => {
    const range = (0, fireHistory_1.parseHistoryRange)(req.query);
    if ('error' in range) {
        res.status(400).json({ status: 'error', message: range.error });
        return;
    }
    try {
        // v3: provinces from the province polygons (migration 015).
        const usePolygons = await (0, provinces_1.provincePolygonsAvailable)(database_1.default);
        const cacheKey = `history:v3:${usePolygons ? 'p' : 'c'}:${range.from}:${range.to}`;
        const cached = await cacheService_1.default.get(cacheKey);
        if (cached) {
            res.set('Cache-Control', 'public, max-age=900');
            res.set('X-Cache', 'HIT');
            res.json(cached);
            return;
        }
        const [rows, coverage] = await Promise.all([
            database_1.default.query((0, fireHistory_1.historySql)(usePolygons), [range.from, range.to, fireHistory_1.HISTORY_MIN_DETECTIONS]),
            database_1.default.query(`SELECT to_char(min(first_detected_at) AT TIME ZONE '${fireHistory_1.HISTORY_TIME_ZONE}', 'YYYY-MM-DD') AS d
           FROM fire_incidents`),
        ]);
        const payload = (0, fireHistory_1.toHistoryCollection)(rows.rows, range, coverage.rows[0]?.d ?? null);
        await cacheService_1.default.set(cacheKey, payload, CACHE_TTL_SECONDS);
        res.set('Cache-Control', 'public, max-age=900');
        res.set('X-Cache', 'MISS');
        res.json(payload);
    }
    catch (error) {
        console.error('History error:', error);
        res.status(500).json({ status: 'error', message: 'Fire history unavailable' });
    }
});
exports.default = router;
