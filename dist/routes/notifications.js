"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const notificationController_1 = __importDefault(require("../controllers/notificationController"));
const router = (0, express_1.Router)();
// POST /api/notify/subscribe - Token subscribe et
router.post('/subscribe', (req, res) => notificationController_1.default.subscribeToken(req, res));
// POST /api/notify/send-token - Spesifik token'a gönder
router.post('/send-token', (req, res) => notificationController_1.default.sendToToken(req, res));
// POST /api/notify/send-location - Lokasyona göre gönder
router.post('/send-location', (req, res) => notificationController_1.default.sendByLocation(req, res));
// POST /api/notify/send-topic - Topic'e gönder
router.post('/send-topic', (req, res) => notificationController_1.default.sendToTopic(req, res));
exports.default = router;
