# Tech Design: Distributed Auth Rate Limiting

## Architecture

```
┌─────────────────────────────────────────────┐
│  throttleAuth(request, action, supplemental) │  ← unchanged public API
│                    │                         │
│          ┌─────────▼──────────┐              │
│          │  Backend Selector   │              │
│          │  (lazy singleton)   │              │
│          └─────────┬──────────┘              │
│                    │                         │
│     ┌──────────────┼──────────────┐          │
│     ▼                             ▼          │
│  Redis available?            Redis absent?   │
│     │                             │          │
│     ▼                             ▼          │
│  RateLimiterRedis           RateLimiterMemory│
│  (distributed)              (single-instance)│
│  + warn log on transition   + warn log once  │
└─────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Wrap, Don't Replace

The existing `throttleAuth()` function signature is preserved:
```typescript
export async function throttleAuth(
  request: NextRequest,
  action: keyof typeof limits,
  supplemental?: string
): Promise<NextResponse | null>
```

All three callers (identify, login, accept) pass the same arguments and get the same 429 response; the only change is that they `await` the result, because the distributed backend is Promise-based. The internal implementation switches backends transparently.

### 2. Backend Selection

A lazy-initialized singleton selects the backend on first use:

- **Redis available** (`isRedisEnabled()` returns true, client connects): Use `RateLimiterRedis` for each action. Key prefix: `chorus:auth_rl:`. This gives atomic, cross-instance counting via Redis INCR/EXPIRE.
- **Redis absent**: Use `RateLimiterMemory` for each action. Log a one-time `warn` message: `"Auth rate limiter: Redis unavailable, falling back to single-instance in-memory mode. Multi-instance deployments will have per-instance rate limits."`

### 3. Dual-Key Strategy (Preserved)

The current implementation generates two key types per request:
- `{action}:identity:{address}:{identityHash}` — always present
- `{action}:address:{address}` — only when a trusted address exists

This is preserved. With `rate-limiter-flexible`, we create **two limiter instances per action** (one for identity keys, one for address keys), each with the action's rate limit.

### 4. Rate Limiter Configuration

For each action, the `RateLimiterRedis`/`RateLimiterMemory` instance is configured with:
- `points`: the action's limit (identify: 30, login: 10, accept: 10)
- `duration`: 60 seconds
- `keyPrefix`: `chorus:auth_rl:{action}:identity:` or `chorus:auth_rl:{action}:address:`

### 5. XFF Trust Chain (Preserved)

The `trustedAddress()` function is extracted unchanged. It continues to:
- Return `null` when `AUTH_TRUST_PROXY !== "true"`
- Validate hop count (`AUTH_TRUST_PROXY_HOPS`)
- Parse XFF right-side hops
- Normalize IPv4/IPv6 (including ALB port syntax)

### 6. Redis Client

Reuse the existing `getRedisPublisher()` pattern from `src/lib/redis.ts`, but add a new `getRedisGeneral()` export (or reuse the publisher client — `ioredis` clients are full-duplex). The `RateLimiterRedis` constructor accepts an `ioredis` client via its `storeClient` option.

### 7. Error Handling

If Redis is configured but not ready (startup, reconnecting, outage):
- The dedicated `getRedisGeneral()` client is created with `enableOfflineQueue: false`, `maxRetriesPerRequest: 1` and an eager connection, so commands fail fast instead of queueing behind a dead socket (the pub/sub clients keep infinite retries).
- A connection that stays `ready` but stops replying (stuck Redis, half-open proxy) is bounded by `commandTimeout: 500ms` — each command rejects into the insurance limiter — and `socketTimeout: 2000ms`, which tears down a socket that has pending commands but no reply, so the client reconnects instead of accumulating a pending queue.
- Each `RateLimiterRedis` is built with `rejectIfRedisNotReady: true` and an `insuranceLimiter` (`RateLimiterMemory` with the same points/duration). While Redis is not ready, or when a command errors, counting transparently degrades to **per-instance in-memory limits** — the limit is never disabled and requests never hang.
- A `warn` log is emitted once per ready → not-ready transition, and an `info` log when distributed limits are restored. The very first connect of a process is not a transition: insurance use is not reported until Redis has been seen ready or a 5 s startup grace has passed, so a healthy process does not log a false outage on its first auth request, while a Redis that never comes up is still reported.
- The library swallows Redis errors when it delegates to the insurance limiter, so a store that reports `ready` but rejects commands (`READONLY` after failover, `OOM`) would degrade silently. The insurance limiter is therefore wrapped to emit a `warn` on use, throttled to once per 60 s window.
- Only a truly unexpected backend error (not a `RateLimiterRes`) fails open, with a `warn` log.

> Revised during implementation: the original draft failed open on any Redis error. That made a Redis outage equivalent to "no auth rate limiting" and, with the shared client's infinite retry queue, could hang auth requests. The insurance limiter matches the Redis-absent decision from elaboration (fall back to single-instance memory).

### 7a. Bounded In-Memory Counters

`RateLimiterMemory` has no size cap (one Map entry + timer per key). To preserve the original 10k-entry bound, every in-memory limiter (Redis-absent fallback and Redis insurance) registers its keys in one shared insertion-ordered map capped at `CAPACITY = 10_000`. A touched key moves to the end; when full, the least recently used key is evicted via `limiter.delete(key)`, so the attempt being counted is never the one evicted. Eviction is best-effort under pressure; the edge limiter is still required for sustained floods. Redis-side counters are bounded by their TTL.

### 8. Test Strategy

- **Existing tests**: All current `auth-throttle.test.ts` tests continue to pass with `RateLimiterMemory` (the default when Redis is not configured in tests).
- **New tests** (`auth-throttle-redis.test.ts`): mock `getRedisGeneral()` with a fake ioredis client backed by one shared store, import the module twice (two independent "instances"), and verify attempts are merged across instances; plus Redis-absent fallback + warn, not-ready / command-failure insurance, recovery, and fail-open on unexpected errors.
- **Integration**: Manual verification with two app instances sharing a local Redis.

## File Changes

| File | Change |
|------|--------|
| `src/lib/auth-throttle.ts` | Core rewrite — wrap rate-limiter-flexible, keep public API |
| `src/lib/redis.ts` | Add `getRedisGeneral()` or document reuse of existing client |
| `src/lib/__tests__/auth-throttle.test.ts` | Update + add Redis-backend tests |
| `package.json` | Add `rate-limiter-flexible` dependency |

## Non-Goals

- No admin endpoints or monitoring UI for rate limit status
- No changes to edge/ALB rate limiting (still ops-side)
- No changes to SSE or session lifecycle
