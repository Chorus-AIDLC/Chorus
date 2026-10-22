// src/lib/redis.ts
// Redis client singleton for Pub/Sub — lazy-initialized, graceful fallback
import Redis, { type RedisOptions } from "ioredis";
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
  redisGeneral: Redis | undefined;
};

function createClient(name: string, overrides: RedisOptions = {}): Redis {
  const client = new Redis(REDIS_URL!, {
    lazyConnect: true,
    maxRetriesPerRequest: null, // infinite retries for pub/sub
    ...overrides,
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

/**
 * General-purpose Redis client for request-path use cases (e.g. rate limiting).
 * Uses a separate connection so that pub/sub and rate-limiter traffic don't
 * interfere with each other. Returns null when Redis is not configured.
 *
 * Unlike pub/sub, request-path callers must never block on an unreachable
 * Redis: commands fail fast instead of queueing, and the client connects
 * eagerly so its `status` reflects reachability before the first command.
 * A connection that stays open but stops answering is bounded too: each
 * command rejects after REQUEST_COMMAND_TIMEOUT_MS, and a socket with pending
 * commands and no reply for REQUEST_SOCKET_TIMEOUT_MS is torn down so the
 * client reconnects. A timed-out command stays in ioredis's queue, so resend
 * on reconnect is disabled: otherwise the stalled backlog would be replayed on
 * every recycle and counted again in Redis once it recovers, after the caller
 * was already served by the in-memory fallback.
 */
const REQUEST_COMMAND_TIMEOUT_MS = 500;
const REQUEST_SOCKET_TIMEOUT_MS = 2_000;

export function getRedisGeneral(): Redis | null {
  if (!isRedisEnabled()) return null;
  if (!globalForRedis.redisGeneral) {
    globalForRedis.redisGeneral = createClient("general", {
      lazyConnect: false,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: REQUEST_COMMAND_TIMEOUT_MS,
      socketTimeout: REQUEST_SOCKET_TIMEOUT_MS,
      autoResendUnfulfilledCommands: false,
    });
  }
  return globalForRedis.redisGeneral;
}
