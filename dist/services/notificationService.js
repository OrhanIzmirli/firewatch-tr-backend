"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.admin = void 0;
const admin = __importStar(require("firebase-admin"));
exports.admin = admin;
const path = __importStar(require("path"));
// Firebase initialization
const serviceAccountPath = process.env.FIREBASE_CREDENTIALS_PATH || './firewatch-tr-firebase-adminsdk-fbsvc-9604dc98c3.json';
try {
    admin.initializeApp({
        credential: admin.credential.cert(require(path.resolve(serviceAccountPath))),
        databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
    console.log(' Firebase initialized');
}
catch (error) {
    console.error(' Firebase initialization error:', error);
}
class NotificationService {
    // Send notification to specific token
    async sendToToken(token, title, body, data) {
        try {
            const message = {
                notification: {
                    title,
                    body,
                },
                data: data || {},
                token,
            };
            const response = await admin.messaging().send(message);
            console.log(' Message sent:', response);
            return true;
        }
        catch (error) {
            console.error(' Error sending message:', error);
            return false;
        }
    }
    // Send notification to multiple tokens
    async sendToTokens(tokens, title, body, data) {
        try {
            const message = {
                notification: {
                    title,
                    body,
                },
                data: data || {},
            };
            const response = await admin.messaging().sendEachForMulticast({
                tokens,
                notification: message.notification,
                data: message.data,
            });
            console.log(` Sent to ${response.successCount} devices`);
            return response.successCount;
        }
        catch (error) {
            console.error(' Error sending multicast:', error);
            return 0;
        }
    }
    // Send to topic
    async sendToTopic(topic, title, body, data) {
        try {
            const message = {
                notification: {
                    title,
                    body,
                },
                data: data || {},
                topic,
            };
            const response = await admin.messaging().send(message);
            console.log(' Message sent to topic:', response);
            return true;
        }
        catch (error) {
            console.error(' Error sending to topic:', error);
            return false;
        }
    }
}
exports.default = new NotificationService();
