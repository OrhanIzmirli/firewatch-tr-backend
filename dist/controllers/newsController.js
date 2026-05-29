"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const newsService_1 = __importDefault(require("../services/newsService"));
const cacheService_1 = __importDefault(require("../services/cacheService"));
class NewsController {
    async getAllNews(req, res) {
        try {
            console.log('📰 getAllNews called');
            const category = req.query.category || undefined;
            const limit = parseInt(req.query.limit || '20');
            const offset = parseInt(req.query.offset || '0');
            const limitNum = Math.min(limit || 20, 100);
            const offsetNum = offset || 0;
            console.log('📰 Params:', { category, limitNum, offsetNum });
            const cacheKey = `news:${category || 'all'}:${limitNum}:${offsetNum}`;
            const cached = await cacheService_1.default.get(cacheKey);
            console.log('📰 Cache:', cached ? 'HIT' : 'MISS');
            if (cached) {
                res.json({
                    status: 'success',
                    message: 'News retrieved from cache',
                    data: cached,
                    timestamp: new Date().toISOString(),
                });
                return;
            }
            const news = await newsService_1.default.getAllNews(category, limitNum, offsetNum);
            console.log('📰 DB result count:', news.length);
            const total = await newsService_1.default.getNewsCount(category);
            console.log('📰 Total count:', total);
            await cacheService_1.default.set(cacheKey, news, 600);
            res.json({
                status: 'success',
                message: `Retrieved ${news.length} news`,
                data: news,
                timestamp: new Date().toISOString(),
            });
        }
        catch (error) {
            console.error('❌ Error in getAllNews:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to retrieve news',
                error: error.message,
                timestamp: new Date().toISOString(),
            });
        }
    }
    async getNewsById(req, res) {
        try {
            console.log('📰 getNewsById called');
            const { id } = req.params;
            const newsId = parseInt(id);
            const cacheKey = `news:${newsId}`;
            const cached = await cacheService_1.default.get(cacheKey);
            console.log('📰 Cache:', cached ? 'HIT' : 'MISS');
            if (cached) {
                res.json({
                    status: 'success',
                    message: 'News retrieved from cache',
                    data: cached,
                    timestamp: new Date().toISOString(),
                });
                return;
            }
            const news = await newsService_1.default.getNewsById(newsId);
            console.log('📰 News found:', news ? 'YES' : 'NO');
            if (!news) {
                res.status(404).json({
                    status: 'error',
                    message: 'News not found',
                    timestamp: new Date().toISOString(),
                });
                return;
            }
            await cacheService_1.default.set(cacheKey, news, 600);
            res.json({
                status: 'success',
                message: 'News retrieved',
                data: news,
                timestamp: new Date().toISOString(),
            });
        }
        catch (error) {
            console.error('❌ Error in getNewsById:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to retrieve news',
                error: error.message,
                timestamp: new Date().toISOString(),
            });
        }
    }
}
exports.default = new NewsController();
