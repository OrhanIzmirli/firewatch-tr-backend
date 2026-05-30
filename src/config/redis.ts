import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || null;

let redisClient: Redis | null = null;

if (redisUrl) {
  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    retryStrategy(times) {
      if (times > 3) return null;
      return Math.min(times * 200, 1000);
    },
  });

  redisClient.on('connect', () => console.log('✅ Redis connected'));
  redisClient.on('error', (err) => console.warn('⚠️  Redis error:', err.message));
} else {
  console.warn('⚠️  REDIS_URL not set — cache disabled');
}

export default redisClient;