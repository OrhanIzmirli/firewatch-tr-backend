"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const express_1 = require("express");
const cacheService_1 = __importDefault(require("../services/cacheService"));
const security_1 = require("../middleware/security");
const router = (0, express_1.Router)();
const TURKEY_AREA = '25,35,45,43';
const FIRMS_BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
function hasData(csv) {
    return csv.trim().split(/\r?\n/).filter(Boolean).length > 1;
}
router.get('/', (0, security_1.rateLimit)('thermal', 60, 60000), async (_req, res) => {
    const cached = await cacheService_1.default.get('thermal:turkey:current');
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
            const response = await axios_1.default.get(url, { timeout: 20000, responseType: 'text' });
            const csv = response.data;
            if (!hasData(csv))
                continue;
            const payload = { csv, ...attempt, fetchedAt: new Date().toISOString() };
            await cacheService_1.default.set('thermal:turkey:current', payload, 300);
            res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
            res.setHeader('X-Data-Source', `${attempt.product}/${attempt.days}`);
            res.type('text/csv').send(csv);
            return;
        }
        res.status(503).json({ status: 'error', message: 'No current thermal data available' });
    }
    catch (error) {
        console.error('Thermal proxy failed:', error.message);
        res.status(502).json({ status: 'error', message: 'Thermal provider unavailable' });
    }
});
exports.default = router;
