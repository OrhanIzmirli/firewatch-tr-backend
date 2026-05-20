import { Router } from 'express';
import notificationController from '../controllers/notificationController';

const router = Router();

// POST /api/notify/subscribe - Token subscribe et
router.post('/subscribe', (req, res) => notificationController.subscribeToken(req, res));

// POST /api/notify/send-token - Spesifik token'a gönder
router.post('/send-token', (req, res) => notificationController.sendToToken(req, res));

// POST /api/notify/send-location - Lokasyona göre gönder
router.post('/send-location', (req, res) => notificationController.sendByLocation(req, res));

// POST /api/notify/send-topic - Topic'e gönder
router.post('/send-topic', (req, res) => notificationController.sendToTopic(req, res));

export default router;