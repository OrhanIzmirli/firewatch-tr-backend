import { Request, Response } from 'express';
import notificationService from '../services/notificationService';
import { ApiResponse } from '../types';

class NotificationController {
  // Subscribe token (Cihazı kaydet)
  async subscribeToken(req: Request, res: Response): Promise<void> {
    try {
      const { token, latitude, longitude } = req.body;

      if (!token) {
        res.status(400).json({
          status: 'error',
          message: 'Token is required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // TODO: Database'e kaydet (fcm_tokens tablosu)
      console.log('✅ Token subscribed:', token);

      res.status(201).json({
        status: 'success',
        message: 'Device subscribed successfully',
        data: { token, latitude, longitude },
        timestamp: new Date().toISOString(),
      } as ApiResponse<any>);
    } catch (error) {
      console.error('Error in subscribeToken:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to subscribe',
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Send notification by location
  async sendByLocation(req: Request, res: Response): Promise<void> {
    try {
      const { latitude, longitude, radius, title, body } = req.body;

      if (!latitude || !longitude || !title || !body) {
        res.status(400).json({
          status: 'error',
          message: 'latitude, longitude, title, body required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // TODO: Database'den koordinatlara yakın cihazları bul
      // TODO: Hepsine notification gönder

      res.json({
        status: 'success',
        message: 'Notification sent by location',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error in sendByLocation:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to send notification',
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Send to specific token
  async sendToToken(req: Request, res: Response): Promise<void> {
    try {
      const { token, title, body, data } = req.body;

      if (!token || !title || !body) {
        res.status(400).json({
          status: 'error',
          message: 'token, title, body required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const success = await notificationService.sendToToken(token, title, body, data);

      res.json({
        status: success ? 'success' : 'error',
        message: success ? 'Notification sent' : 'Failed to send',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error in sendToToken:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to send notification',
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Send to topic
  async sendToTopic(req: Request, res: Response): Promise<void> {
    try {
      const { topic, title, body, data } = req.body;

      if (!topic || !title || !body) {
        res.status(400).json({
          status: 'error',
          message: 'topic, title, body required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const success = await notificationService.sendToTopic(topic, title, body, data);

      res.json({
        status: success ? 'success' : 'error',
        message: success ? 'Notification sent to topic' : 'Failed to send',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error in sendToTopic:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to send notification',
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

export default new NotificationController();