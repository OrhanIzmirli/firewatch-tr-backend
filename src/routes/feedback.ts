import { Router, Request, Response } from 'express';
import pool from '../config/database';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const { rating, category, message, email, app_version } = req.body ?? {};
  const numericRating = Number(rating);
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ error: 'message is required' }); return;
  }
  if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
    res.status(400).json({ error: 'rating must be between 1 and 5' }); return;
  }
  if (!['bug', 'feature', 'general'].includes(category)) {
    res.status(400).json({ error: 'invalid category' }); return;
  }
  try {
    const result = await pool.query(
      `INSERT INTO feedback (rating, category, message, email, app_version)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [numericRating, category, message.trim(), email || null, app_version || null],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Feedback submission failed:', error);
    res.status(500).json({ error: 'Unable to save feedback' });
  }
});

router.get('/', async (req: Request, res: Response) => {
  const adminToken = process.env.ADMIN_TOKEN;
  const supplied = req.header('x-admin-token') || req.query.token;
  if (!adminToken) { res.status(503).json({ error: 'Admin endpoint disabled' }); return; }
  if (supplied !== adminToken) { res.status(401).json({ error: 'Invalid or missing token' }); return; }
  try {
    const result = await pool.query('SELECT * FROM feedback ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Unable to load feedback' });
  }
});

export default router;
