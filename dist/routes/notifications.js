"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const notificationController_1 = __importDefault(require("../controllers/notificationController"));
const security_1 = require("../middleware/security");
const router = (0, express_1.Router)();
// POST /api/notify/subscribe - Token subscribe et
router.post('/subscribe', (0, security_1.rateLimit)('notify-subscribe', 10, 60 * 60000), (req, res) => notificationController_1.default.subscribeToken(req, res));
// POST /api/notify/unsubscribe - Kullanıcı bildirimleri kapattığında token'ı pasifleştir
router.post('/unsubscribe', (0, security_1.rateLimit)('notify-unsubscribe', 10, 60 * 60000), (req, res) => notificationController_1.default.unsubscribeToken(req, res));
// PATCH /api/notify/subscribe - Konum güncellemeden is_active aç/kapat
router.patch('/subscribe', (0, security_1.rateLimit)('notify-subscribe-patch', 20, 60 * 60000), (req, res) => notificationController_1.default.setActiveStatus(req, res));
// GET /api/notify/cities - Kapsam seçici için il listesi (81 il, region_key ile)
router.get('/cities', (0, security_1.rateLimit)('notify-cities', 30, 60000), (req, res) => notificationController_1.default.listCities(req, res));
// POST /api/notify/send-token - Spesifik token'a gönder
router.post('/send-token', security_1.requireAdminToken, (req, res) => notificationController_1.default.sendToToken(req, res));
// POST /api/notify/send-location - Lokasyona göre gönder
router.post('/send-location', security_1.requireAdminToken, (req, res) => notificationController_1.default.sendByLocation(req, res));
// POST /api/notify/send-topic - Topic'e gönder
router.post('/send-topic', security_1.requireAdminToken, (req, res) => notificationController_1.default.sendToTopic(req, res));
exports.default = router;
