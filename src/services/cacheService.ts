import redisClient from '../config/redis';

class CacheService {
  private TTL = 3600; // 1 hour default

  // Get cached value
  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await redisClient.get(key);
      if (!value) return null;
      return JSON.parse(value) as T;
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  }

  // Set cached value
  async set<T>(key: string, value: T, ttl: number = this.TTL): Promise<boolean> {
    try {
      await redisClient.setEx(key, ttl, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error('Cache set error:', error);
      return false;
    }
  }

  // Delete cached value
  async delete(key: string): Promise<boolean> {
    try {
      const result = await redisClient.del(key);
      return result > 0;
    } catch (error) {
      console.error('Cache delete error:', error);
      return false;
    }
  }

  // Clear all cache matching pattern
  async clearPattern(pattern: string): Promise<number> {
    try {
      const keys = await redisClient.keys(pattern);
      if (keys.length === 0) return 0;
      return await redisClient.del(keys);
    } catch (error) {
      console.error('Cache clear pattern error:', error);
      return 0;
    }
  }

  // Check if key exists
  async exists(key: string): Promise<boolean> {
    try {
      const result = await redisClient.exists(key);
      return result > 0;
    } catch (error) {
      console.error('Cache exists error:', error);
      return false;
    }
  }
}

export default new CacheService();