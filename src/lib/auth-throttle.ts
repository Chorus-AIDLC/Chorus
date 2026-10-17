import { createHash } from "crypto";
import { isIP } from "net";
import { NextRequest, NextResponse } from "next/server";
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import { getRedisGeneral } from "@/lib/redis";
import logger from "@/lib/logger";

const authLogger = logger.child({ module: "auth-throttle" });

// ---------------------------------------------------------------------------
// Rate limit configuration — preserved from the original in-memory Map impl.
// ---------------------------------------------------------------------------
const limits = { identify: 30, login: 10, accept: 10 } as const;
const WINDOW_SEC = 60;

// ---------------------------------------------------------------------------
// XFF trusted-proxy chain — preserved verbatim from the original impl.
// ---------------------------------------------------------------------------
function trustedAddress(request: NextRequest): string | null {
  if (process.env.AUTH_TRUST_PROXY !== "true") return null;
  const hops = Number(process.env.AUTH_TRUST_PROXY_HOPS ?? "1");
  if (!Number.isInteger(hops) || hops < 1 || hops > 16) return null;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",");
  if (!forwarded || forwarded.length < hops) return null;
  const value = forwarded[forwarded.length - hops].trim();
  // ALB can optionally append a client port, including bracketed IPv6.
  const address = value.match(/^\[([^\]]+)\]:\d+$/)?.[1]
    ?? value.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/)?.[1]
    ?? value;
  const version = isIP(address);
  if (version === 4) return address;
  if (version === 6 && !address.includes("%")) return new URL(`http://[${address}]`).hostname.slice(1, -1);
  return null;
}

// ---------------------------------------------------------------------------
// Backend selection — lazy singleton.
//
// Redis available → RateLimiterRedis  (distributed, cross-instance consistent)
// Redis absent    → RateLimiterMemory (single-instance fallback + warn log)
//
// While Redis is configured but not ready (startup, outage), each Redis
// limiter rejects immediately and delegates to an in-memory insurance limiter,
// so a Redis outage degrades to per-instance limiting rather than hanging the
// request or disabling the limit.
// ---------------------------------------------------------------------------

type Action = keyof typeof limits;
type Limiter = RateLimiterRedis | RateLimiterMemory;
type ActionLimiters = Record<"identity" | "address", Limiter>;

let _limiters: Record<Action, ActionLimiters> | null = null;
// "unknown" until the client is first seen ready, so the initial connect on a
// fresh process is not reported as an outage.
let _redisHealth: "unknown" | "ready" | "degraded" = "unknown";
let _insuranceWarnedAt = -Infinity;
let _limitersBuiltAt = 0;
const STARTUP_GRACE_MS = 5_000;

// RateLimiterMemory has no size cap. Bound all in-memory counters together
// (fallback and insurance) so rotating identities cannot grow memory without
// limit; under pressure the least recently used key is evicted, which keeps
// the attempt being counted intact. Eviction makes this best-effort; the edge
// limiter remains the defence against sustained floods.
const CAPACITY = 10_000;
const tracked = new Map<string, () => void>();

function track(id: string, evict: () => void): void {
  if (tracked.delete(id)) { tracked.set(id, evict); return; }
  if (tracked.size >= CAPACITY) {
    const [oldest, evictOldest] = tracked.entries().next().value!;
    tracked.delete(oldest);
    evictOldest();
  }
  tracked.set(id, evict);
}

function memoryLimiter(action: Action, scope: keyof ActionLimiters, onConsume?: () => void): RateLimiterMemory {
  const limiter = new RateLimiterMemory({ points: limits[action], duration: WINDOW_SEC, keyPrefix: `chorus:auth_rl:${action}:${scope}` });
  const consume = limiter.consume.bind(limiter);
  limiter.consume = (key, ...rest) => {
    onConsume?.();
    track(`${action}:${scope}:${key}`, () => void limiter.delete(key));
    return consume(key, ...rest);
  };
  return limiter;
}

