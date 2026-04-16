// src/lib/redis.ts
// Redis client singleton for Pub/Sub — lazy-initialized, graceful fallback
import Redis from "ioredis";
import logger from "@/lib/logger";

const redisLogger = logger.child({ module: "redis" });

/**
 * Build Redis connection URL from environment variables.
 * Supports two modes:
 * - REDIS_URL: Full URL (local dev, e.g. redis://default:chorus-redis@localhost:6379)
 * - REDIS_HOST + REDIS_PORT + REDIS_USERNAME + REDIS_PASSWORD: Individual vars (CDK deployment)
 */
function getRedisUrl(): string | undefined {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  const host = process.env.REDIS_HOST;
  if (!host) return undefined;
  const port = process.env.REDIS_PORT || "6379";
  const username = process.env.REDIS_USERNAME || "default";
  const password = process.env.REDIS_PASSWORD;
  const protocol = "rediss"; // CDK ElastiCache always uses TLS
  if (password) {
    return `${protocol}://${username}:${encodeURIComponent(password)}@${host}:${port}`;
  }
  return `${protocol}://${host}:${port}`;
}

const REDIS_URL = getRedisUrl();

export function isRedisEnabled(): boolean {
  return !!REDIS_URL;
}

// globalThis singleton pattern (same as event-bus.ts) to survive Next.js HMR
const globalForRedis = globalThis as unknown as {
  redisPub: Redis | undefined;
  redisSub: Redis | undefined;
};

function createClient(name: string): Redis {
  const client = new Redis(REDIS_URL!, {
    lazyConnect: true,
    maxRetriesPerRequest: null, // infinite retries for pub/sub
    retryStrategy(times) {
      const delay = Math.min(times * 200, 5000);
      redisLogger.warn({ name, delay, attempt: times }, "Reconnecting");
      return delay;
    },
  });
  client.on("error", (err) => {
    redisLogger.error({ name, err }, "Redis error");
  });
  client.on("connect", () => {
    redisLogger.info({ name }, "Connected");
  });
  return client;
}

export function getRedisPublisher(): Redis | null {
  if (!isRedisEnabled()) return null;
  if (!globalForRedis.redisPub) {
    globalForRedis.redisPub = createClient("pub");
  }
  return globalForRedis.redisPub;
}

export function getRedisSubscriber(): Redis | null {
  if (!isRedisEnabled()) return null;
  if (!globalForRedis.redisSub) {
    globalForRedis.redisSub = createClient("sub");
  }
  return globalForRedis.redisSub;
}
