import redisClient from '../config/redis';

class CacheService {
  private TTL = 300; // 5 dakika — NASA API için ideal

  async get<T>(key: string): Promise<T | null> {
    if (!redisClient) return null;
    try {
      const value = await redisClient.get(key);
      if (!value) return null;
      return JSON.parse(value) as T;
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttl: number = this.TTL): Promise<boolean> {
    if (!redisClient) return false;
    try {
      await redisClient.set(key, JSON.stringify(value), 'EX', ttl);
      return true;
    } catch (error) {
      console.error('Cache set error:', error);
      return false;
    }
  }

  async delete(key: string): Promise<boolean> {
    if (!redisClient) return false;
    try {
      const result = await redisClient.del(key);
      return result > 0;
    } catch (error) {
      console.error('Cache delete error:', error);
      return false;
    }
  }

  async exists(key: string): Promise<boolean> {
    if (!redisClient) return false;
    try {
      const result = await redisClient.exists(key);
      return result > 0;
    } catch (error) {
      return false;
    }
  }
}

export default new CacheService();