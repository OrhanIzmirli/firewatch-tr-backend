"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const newsService_1 = __importDefault(require("../services/newsService"));
class NewsController {
    async getAllNews(req, res) {
        try {
            console.log('📰 getAllNews called');
            const category = req.query.category || undefined;
            const limitNum = Math.min(parseInt(req.query.limit || '20'), 100);
            const offsetNum = parseInt(req.query.offset || '0');
            console.log('📰 Params:', { category, limitNum, offsetNum });
            const news = await newsService_1.default.getAllNews(category, limitNum, offsetNum);
            console.log('📰 DB result count:', news.length);
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
