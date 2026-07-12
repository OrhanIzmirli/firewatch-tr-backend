import { Request, Response } from 'express';
import pool from '../config/database';
import notificationService from '../services/notificationService';

class NotificationController {
  async subscribeToken(req: Request, res: Response): Promise<void> {
    try {
      const { token, device_info, latitude, longitude } = req.body;

      if (typeof token !== 'string' || token.length < 20 || token.length > 4096) {
        res.status(400).json({ status: 'error', message: 'Token is required' });
        return;
      }

      const lat = latitude === undefined || latitude === null ? null : Number(latitude);
      const lng = longitude === undefined || longitude === null ? null : Number(longitude);
      if ((lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) ||
          (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180))) {
        res.status(400).json({ status: 'error', message: 'Invalid coordinates' });
        return;
      }

      // COALESCE keeps whatever location is already on file when this call
      // doesn't supply one (e.g. the app-startup re-subscribe ping), but
      // still overwrites it with a fresh fix when one is supplied (e.g. the
      // "Start Auto Monitoring" flow) — previously the ON CONFLICT branch
      // only touched updated_at/is_active, so a re-subscribe with a new GPS
      // fix silently never reached latitude/longitude at all.
      await pool.query(
        `INSERT INTO fcm_tokens (token, device_name, device_type, latitude, longitude, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW())
         ON CONFLICT (token) DO UPDATE SET
           updated_at = NOW(),
           is_active = true,
           latitude = COALESCE(EXCLUDED.latitude, fcm_tokens.latitude),
           longitude = COALESCE(EXCLUDED.longitude, fcm_tokens.longitude)`,
        [token, typeof device_info === 'string' ? device_info.slice(0, 100) : 'FireWatch TR', 'android', lat, lng]
      );

      res.status(201).json({
        status: 'success',
        message: 'Device subscribed successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error in subscribeToken:', error);
      res.status(500).json({ status: 'error', message: 'Unable to subscribe device' });
    }
  }

  // Only touches columns confirmed present in every known schema revision
  // (token, is_active) — subscribeToken above references device_name/
  // device_type/updated_at, which aren't in schema.sql, implying the live
  // table was altered out-of-band; avoiding those keeps this safe regardless.
  async unsubscribeToken(req: Request, res: Response): Promise<void> {
    try {
      const { token } = req.body;

      if (typeof token !== 'string' || token.length < 20 || token.length > 4096) {
        res.status(400).json({ status: 'error', message: 'Token is required' });
        return;
      }

      await pool.query(`UPDATE fcm_tokens SET is_active = false WHERE token = $1`, [token]);

      res.json({
        status: 'success',
        message: 'Device unsubscribed successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error in unsubscribeToken:', error);
      res.status(500).json({ status: 'error', message: 'Unable to unsubscribe device' });
    }
  }

  // On/off toggle for an already-registered token. latitude/longitude are
  // optional — when supplied (e.g. a fresh fix from "Start Auto
  // Monitoring"), they're written too so region-targeted alerts have
  // somewhere to match against; when omitted, location is left untouched.
  async setActiveStatus(req: Request, res: Response): Promise<void> {
    try {
      const { token, is_active, latitude, longitude } = req.body;

      if (typeof token !== 'string' || token.length < 20 || token.length > 4096) {
        res.status(400).json({ status: 'error', message: 'Token is required' });
        return;
      }
      if (typeof is_active !== 'boolean') {
        res.status(400).json({ status: 'error', message: 'is_active must be a boolean' });
        return;
      }

      const lat = latitude === undefined || latitude === null ? null : Number(latitude);
      const lng = longitude === undefined || longitude === null ? null : Number(longitude);
      if ((lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) ||
          (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180))) {
        res.status(400).json({ status: 'error', message: 'Invalid coordinates' });
        return;
      }

      const result = await pool.query(
        `UPDATE fcm_tokens SET
           is_active = $2,
           latitude = COALESCE($3, latitude),
           longitude = COALESCE($4, longitude)
         WHERE token = $1 RETURNING token`,
        [token, is_active, lat, lng]
      );
      if (result.rowCount === 0) {
        res.status(404).json({ status: 'error', message: 'Token not registered' });
        return;
      }

      res.json({ status: 'success', message: 'Notification status updated' });
    } catch (error) {
      console.error('Error in setActiveStatus:', error);
      res.status(500).json({ status: 'error', message: 'Unable to update notification status' });
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
      res.status(500).json({ status: 'error', message: 'Unable to send notification' });
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
      res.status(500).json({ status: 'error', message: 'Unable to send notification' });
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
      res.status(500).json({ status: 'error', message: 'Unable to send notification' });
    }
  }
}

export default new NotificationController();
