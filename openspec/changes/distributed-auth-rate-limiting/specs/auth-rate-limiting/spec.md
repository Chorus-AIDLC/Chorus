# Spec: auth-rate-limiting

## ADDED Requirements

### Requirement: Distributed rate limiting backend
The auth rate limiter SHALL use `rate-limiter-flexible` as its rate limiting engine. When Redis is available (via `REDIS_URL` or `REDIS_HOST`), the limiter SHALL use `RateLimiterRedis` for cross-instance consistent counting. When Redis is absent, the limiter SHALL fall back to `RateLimiterMemory` for single-instance in-memory counting.

#### Scenario: Redis available — distributed counting
- **WHEN** `REDIS_URL` or `REDIS_HOST` is set and the Redis client connects
- **THEN** auth rate limits are enforced via Redis atomic counters shared across all application instances

#### Scenario: Redis absent — single-instance fallback
- **WHEN** no Redis connection environment variables are set
- **THEN** auth rate limits are enforced via in-memory counters local to each application instance, AND a `warn` log message is emitted indicating the degraded single-instance mode

#### Scenario: Redis connection lost at runtime
- **WHEN** Redis is configured but not ready, or a Redis command fails during `consume()`
- **THEN** the attempt is counted by a per-instance in-memory insurance limiter with the same thresholds (the request neither hangs nor bypasses the limit), AND a `warn` log records the transition to degraded mode once, AND an `info` log records recovery

#### Scenario: Unexpected backend error
- **WHEN** the limiter fails with an error that is not a rate-limit rejection and is not absorbed by the insurance limiter
- **THEN** the request is allowed (fail-open) AND a `warn` log records the error

### Requirement: Preserved rate limit thresholds
The rate limits for the three auth actions SHALL remain unchanged: identify = 30 requests per minute, login = 10 requests per minute, accept = 10 requests per minute.

#### Scenario: identify rate limit
- **WHEN** more than 30 identify requests are made within 60 seconds from the same identity+address
- **THEN** the 31st and subsequent requests receive a 429 response with `Retry-After` header

#### Scenario: login rate limit
- **WHEN** more than 10 login requests are made within 60 seconds from the same identity+address
- **THEN** the 11th and subsequent requests receive a 429 response with `Retry-After` header

#### Scenario: accept rate limit
- **WHEN** more than 10 accept requests are made within 60 seconds from the same identity+address
- **THEN** the 11th and subsequent requests receive a 429 response with `Retry-After` header

### Requirement: Preserved API surface
The `throttleAuth()` function SHALL keep its existing arguments (a `NextRequest`, an action name, and an optional supplemental identity string) and SHALL resolve to `NextResponse | null`. It is async because the distributed backend is Promise-based; callers only add `await`.

#### Scenario: Existing callers unaffected
- **WHEN** the `identify`, `login`, and `accept` route handlers call `await throttleAuth(request, action, supplemental)`
- **THEN** the arguments and the 429 error response format (`RATE_LIMITED` code, `Retry-After` header) are identical to the pre-migration implementation

### Requirement: Cross-instance consistent counting
When Redis is available, all application instances SHALL share counters for the same key.

#### Scenario: Load-balanced attempts are merged
- **WHEN** two application instances share one Redis and receive alternating attempts for the same identity (or trusted address)
- **THEN** the combined attempts count against one limit, and both instances return 429 once it is exhausted

### Requirement: Preserved anti-bypass design
The XFF trusted proxy chain validation, identity-only fallback when no trusted address exists, and dual-key (identity + address) strategy SHALL be preserved unchanged.

#### Scenario: XFF trusted address extraction
- **WHEN** `AUTH_TRUST_PROXY=true` and a valid `x-forwarded-for` header with the configured hop count is present
- **THEN** the trusted address is extracted and used for both identity-key and address-key rate limiting

#### Scenario: No trusted address — identity-only limiting
- **WHEN** no trusted address can be determined (proxy not configured, invalid XFF, etc.)
- **THEN** only the identity-based key is used for rate limiting, with no shared global bucket

#### Scenario: Dual-key enforcement
- **WHEN** a trusted address exists
- **THEN** both an identity-scoped key and an address-scoped key are checked, and a 429 is returned if either is exhausted
