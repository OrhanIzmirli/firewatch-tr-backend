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
// POST /api/notify/send-token - Spesifik token'a gönder
router.post('/send-token', security_1.requireAdminToken, (req, res) => notificationController_1.default.sendToToken(req, res));
// POST /api/notify/send-location - Lokasyona göre gönder
router.post('/send-location', security_1.requireAdminToken, (req, res) => notificationController_1.default.sendByLocation(req, res));
// POST /api/notify/send-topic - Topic'e gönder
router.post('/send-topic', security_1.requireAdminToken, (req, res) => notificationController_1.default.sendToTopic(req, res));
exports.default = router;
