import { Router } from 'express';
import notificationController from '../controllers/notificationController';
import { rateLimit, requireAdminToken } from '../middleware/security';

const router = Router();

// POST /api/notify/subscribe - Token subscribe et
router.post('/subscribe', rateLimit('notify-subscribe', 10, 60 * 60_000), (req, res) => notificationController.subscribeToken(req, res));

// POST /api/notify/send-token - Spesifik token'a gönder
router.post('/send-token', requireAdminToken, (req, res) => notificationController.sendToToken(req, res));

// POST /api/notify/send-location - Lokasyona göre gönder
router.post('/send-location', requireAdminToken, (req, res) => notificationController.sendByLocation(req, res));

// POST /api/notify/send-topic - Topic'e gönder
router.post('/send-topic', requireAdminToken, (req, res) => notificationController.sendToTopic(req, res));

export default router;
