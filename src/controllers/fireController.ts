import { Request, Response } from 'express';
import fireService from '../services/fireService';
import cacheService from '../services/cacheService';
import { ApiResponse, Fire } from '../types';

class FireController {
  // Get all fires
  async getAllFires(req: Request, res: Response): Promise<void> {
    try {
      const city = (req.query.city as string) || undefined;
      const status = (req.query.status as string) || undefined;
      const limit = parseInt((req.query.limit as string) || '20');
      const offset = parseInt((req.query.offset as string) || '0');
      const limitNum = Math.min(limit || 20, 100);
      const offsetNum = offset || 0;

      // Check cache
      const cacheKey = `fires:${city || 'all'}:${status || 'all'}:${limitNum}:${offsetNum}`;
      const cached = await cacheService.get<Fire[]>(cacheKey);
      if (cached) {
        res.json({
          status: 'success',
          message: 'Fires retrieved from cache',
          data: cached,
          timestamp: new Date().toISOString(),
        } as ApiResponse<Fire[]>);
        return;
      }

      // Get from database
      const fires = await fireService.getAllFires(city as string, status as string, limitNum, offsetNum);
      const total = await fireService.getFiresCount(city as string, status as string);

      // Cache result
      await cacheService.set(cacheKey, fires, 600); // 10 minutes

      res.json({
        status: 'success',
        message: `Retrieved ${fires.length} fires`,
        data: fires,
        timestamp: new Date().toISOString(),
      } as ApiResponse<Fire[]>);
    } catch (error) {
      console.error('Error in getAllFires:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to retrieve fires',
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Get single fire
  async getFireById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const fireId = parseInt(id as string);

      // Check cache
      const cacheKey = `fire:${fireId}`;
      const cached = await cacheService.get<Fire>(cacheKey);
      if (cached) {
        res.json({
          status: 'success',
          message: 'Fire retrieved from cache',
          data: cached,
          timestamp: new Date().toISOString(),
        } as ApiResponse<Fire>);
        return;
      }

      const fire = await fireService.getFireById(fireId);
      if (!fire) {
        res.status(404).json({
          status: 'error',
          message: 'Fire not found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Cache result
      await cacheService.set(cacheKey, fire, 600);

      res.json({
        status: 'success',
        message: 'Fire retrieved',
        data: fire,
        timestamp: new Date().toISOString(),
      } as ApiResponse<Fire>);
    } catch (error) {
      console.error('Error in getFireById:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to retrieve fire',
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Create fire
  async createFire(req: Request, res: Response): Promise<void> {
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

      const fire = await fireService.createFire(fireData);

      // Clear cache
      await cacheService.clearPattern('fires:*');

      res.status(201).json({
        status: 'success',
        message: 'Fire created successfully',
        data: fire,
        timestamp: new Date().toISOString(),
      } as ApiResponse<Fire>);
    } catch (error) {
      console.error('Error in createFire:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to create fire',
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

export default new FireController();