"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const fireController_1 = __importDefault(require("../controllers/fireController"));
const database_1 = __importDefault(require("../config/database"));
const router = (0, express_1.Router)();
// GET /api/fires - Get all fires
router.get('/', (req, res) => fireController_1.default.getAllFires(req, res));
// GET /api/fires/nearest-city?lat=X&lng=Y
router.get('/nearest-city', async (req, res) => {
    try {
        const lat = parseFloat(req.query.lat);
        const lng = parseFloat(req.query.lng);
        if (isNaN(lat) || isNaN(lng)) {
            res.status(400).json({ status: 'error', message: 'lat and lng required' });
            return;
        }
        const result = await database_1.default.query(`SELECT name, region,
        ST_Distance(
          location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) / 1000 AS distance_km
       FROM turkey_cities
       ORDER BY location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
       LIMIT 1`, [lng, lat]);
        if (result.rows.length === 0) {
            res.json({ status: 'success', data: { city: 'Türkiye', region: 'Türkiye' } });
            return;
        }
        const { name, region, distance_km } = result.rows[0];
        res.json({
            status: 'success',
            data: {
                city: name,
                region,
                distance_km: Math.round(distance_km),
            },
        });
    }
    catch (error) {
        console.error('nearest-city error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});
// GET /api/fires/:id - Get single fire
router.get('/:id', (req, res) => fireController_1.default.getFireById(req, res));
// POST /api/fires - Create fire
router.post('/', (req, res) => fireController_1.default.createFire(req, res));
exports.default = router;
