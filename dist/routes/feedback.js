"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = __importDefault(require("../config/database"));
const security_1 = require("../middleware/security");
const router = (0, express_1.Router)();
router.post('/', (0, security_1.rateLimit)('feedback-submit', 5, 60 * 60000), async (req, res) => {
    const { rating, category, message, email, app_version } = req.body ?? {};
    const numericRating = Number(rating);
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
        res.status(400).json({ error: 'message is required' });
        return;
    }
    if (message.trim().length > 4000) {
        res.status(400).json({ error: 'message is too long' });
        return;
    }
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
        res.status(400).json({ error: 'rating must be between 1 and 5' });
        return;
    }
    if (!['bug', 'feature', 'general'].includes(category)) {
        res.status(400).json({ error: 'invalid category' });
        return;
    }
    const normalizedEmail = typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null;
    if (normalizedEmail && (normalizedEmail.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))) {
        res.status(400).json({ error: 'invalid email' });
        return;
    }
    const appVersion = typeof app_version === 'string' ? app_version.trim() : '';
    if (appVersion.length > 20 || (appVersion && !/^[0-9A-Za-z.+_-]+$/.test(appVersion))) {
        res.status(400).json({ error: 'invalid app version' });
        return;
    }
    try {
        const result = await database_1.default.query(`INSERT INTO feedback (rating, category, message, email, app_version)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`, [numericRating, category, message.trim(), normalizedEmail, appVersion || null]);
        res.status(201).json(result.rows[0]);
    }
    catch (error) {
        console.error('Feedback submission failed:', error);
        res.status(500).json({ error: 'Unable to save feedback' });
    }
});
router.get('/', security_1.requireAdminToken, async (req, res) => {
    try {
        const requestedLimit = Number.parseInt(String(req.query.limit || '100'), 10);
        const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100;
        const result = await database_1.default.query('SELECT * FROM feedback ORDER BY created_at DESC LIMIT $1', [limit]);
        res.json(result.rows);
    }
    catch (error) {
        res.status(500).json({ error: 'Unable to load feedback' });
    }
});
exports.default = router;
