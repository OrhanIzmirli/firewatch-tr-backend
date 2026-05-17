import { createClient } from 'redis';
import { RedisConfig } from '../types';

const redisConfig: RedisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
};

const redisClient = createClient({
  socket: {
    host: redisConfig.host,
    port: redisConfig.port,
    reconnectStrategy: (retries) => Math.min(retries * 50, 500),
  },
});

// Connection event handlers
redisClient.on('connect', () => {
  console.log('✅ Redis connected');
});

redisClient.on('error', (err) => {
  console.error('Redis connection error:', err);
});

// Connect to Redis
redisClient.connect().catch((err) => {
  console.error('Failed to connect to Redis:', err);
});

export default redisClient;