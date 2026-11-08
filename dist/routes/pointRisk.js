"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pointRiskRouter = pointRiskRouter;
const express_1 = require("express");
const security_1 = require("../middleware/security");
const pointRisk_1 = require("../services/pointRisk");
const trackedPlaces_1 = require("../services/trackedPlaces");
/**
 * Risk at one point ("Konumum", a saved place). POST, so coordinates stay out
 * of URLs and therefore out of the access log.
 */
function pointRiskRouter(deps) {
    const router = (0, express_1.Router)();
    router.post('/point', (0, security_1.rateLimit)('risk-point', 120, 60 * 60000), async (req, res) => {
        const lat = Number(req.body?.latitude);
        const lng = Number(req.body?.longitude);
        if (req.body?.latitude == null || req.body?.longitude == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
            res.status(400).json({ status: 'error', code: 'invalid_point', message: 'latitude and longitude are required' });
            return;
        }
        if (!(0, trackedPlaces_1.isWithinTurkeyBbox)(lat, lng)) {
            res.status(422).json({ status: 'error', code: 'outside_turkey', message: 'The point must be in Turkey' });
            return;
        }
        try {
            res.json({ status: 'success', data: await (0, pointRisk_1.computePointRisk)(lat, lng, deps()) });
        }
        catch (error) {
            console.error('point risk failed:', error.message);
            res.status(503).json({ status: 'error', code: 'risk_unavailable', message: 'Risk is not available right now' });
        }
    });
    return router;
}
