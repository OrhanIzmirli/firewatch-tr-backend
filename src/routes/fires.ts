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
      data: {
        city: name,
        region,
        distance_km: Math.round(distance_km),
      },
    });
  } catch (error) {
    console.error('nearest-city error:', error);
    res.status(500).json({ status: 'error', message: (error as Error).message });
  }
});

// GET /api/fires/:id - Get single fire
router.get('/:id', (req, res) => fireController.getFireById(req, res));

// POST /api/fires - Create fire
router.post('/', (req, res) => fireController.createFire(req, res));

export default router;