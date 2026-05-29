import { Request, Response } from 'express';
import newsService from '../services/newsService';
import { ApiResponse, News } from '../types';

class NewsController {
  async getAllNews(req: Request, res: Response): Promise<void> {
    try {
      console.log('📰 getAllNews called');
      const category = (req.query.category as string) || undefined;
      const limitNum = Math.min(parseInt((req.query.limit as string) || '20'), 100);
      const offsetNum = parseInt((req.query.offset as string) || '0');

      console.log('📰 Params:', { category, limitNum, offsetNum });

      const news = await newsService.getAllNews(category, limitNum, offsetNum);
      console.log('📰 DB result count:', news.length);

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
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  async getNewsById(req: Request, res: Response): Promise<void> {
    try {
      console.log('📰 getNewsById called');
      const { id } = req.params;
      const newsId = parseInt(id as string);

      const news = await newsService.getNewsById(newsId);
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
      } as ApiResponse<News>);
    } catch (error) {
      console.error('❌ Error in getNewsById:', error);
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