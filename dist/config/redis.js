"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ioredis_1 = __importDefault(require("ioredis"));
const redisUrl = process.env.REDIS_URL || null;
let redisClient = null;
if (redisUrl) {
    redisClient = new ioredis_1.default(redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
            if (times > 3)
                return null;
            return Math.min(times * 200, 1000);
        },
        enableOfflineQueue: false,
    });
    redisClient.on('connect', () => console.log('✅ Redis connected'));
    redisClient.on('ready', () => console.log('✅ Redis ready'));
    redisClient.on('error', (err) => console.warn('⚠️  Redis error:', err.message));
    redisClient.on('close', () => console.warn('⚠️  Redis connection closed'));
}
else {
    console.warn('⚠️  REDIS_URL not set — cache disabled');
}
exports.default = redisClient;
