"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const redis_1 = __importDefault(require("../config/redis"));
class CacheService {
    constructor() {
        this.TTL = 3600; // 1 hour default
    }
    // Get cached value
    async get(key) {
        try {
            const value = await redis_1.default.get(key);
            if (!value)
                return null;
            return JSON.parse(value);
        }
        catch (error) {
            console.error('Cache get error:', error);
            return null;
        }
    }
    // Set cached value
    async set(key, value, ttl = this.TTL) {
        try {
            await redis_1.default.setEx(key, ttl, JSON.stringify(value));
            return true;
        }
        catch (error) {
            console.error('Cache set error:', error);
            return false;
        }
    }
    // Delete cached value
    async delete(key) {
        try {
            const result = await redis_1.default.del(key);
            return result > 0;
        }
        catch (error) {
            console.error('Cache delete error:', error);
            return false;
        }
    }
    // Clear all cache matching pattern
    async clearPattern(pattern) {
        try {
            const keys = await redis_1.default.keys(pattern);
            if (keys.length === 0)
                return 0;
            return await redis_1.default.del(keys);
        }
        catch (error) {
            console.error('Cache clear pattern error:', error);
            return 0;
        }
    }
    // Check if key exists
    async exists(key) {
        try {
            const result = await redis_1.default.exists(key);
            return result > 0;
        }
        catch (error) {
            console.error('Cache exists error:', error);
            return false;
        }
    }
}
exports.default = new CacheService();
