import { Request, Response } from 'express';
import newsService from '../services/newsService';
import cacheService from '../services/cacheService';
import { ApiResponse, News } from '../types';

class NewsController {
  // Get all news
  async getAllNews(req: Request, res: Response): Promise<void> {
    try {
      const category = (req.query.category as string) || undefined;
      const limit = parseInt((req.query.limit as string) || '20');
      const offset = parseInt((req.query.offset as string) || '0');
      const limitNum = Math.min(limit || 20, 100);
      const offsetNum = offset || 0;

      // Check cache
      const cacheKey = `news:${category || 'all'}:${limitNum}:${offsetNum}`;
      const cached = await cacheService.get<News[]>(cacheKey);
      if (cached) {
        res.json({
          status: 'success',
          message: 'News retrieved from cache',
          data: cached,
          timestamp: new Date().toISOString(),
        } as ApiResponse<News[]>);
        return;
      }

      // Get from database
      const news = await newsService.getAllNews(category || '', limitNum, offsetNum);
const total = await newsService.getNewsCount(category || '');

      // Cache result
      await cacheService.set(cacheKey, news, 600);

      res.json({
        status: 'success',
        message: `Retrieved ${news.length} news`,
        data: news,
        timestamp: new Date().toISOString(),
      } as ApiResponse<News[]>);
    } catch (error) {
      console.error('Error in getAllNews:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to retrieve news',
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Get single news
  async getNewsById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const newsId = parseInt(id as string);

      // Check cache
      const cacheKey = `news:${newsId}`;
      const cached = await cacheService.get<News>(cacheKey);
      if (cached) {
        res.json({
          status: 'success',
          message: 'News retrieved from cache',
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

      // Cache result
      await cacheService.set(cacheKey, news, 600);

      res.json({
        status: 'success',
        message: 'News retrieved',
        data: news,
        timestamp: new Date().toISOString(),
      } as ApiResponse<News>);
    } catch (error) {
      console.error('Error in getNewsById:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to retrieve news',
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

export default new NewsController();