"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const redis_1 = __importDefault(require("../config/redis"));
class CacheService {
    constructor() {
        this.TTL = 300; // 5 dakika — NASA API için ideal
    }
    async get(key) {
        if (!redis_1.default)
            return null;
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
    async set(key, value, ttl = this.TTL) {
        if (!redis_1.default)
            return false;
        try {
            await redis_1.default.set(key, JSON.stringify(value), 'EX', ttl);
            return true;
        }
        catch (error) {
            console.error('Cache set error:', error);
            return false;
        }
    }
    async delete(key) {
        if (!redis_1.default)
            return false;
        try {
            const result = await redis_1.default.del(key);
            return result > 0;
        }
        catch (error) {
            console.error('Cache delete error:', error);
            return false;
        }
    }
    async exists(key) {
        if (!redis_1.default)
            return false;
        try {
            const result = await redis_1.default.exists(key);
            return result > 0;
        }
        catch (error) {
            return false;
        }
    }
}
exports.default = new CacheService();
