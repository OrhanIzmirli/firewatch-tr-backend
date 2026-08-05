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
/** FCM's hard per-call limit for sendEachForMulticast. */
const FCM_MULTICAST_LIMIT = 500;
function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size)
        out.push(items.slice(i, i + size));
    return out;
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
    // FCM caps sendEachForMulticast at 500 tokens per call. Callers used to work
    // around that with `LIMIT 500` on the token query, which silently dropped
    // every device past the 500th. Chunking here fixes it for every caller at
    // once: pass the full token list, all of it gets delivered.
    async sendToTokens(tokens, title, body, data) {
        const chunks = chunk(tokens, FCM_MULTICAST_LIMIT);
        let successCount = 0;
        let failureCount = 0;
        let failedChunks = 0;
        for (const [index, batch] of chunks.entries()) {
            try {
                const response = await (0, messaging_1.getMessaging)().sendEachForMulticast({
                    tokens: batch,
                    notification: { title, body },
                    data: data || {},
                });
                successCount += response.successCount;
                failureCount += response.failureCount;
            }
            catch (error) {
                // One bad chunk must not abort the remaining ones — a partial send
                // reaches more people than no send at all.
                failedChunks++;
                console.error(`❌ Multicast chunk ${index + 1}/${chunks.length} failed:`, error.message);
            }
        }
        console.log(`✅ Multicast: ${successCount}/${tokens.length} delivered across ` +
            `${chunks.length} chunk(s) — ${failureCount} rejected by FCM, ` +
            `${failedChunks} chunk(s) errored`);
        return successCount;
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