// rate-limiter-flexible swallows Redis errors when delegating to the insurance
// limiter, so a store that reports "ready" but rejects commands (READONLY after
// failover, OOM) would silently drop to per-instance limits. Warn on every
// insurance use, throttled to once per window.
function insuranceLimiter(action: Action, scope: keyof ActionLimiters): RateLimiterMemory {
  return memoryLimiter(action, scope, () => {
    const now = Date.now();
    if (now - _insuranceWarnedAt < WINDOW_SEC * 1000) return;
    // A request racing the very first connect is expected; a Redis that is
    // still unreachable after the grace period is still reported.
    if (_redisHealth === "unknown" && now - _limitersBuiltAt < STARTUP_GRACE_MS) return;
    _insuranceWarnedAt = now;
    authLogger.warn({ action, scope }, "Auth rate limiter: Redis command failed or not ready, using per-instance in-memory insurance limits");
  });
}

function buildLimiters(): Record<Action, ActionLimiters> {
  const redisClient = getRedisGeneral();
  if (!redisClient) {
    authLogger.warn(
      "Auth rate limiter: Redis unavailable, falling back to single-instance in-memory mode. " +
      "Multi-instance deployments will have per-instance rate limits.",
    );
  }
  const build = (action: Action, scope: keyof ActionLimiters): Limiter => redisClient
    ? new RateLimiterRedis({
      storeClient: redisClient,
      points: limits[action],
      duration: WINDOW_SEC,
      keyPrefix: `chorus:auth_rl:${action}:${scope}`,
      rejectIfRedisNotReady: true,
      insuranceLimiter: insuranceLimiter(action, scope),
    })
    : memoryLimiter(action, scope);
  const result = {} as Record<Action, ActionLimiters>;
  for (const action of Object.keys(limits) as Action[]) {
    result[action] = { identity: build(action, "identity"), address: build(action, "address") };
  }
  return result;
}

function getLimiters(): Record<Action, ActionLimiters> {
  if (!_limiters) { _limiters = buildLimiters(); _limitersBuiltAt = Date.now(); }
  return _limiters;
}

// Log once per ready → not-ready transition (and back) instead of per request.
function noteRedisHealth(): void {
  const client = getRedisGeneral();
  if (!client) return;
  if (client.status === "ready") {
    if (_redisHealth === "degraded") authLogger.info("Auth rate limiter: Redis ready, distributed limits restored");
    _redisHealth = "ready";
  } else if (_redisHealth === "ready") {
    _redisHealth = "degraded";
    authLogger.warn({ status: client.status }, "Auth rate limiter: Redis not ready, using per-instance in-memory insurance limits");
  }
}

async function consume(limiter: Limiter, key: string, action: Action, scope: keyof ActionLimiters): Promise<NextResponse | null> {
  try {
    await limiter.consume(key);
    return null;
  } catch (err) {
    if (err instanceof RateLimiterRes) return rateLimitResponse(err.msBeforeNext);
    // Unexpected backend error (insurance normally absorbs Redis failures) — fail-open.
    authLogger.warn({ err, action, scope }, "Auth rate limiter: backend error, allowing request (fail-open)");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API — same arguments and response as before; now async because the
// distributed backend is Promise-based.
// ---------------------------------------------------------------------------

export async function throttleAuth(
  request: NextRequest,
  action: keyof typeof limits,
  supplemental = "",
): Promise<NextResponse | null> {
  const address = trustedAddress(request);
  const identity = createHash("sha256").update(supplemental).digest("hex");
  const actionLimiters = getLimiters()[action];
  noteRedisHealth();
  // A known client cannot evade its address limit by rotating identifiers. With
  // no trusted address, only the requested identity/token is limited, not all users.
  return await consume(actionLimiters.identity, `${address ?? ""}:${identity}`, action, "identity")
    ?? (address ? await consume(actionLimiters.address, address, action, "address") : null);
}

function rateLimitResponse(msBeforeNext: number): NextResponse {
  const retryAfterSec = Math.max(1, Math.ceil(msBeforeNext / 1000));
  return NextResponse.json(
    { success: false, error: { code: "RATE_LIMITED", message: "Too many authentication attempts. Please try again shortly." } },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// Drops limiter singletons (and their in-memory counters). Redis-side counters
// are not touched; they expire with the window.
export function resetAuthThrottleForTests(): void {
  _limiters = null;
  _redisHealth = "unknown";
  _insuranceWarnedAt = -Infinity;
  _limitersBuiltAt = 0;
  tracked.clear();
}
