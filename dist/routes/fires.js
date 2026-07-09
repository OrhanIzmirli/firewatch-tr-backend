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
// Turkey's bounding box. turkey_cities only contains Turkish cities, so
// PostGIS' "nearest" query happily returns e.g. Şırnak for a point in
// Greece or Cyprus — nearest doesn't mean close. Reject coordinates
// outside this box before ever querying the table, rather than returning
// a confidently wrong city.
const TURKEY_BBOX = { minLat: 35.8, maxLat: 42.2, minLng: 25.6, maxLng: 44.8 };
function isWithinTurkey(lat, lng) {
    return lat >= TURKEY_BBOX.minLat && lat <= TURKEY_BBOX.maxLat &&
        lng >= TURKEY_BBOX.minLng && lng <= TURKEY_BBOX.maxLng;
}
// GET /api/fires/nearest-city?lat=X&lng=Y
router.get('/nearest-city', async (req, res) => {
    try {
        const lat = parseFloat(req.query.lat);
        const lng = parseFloat(req.query.lng);
        if (isNaN(lat) || isNaN(lng)) {
            res.status(400).json({ status: 'error', message: 'lat and lng required' });
            return;
        }
        if (!isWithinTurkey(lat, lng)) {
            res.json({ status: 'success', data: { outsideTurkey: true, city: null, region: null, distance_km: null } });
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
            res.json({ status: 'success', data: { outsideTurkey: false, city: 'Türkiye', region: 'Türkiye' } });
            return;
        }
        const { name, region, distance_km } = result.rows[0];
        res.json({
            status: 'success',
            data: { outsideTurkey: false, city: name, region, distance_km: Math.round(distance_km) },
        });
    }
    catch (error) {
        console.error('nearest-city error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});
// GET /api/fires/reports — Raporları listele
router.get('/reports', async (req, res) => {
    try {
        const result = await database_1.default.query(`SELECT id, title, description, latitude, longitude,
              reporter_name, status, verified, photo_urls, created_at
       FROM fire_reports
       ORDER BY created_at DESC
       LIMIT 50`);
        res.json({ status: 'success', data: result.rows });
    }
    catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});
// A report photo arrives from the client either as a raw base64 string or
// already wrapped in a data URI (data:image/jpeg;base64,...). Normalizes to
// the latter so every stored value is directly renderable, and rejects
// anything that isn't plausibly an image so a bad payload fails loudly here
// rather than silently corrupting the column.
const MAX_PHOTOS_PER_REPORT = 5;
const DATA_URI_PATTERN = /^data:image\/(jpeg|jpg|png|webp|heic);base64,/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
function normalizePhotos(photos) {
    if (photos === undefined || photos === null)
        return [];
    if (!Array.isArray(photos)) {
        throw new Error('photos must be an array of base64 strings');
    }
    if (photos.length > MAX_PHOTOS_PER_REPORT) {
        throw new Error(`photos cannot exceed ${MAX_PHOTOS_PER_REPORT} items`);
    }
    return photos.map((photo, index) => {
        if (typeof photo !== 'string' || photo.length === 0) {
            throw new Error(`photos[${index}] must be a non-empty base64 string`);
        }
        if (DATA_URI_PATTERN.test(photo)) {
            return photo;
        }
        if (BASE64_PATTERN.test(photo)) {
            return `data:image/jpeg;base64,${photo}`;
        }
        throw new Error(`photos[${index}] is not valid base64 image data`);
    });
}
// POST /api/fires/report — Yangın raporu gönder
router.post('/report', async (req, res) => {
    try {
        const { title, description, latitude, longitude, reporter_name, reporter_phone, photos } = req.body;
        if (!latitude || !longitude) {
            res.status(400).json({ status: 'error', message: 'Koordinat zorunlu' });
            return;
        }
        let photoUrls;
        try {
            photoUrls = normalizePhotos(photos);
        }
        catch (validationError) {
            res.status(400).json({ status: 'error', message: validationError.message });
            return;
        }
        // Aynı konumdan (500m) son 2 saat içinde rapor var mı? — spam/duplicate koruması
        const duplicateResult = await database_1.default.query(`SELECT COUNT(*) as count FROM fire_reports
       WHERE ST_DWithin(
         ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
         ST_SetSRID(ST_MakePoint(longitude::float, latitude::float), 4326)::geography,
         500
       )
       AND created_at > NOW() - INTERVAL '2 hours'`, [longitude, latitude]);
        const duplicateCount = parseInt(duplicateResult.rows[0]?.count ?? '0');
        if (duplicateCount > 0) {
            res.status(429).json({
                status: 'error',
                code: 'duplicate_location',
                message: 'A report has already been sent from this location. Please wait for authorities to respond.',
            });
            return;
        }
        // En yakın şehri bul
        const cityResult = await database_1.default.query(`SELECT name, region FROM turkey_cities
       ORDER BY location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326) LIMIT 1`, [longitude, latitude]);
        const city = cityResult.rows[0]?.name ?? 'Bilinmiyor';
        const region = cityResult.rows[0]?.region ?? 'Türkiye';
        // NASA ile doğrulama — 10km içinde termal nokta var mı?
        // fires tablosunda PostGIS geometry varsa kullan, yoksa basit hesap
        let verified = false;
        let nasaCount = 0;
        try {
            const nasaResult = await database_1.default.query(`SELECT COUNT(*) as count FROM fires
         WHERE ST_DWithin(
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
           ST_SetSRID(ST_MakePoint(longitude::float, latitude::float), 4326)::geography,
           10000
         )`, [longitude, latitude]);
            nasaCount = parseInt(nasaResult.rows[0]?.count ?? '0');
            verified = nasaCount > 0;
        }
        catch (_) {
            // fires tablosunda geometry yoksa doğrulama atla
            verified = false;
        }
        const result = await database_1.default.query(`INSERT INTO fire_reports
        (title, description, latitude, longitude, reporter_name,
         reporter_phone, status, verified, photo_urls, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       RETURNING id, created_at`, [
            title ?? `${city} yangın bildirimi`,
            description ?? '',
            latitude,
            longitude,
            reporter_name ?? 'Anonim',
            reporter_phone ?? '',
            'pending',
            verified,
            photoUrls,
        ]);
        res.json({
            status: 'success',
            data: {
                id: result.rows[0].id,
                city,
                region,
                verified,
                photo_count: photoUrls.length,
                created_at: result.rows[0].created_at,
                nasa_nearby: nasaCount,
                message: verified
                    ? '✅ NASA verisiyle doğrulandı — bölgede termal aktivite mevcut'
                    : '⏳ Rapor alındı — NASA eşleşmesi yok, manuel inceleme bekliyor',
            },
        });
    }
    catch (error) {
        console.error('Report error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});
// GET /api/fires/:id - Get single fire
router.get('/:id', (req, res) => fireController_1.default.getFireById(req, res));
// POST /api/fires - Create fire
router.post('/', (req, res) => fireController_1.default.createFire(req, res));
exports.default = router;
