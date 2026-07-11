"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("firebase-admin/app");
const messaging_1 = require("firebase-admin/messaging");
// Firebase initialization - Base64 env variable'dan oku
try {
    const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (base64) {
        const serviceAccount = JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
        if ((0, app_1.getApps)().length === 0) {
            (0, app_1.initializeApp)({
                credential: (0, app_1.cert)(serviceAccount),
                databaseURL: process.env.FIREBASE_DATABASE_URL,
            });
        }
        console.log('✅ Firebase initialized');
    }
    else {
        console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT_BASE64 not found - Firebase disabled');
    }
}
catch (error) {
    console.error('❌ Firebase initialization error:', error);
}
class NotificationService {
    async sendToToken(token, title, body, data) {
        try {
            const message = {
                notification: { title, body },
                data: data || {},
                token,
            };
            const response = await (0, messaging_1.getMessaging)().send(message);
            console.log('✅ Message sent:', response);
            return true;
        }
        catch (error) {
            console.error('❌ Error sending message:', error);
            return false;
        }
    }
    async sendToTokens(tokens, title, body, data) {
        try {
            const response = await (0, messaging_1.getMessaging)().sendEachForMulticast({
                tokens,
                notification: { title, body },
                data: data || {},
            });
            console.log(`✅ Sent to ${response.successCount} devices`);
            return response.successCount;
        }
        catch (error) {
            console.error('❌ Error sending multicast:', error);
            return 0;
        }
    }
    async sendToTopic(topic, title, body, data) {
        try {
            const message = {
                notification: { title, body },
                data: data || {},
                topic,
            };
            const response = await (0, messaging_1.getMessaging)().send(message);
            console.log('✅ Message sent to topic:', response);
            return true;
        }
        catch (error) {
            console.error('❌ Error sending to topic:', error);
            return false;
        }
    }
}
exports.default = new NotificationService();
