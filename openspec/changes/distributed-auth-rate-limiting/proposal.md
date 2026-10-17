# Distributed Auth Rate Limiting

## Why

The current auth rate limiter in `src/lib/auth-throttle.ts` uses a **single-instance in-memory Map** (capacity 10k, 60s window, no Redis backend). Its own comment acknowledges it as a "process-local fallback." In Chorus's multi-ECS-task deployment model, each instance counts independently — an attacker load-balanced across N instances effectively gets N× the intended rate limit, rendering per-instance throttling meaningless at scale.

## What Changes

- Introduce `rate-limiter-flexible` (v11.x, pure JS, Redis/atomic counting backend) as the rate limiting engine.
- **Wrap, not replace**: Keep the existing `throttleAuth(request, action, supplemental)` API surface unchanged. Internally, detect Redis availability and switch between `RateLimiterRedis` (distributed) and `RateLimiterMemory` (single-instance fallback).
- **Redis-absent degradation**: When Redis is not configured, fall back to the current single-instance in-memory behavior with a `warn` log explicitly noting the degraded mode. When Redis is configured but unreachable at runtime, an in-memory insurance limiter keeps per-instance limits in force.
- **Preserve existing semantics**: Same rate limits (identify 30/min, login 10/min, accept 10/min), same XFF trust chain, same identity-only fallback when no trusted address, same dual-key strategy (identity + address), same bounded-capacity eviction behavior.
- No new admin endpoints or monitoring UI — logs are sufficient.

## Capabilities

- **auth-rate-limiting**: Distributed, cross-instance consistent rate limiting for the three auth endpoints (identify, login, accept) with graceful Redis-absent fallback.

## Impact

- **Dependencies**: Adds `rate-limiter-flexible` (pure JS, no native bindings — safe for all target platforms).
- **Code changes**: `src/lib/auth-throttle.ts` (core rewrite), `src/lib/redis.ts` (export a general-purpose Redis client getter, or reuse existing pattern).
- **Tests**: `src/lib/__tests__/auth-throttle.test.ts` — update existing tests, add Redis-backend tests.
- **No behavior change for callers**: `throttleAuth()` keeps its arguments and 429 response but is now async; the three callers (`identify/route.ts`, `login/route.ts`, `accept/route.ts`) only add `await`.
- **Deployment**: No infra changes required. When `REDIS_URL` is set, distributed limiting activates automatically. Without it, behavior is unchanged from today (plus a log line).
