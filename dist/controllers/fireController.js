"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fireService_1 = __importDefault(require("../services/fireService"));
const cacheService_1 = __importDefault(require("../services/cacheService"));
class FireController {
    // Get all fires
    async getAllFires(req, res) {
        try {
            const city = req.query.city || undefined;
            const status = req.query.status || undefined;
            const limit = parseInt(req.query.limit || '20');
            const offset = parseInt(req.query.offset || '0');
            const limitNum = Math.min(limit || 20, 100);
            const offsetNum = offset || 0;
            // Check cache
            const cacheKey = `fires:${city || 'all'}:${status || 'all'}:${limitNum}:${offsetNum}`;
            const cached = await cacheService_1.default.get(cacheKey);
            if (cached) {
                res.json({
                    status: 'success',
                    message: 'Fires retrieved from cache',
                    data: cached,
                    timestamp: new Date().toISOString(),
                });
                return;
            }
            // Get from database
            const fires = await fireService_1.default.getAllFires(city, status, limitNum, offsetNum);
            const total = await fireService_1.default.getFiresCount(city, status);
            // Cache result
            await cacheService_1.default.set(cacheKey, fires, 600); // 10 minutes
            res.json({
                status: 'success',
                message: `Retrieved ${fires.length} fires`,
                data: fires,
                timestamp: new Date().toISOString(),
            });
        }
        catch (error) {
            console.error('Error in getAllFires:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to retrieve fires',
                error: error.message,
                timestamp: new Date().toISOString(),
            });
        }
    }
    // Get single fire
    async getFireById(req, res) {
        try {
            const { id } = req.params;
            const fireId = parseInt(id);
            // Check cache
            const cacheKey = `fire:${fireId}`;
            const cached = await cacheService_1.default.get(cacheKey);
            if (cached) {
                res.json({
                    status: 'success',
                    message: 'Fire retrieved from cache',
                    data: cached,
                    timestamp: new Date().toISOString(),
                });
                return;
            }
            const fire = await fireService_1.default.getFireById(fireId);
            if (!fire) {
                res.status(404).json({
                    status: 'error',
                    message: 'Fire not found',
                    timestamp: new Date().toISOString(),
                });
                return;
            }
            // Cache result
            await cacheService_1.default.set(cacheKey, fire, 600);
            res.json({
                status: 'success',
                message: 'Fire retrieved',
                data: fire,
                timestamp: new Date().toISOString(),
            });
        }
        catch (error) {
            console.error('Error in getFireById:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to retrieve fire',
                error: error.message,
                timestamp: new Date().toISOString(),
            });
        }
    }
    // Create fire
    async createFire(req, res) {
        try {
            const fireData = req.body;
            // Validate required fields
            if (!fireData.title || !fireData.city || fireData.latitude === undefined || fireData.longitude === undefined) {
                res.status(400).json({
                    status: 'error',
                    message: 'Missing required fields: title, city, latitude, longitude',
                    timestamp: new Date().toISOString(),
                });
                return;
            }
            const fire = await fireService_1.default.createFire(fireData);
            // Clear cache
            await cacheService_1.default.delete('fires:all');
            res.status(201).json({
                status: 'success',
                message: 'Fire created successfully',
                data: fire,
                timestamp: new Date().toISOString(),
            });
        }
        catch (error) {
            console.error('Error in createFire:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to create fire',
                error: error.message,
                timestamp: new Date().toISOString(),
            });
        }
    }
}
exports.default = new FireController();
