import { Request, Response } from 'express';
import pool from '../config/database';
import notificationService from '../services/notificationService';

class NotificationController {
  async subscribeToken(req: Request, res: Response): Promise<void> {
    try {
      const { token, device_info, latitude, longitude } = req.body;

      if (!token) {
        res.status(400).json({ status: 'error', message: 'Token is required' });
        return;
      }

      await pool.query(
        `INSERT INTO fcm_tokens (token, device_name, device_type, latitude, longitude, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW())
         ON CONFLICT (token) DO UPDATE SET updated_at = NOW(), is_active = true`,
        [token, device_info ?? 'FireWatch TR', 'android', latitude ?? null, longitude ?? null]
      );

      console.log('✅ FCM Token saved:', token.substring(0, 20) + '...');

      res.status(201).json({
        status: 'success',
        message: 'Device subscribed successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error in subscribeToken:', error);
      res.status(500).json({ status: 'error', message: (error as Error).message });
    }
  }

  async sendByLocation(req: Request, res: Response): Promise<void> {
    try {
      const { title, body } = req.body;

      if (!title || !body) {
        res.status(400).json({ status: 'error', message: 'title, body required' });
        return;
      }

      const result = await pool.query(
        'SELECT token FROM fcm_tokens WHERE is_active = true LIMIT 500'
      );
      const tokens = result.rows.map((r: any) => r.token);

      if (tokens.length === 0) {
        res.json({ status: 'success', message: 'No devices registered', sent: 0 });
        return;
      }

      const sent = await notificationService.sendToTokens(tokens, title, body);
      res.json({ status: 'success', message: `Sent to ${sent} devices`, sent });
    } catch (error) {
      console.error('Error in sendByLocation:', error);
      res.status(500).json({ status: 'error', message: (error as Error).message });
    }
  }

  async sendToToken(req: Request, res: Response): Promise<void> {
    try {
      const { token, title, body, data } = req.body;

      if (!token || !title || !body) {
        res.status(400).json({ status: 'error', message: 'token, title, body required' });
        return;
      }

      const success = await notificationService.sendToToken(token, title, body, data);
      res.json({ status: success ? 'success' : 'error', message: success ? 'Sent' : 'Failed' });
    } catch (error) {
      res.status(500).json({ status: 'error', message: (error as Error).message });
    }
  }

  async sendToTopic(req: Request, res: Response): Promise<void> {
    try {
      const { topic, title, body, data } = req.body;

      if (!topic || !title || !body) {
        res.status(400).json({ status: 'error', message: 'topic, title, body required' });
        return;
      }

      const success = await notificationService.sendToTopic(topic, title, body, data);
      res.json({ status: success ? 'success' : 'error', message: success ? 'Sent' : 'Failed' });
    } catch (error) {
      res.status(500).json({ status: 'error', message: (error as Error).message });
    }
  }
}

export default new NotificationController();