"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const redis_1 = require("redis");
const redisClient = (0, redis_1.createClient)({
    socket: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
    },
});
redisClient.on('connect', () => {
    console.log('✅ Redis connected');
});
redisClient.on('error', (err) => {
    console.warn('⚠️  Redis not available - caching disabled');
});
redisClient.connect().catch(() => {
    console.warn('⚠️  Redis connection failed - app will work without cache');
});
exports.default = redisClient;
