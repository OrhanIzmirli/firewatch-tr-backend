import { Request, Response } from 'express';
import newsService from '../services/newsService';
import cacheService from '../services/cacheService';
import { ApiResponse, News } from '../types';

const NEWS_CACHE_TTL = 300; // scraper runs every 6h, so 5 min is plenty fresh

class NewsController {
  async getAllNews(req: Request, res: Response): Promise<void> {
    try {
      const category = (req.query.category as string) || undefined;
      const parsedLimit = Number.parseInt((req.query.limit as string) || '20', 10);
      const parsedOffset = Number.parseInt((req.query.offset as string) || '0', 10);
      const limitNum = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 20;
      const offsetNum = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0;

      const cacheKey = `news:${category || 'all'}:${limitNum}:${offsetNum}`;
      const cached = await cacheService.get<News[]>(cacheKey);
      if (cached) {
        res.json({
          status: 'success',
          message: `Retrieved ${cached.length} news (cache)`,
          data: cached,
          timestamp: new Date().toISOString(),
        } as ApiResponse<News[]>);
        return;
      }

      const news = await newsService.getAllNews(category, limitNum, offsetNum);
      await cacheService.set(cacheKey, news, NEWS_CACHE_TTL);

      res.json({
        status: 'success',
        message: `Retrieved ${news.length} news`,
        data: news,
        timestamp: new Date().toISOString(),
      } as ApiResponse<News[]>);
    } catch (error) {
      console.error('❌ Error in getAllNews:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to retrieve news',
        timestamp: new Date().toISOString(),
      });
    }
  }

  async getNewsById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const newsId = parseInt(id as string);
      if (!Number.isInteger(newsId) || newsId <= 0) {
        res.status(400).json({ status: 'error', message: 'Invalid id' });
        return;
      }

      const cacheKey = `news:${newsId}`;
      const cached = await cacheService.get<News>(cacheKey);
      if (cached) {
        res.json({
          status: 'success',
          message: 'News retrieved (cache)',
          data: cached,
          timestamp: new Date().toISOString(),
        } as ApiResponse<News>);
        return;
      }

      const news = await newsService.getNewsById(newsId);

      if (!news) {
        res.status(404).json({
          status: 'error',
          message: 'News not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      await cacheService.set(cacheKey, news, NEWS_CACHE_TTL);

      res.json({
        status: 'success',
        message: 'News retrieved',
        data: news,
        timestamp: new Date().toISOString(),
      } as ApiResponse<News>);
    } catch (error) {
      console.error('❌ Error in getNewsById:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to retrieve news',
        timestamp: new Date().toISOString(),
      });
    }
  }
}

export default new NewsController();
