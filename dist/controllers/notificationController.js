"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const database_1 = __importDefault(require("../config/database"));
const notificationService_1 = __importDefault(require("../services/notificationService"));
class NotificationController {
    async subscribeToken(req, res) {
        try {
            const { token, device_info, latitude, longitude } = req.body;
            if (!token) {
                res.status(400).json({ status: 'error', message: 'Token is required' });
                return;
            }
            await database_1.default.query(`INSERT INTO fcm_tokens (token, device_name, device_type, latitude, longitude, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW())
         ON CONFLICT (token) DO UPDATE SET updated_at = NOW(), is_active = true`, [token, device_info ?? 'FireWatch TR', 'android', latitude ?? null, longitude ?? null]);
            console.log('✅ FCM Token saved:', token.substring(0, 20) + '...');
            res.status(201).json({
                status: 'success',
                message: 'Device subscribed successfully',
                timestamp: new Date().toISOString(),
            });
        }
        catch (error) {
            console.error('Error in subscribeToken:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    }
    async sendByLocation(req, res) {
        try {
            const { title, body } = req.body;
            if (!title || !body) {
                res.status(400).json({ status: 'error', message: 'title, body required' });
                return;
            }
            const result = await database_1.default.query('SELECT token FROM fcm_tokens WHERE is_active = true LIMIT 500');
            const tokens = result.rows.map((r) => r.token);
            if (tokens.length === 0) {
                res.json({ status: 'success', message: 'No devices registered', sent: 0 });
                return;
            }
            const sent = await notificationService_1.default.sendToTokens(tokens, title, body);
            res.json({ status: 'success', message: `Sent to ${sent} devices`, sent });
        }
        catch (error) {
            console.error('Error in sendByLocation:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    }
    async sendToToken(req, res) {
        try {
            const { token, title, body, data } = req.body;
            if (!token || !title || !body) {
                res.status(400).json({ status: 'error', message: 'token, title, body required' });
                return;
            }
            const success = await notificationService_1.default.sendToToken(token, title, body, data);
            res.json({ status: success ? 'success' : 'error', message: success ? 'Sent' : 'Failed' });
        }
        catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    }
    async sendToTopic(req, res) {
        try {
            const { topic, title, body, data } = req.body;
            if (!topic || !title || !body) {
                res.status(400).json({ status: 'error', message: 'topic, title, body required' });
                return;
            }
            const success = await notificationService_1.default.sendToTopic(topic, title, body, data);
            res.json({ status: success ? 'success' : 'error', message: success ? 'Sent' : 'Failed' });
        }
        catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    }
}
exports.default = new NotificationController();
