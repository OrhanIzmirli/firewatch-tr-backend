import { Router, Request, Response } from 'express';
import fireController from '../controllers/fireController';
import pool from '../config/database';

const router = Router();

// GET /api/fires - Get all fires
router.get('/', (req, res) => fireController.getAllFires(req, res));

// GET /api/fires/nearest-city?lat=X&lng=Y
router.get('/nearest-city', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);

    if (isNaN(lat) || isNaN(lng)) {
      res.status(400).json({ status: 'error', message: 'lat and lng required' });
      return;
    }

    const result = await pool.query(
      `SELECT name, region,
        ST_Distance(
          location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) / 1000 AS distance_km
       FROM turkey_cities
       ORDER BY location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
       LIMIT 1`,
      [lng, lat]
    );

    if (result.rows.length === 0) {
      res.json({ status: 'success', data: { city: 'Türkiye', region: 'Türkiye' } });
      return;
    }

    const { name, region, distance_km } = result.rows[0];
    res.json({
      status: 'success',
      data: { city: name, region, distance_km: Math.round(distance_km) },
    });
  } catch (error) {
    console.error('nearest-city error:', error);
    res.status(500).json({ status: 'error', message: (error as Error).message });
  }
});

// GET /api/fires/reports — Raporları listele
router.get('/reports', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, title, description, latitude, longitude,
              reporter_name, status, verified, created_at
       FROM fire_reports
       ORDER BY created_at DESC
       LIMIT 50`
    );
    res.json({ status: 'success', data: result.rows });
  } catch (error) {
    res.status(500).json({ status: 'error', message: (error as Error).message });
  }
});

// POST /api/fires/report — Yangın raporu gönder
router.post('/report', async (req: Request, res: Response) => {
  try {
    const { title, description, latitude, longitude, reporter_name, reporter_phone } = req.body;

    if (!latitude || !longitude) {
      res.status(400).json({ status: 'error', message: 'Koordinat zorunlu' });
      return;
    }

    // En yakın şehri bul
    const cityResult = await pool.query(
      `SELECT name, region FROM turkey_cities
       ORDER BY location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326) LIMIT 1`,
      [longitude, latitude]
    );
    const city = cityResult.rows[0]?.name ?? 'Bilinmiyor';
    const region = cityResult.rows[0]?.region ?? 'Türkiye';

    // NASA ile doğrulama — 10km içinde termal nokta var mı?
    // fires tablosunda PostGIS geometry varsa kullan, yoksa basit hesap
    let verified = false;
    let nasaCount = 0;
    try {
      const nasaResult = await pool.query(
        `SELECT COUNT(*) as count FROM fires
         WHERE ST_DWithin(
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
           ST_SetSRID(ST_MakePoint(longitude::float, latitude::float), 4326)::geography,
           10000
         )`,
        [longitude, latitude]
      );
      nasaCount = parseInt(nasaResult.rows[0]?.count ?? '0');
      verified = nasaCount > 0;
    } catch (_) {
      // fires tablosunda geometry yoksa doğrulama atla
      verified = false;
    }

    const result = await pool.query(
      `INSERT INTO fire_reports
        (title, description, latitude, longitude, reporter_name,
         reporter_phone, status, verified, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       RETURNING id`,
      [
        title ?? `${city} yangın bildirimi`,
        description ?? '',
        latitude,
        longitude,
        reporter_name ?? 'Anonim',
        reporter_phone ?? '',
        'pending',
        verified,
      ]
    );

    res.json({
      status: 'success',
      data: {
        id: result.rows[0].id,
        city,
        region,
        verified,
        nasa_nearby: nasaCount,
        message: verified
          ? '✅ NASA verisiyle doğrulandı — bölgede termal aktivite mevcut'
          : '⏳ Rapor alındı — NASA eşleşmesi yok, manuel inceleme bekliyor',
      },
    });
  } catch (error) {
    console.error('Report error:', error);
    res.status(500).json({ status: 'error', message: (error as Error).message });
  }
});

// GET /api/fires/:id - Get single fire
router.get('/:id', (req, res) => fireController.getFireById(req, res));

// POST /api/fires - Create fire
router.post('/', (req, res) => fireController.createFire(req, res));

export default router;