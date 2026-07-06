"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const newsService_1 = __importDefault(require("../services/newsService"));
const cacheService_1 = __importDefault(require("../services/cacheService"));
const NEWS_CACHE_TTL = 300; // scraper runs every 6h, so 5 min is plenty fresh
class NewsController {
    async getAllNews(req, res) {
        try {
            const category = req.query.category || undefined;
            const limitNum = Math.min(parseInt(req.query.limit || '20'), 100);
            const offsetNum = parseInt(req.query.offset || '0');
            const cacheKey = `news:${category || 'all'}:${limitNum}:${offsetNum}`;
            const cached = await cacheService_1.default.get(cacheKey);
            if (cached) {
                res.json({
                    status: 'success',
                    message: `Retrieved ${cached.length} news (cache)`,
                    data: cached,
                    timestamp: new Date().toISOString(),
                });
                return;
            }
            const news = await newsService_1.default.getAllNews(category, limitNum, offsetNum);
            await cacheService_1.default.set(cacheKey, news, NEWS_CACHE_TTL);
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
            const { id } = req.params;
            const newsId = parseInt(id);
            const cacheKey = `news:${newsId}`;
            const cached = await cacheService_1.default.get(cacheKey);
            if (cached) {
                res.json({
                    status: 'success',
                    message: 'News retrieved (cache)',
                    data: cached,
                    timestamp: new Date().toISOString(),
                });
                return;
            }
            const news = await newsService_1.default.getNewsById(newsId);
            if (!news) {
                res.status(404).json({
                    status: 'error',
                    message: 'News not found',
                    timestamp: new Date().toISOString(),
                });
                return;
            }
            await cacheService_1.default.set(cacheKey, news, NEWS_CACHE_TTL);
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
