import { Router, Request, Response } from 'express';
import pool from '../config/database';
import { rateLimit, requireAdminToken } from '../middleware/security';

const router = Router();

router.post('/', rateLimit('feedback-submit', 5, 60 * 60_000), async (req: Request, res: Response) => {
  const { rating, category, message, email, app_version } = req.body ?? {};
  const numericRating = Number(rating);
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ error: 'message is required' }); return;
  }
  if (message.trim().length > 4000) {
    res.status(400).json({ error: 'message is too long' }); return;
  }
  if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
    res.status(400).json({ error: 'rating must be between 1 and 5' }); return;
  }
  if (!['bug', 'feature', 'general'].includes(category)) {
    res.status(400).json({ error: 'invalid category' }); return;
  }
  const normalizedEmail = typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null;
  if (normalizedEmail && (normalizedEmail.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))) {
    res.status(400).json({ error: 'invalid email' }); return;
  }
  const appVersion = typeof app_version === 'string' ? app_version.trim() : '';
  if (appVersion.length > 20 || (appVersion && !/^[0-9A-Za-z.+_-]+$/.test(appVersion))) {
    res.status(400).json({ error: 'invalid app version' }); return;
  }
  try {
    const result = await pool.query(
      `INSERT INTO feedback (rating, category, message, email, app_version)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [numericRating, category, message.trim(), normalizedEmail, appVersion || null],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Feedback submission failed:', error);
    res.status(500).json({ error: 'Unable to save feedback' });
  }
});

router.get('/', requireAdminToken, async (req: Request, res: Response) => {
  try {
    const requestedLimit = Number.parseInt(String(req.query.limit || '100'), 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100;
    const result = await pool.query('SELECT * FROM feedback ORDER BY created_at DESC LIMIT $1', [limit]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Unable to load feedback' });
  }
});

export default router;
