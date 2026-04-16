# Logging Architecture

Chorus uses a structured logging system built on [pino](https://github.com/pinojs/pino) for the server side and a lightweight wrapper for the client side. All `console.*` calls have been replaced — an ESLint `no-console` rule enforces this going forward.

## Modules

| Module | Path | Runtime | Description |
|--------|------|---------|-------------|
| **Server Logger** | `src/lib/logger.ts` | Node.js / Edge | pino-based logger with child logger factories |
| **Client Logger** | `src/lib/logger-client.ts` | Browser | Thin wrapper over `console.*` with level gating and `[Chorus]` prefix |
| **Request Context** | `src/lib/request-context.ts` | Node.js | `AsyncLocalStorage`-based context propagation (requestId, companyUuid) |

## Server Logger

### Log Levels

pino's built-in levels (lowest → highest): `trace` (10) → `debug` (20) → `info` (30) → `warn` (40) → `error` (50) → `fatal` (60).

Chorus uses four: **debug**, **info**, **warn**, **error**.

### Output Format

| Condition | Format |
|-----------|--------|
| `NODE_ENV !== "production"` (local dev) | Colorized pretty output via [pino-pretty](https://github.com/pinojs/pino-pretty) transport |
| `NODE_ENV === "production"` (Docker / ECS) | Newline-delimited JSON to stdout (CloudWatch / ELK ready) |
| Edge Runtime (middleware) | Always JSON — Edge loads `pino/browser.js` which silently ignores the transport option |

pino-pretty is a devDependency loaded via pino's `transport` option in development only. In production builds, the transport config is excluded entirely so webpack never encounters pino-pretty's Node.js-specific imports.

### Child Loggers

Module-scoped child loggers add a `module` field to every log line:

```typescript
import logger from "@/lib/logger";

const redisLogger = logger.child({ module: "redis" });
redisLogger.info({ name: "cache" }, "Connected");
// → { level: 30, module: "redis", name: "cache", msg: "Connected", ... }
```

Current child loggers: `middleware`, `redis`, `event-bus`, `notification-listener`, `presence`, `prisma`, `mcp`.

### Request Context

API routes wrapped with `withErrorHandler` (from `src/lib/api-handler.ts`) automatically get:

1. A `requestId` (UUID) generated per request
2. An `AsyncLocalStorage` store containing the requestId and a child logger
3. Any code in the call chain can call `getRequestLogger()` to get the context-enriched logger

```typescript
import { getRequestLogger } from "@/lib/request-context";

// Inside an API route handler:
const log = getRequestLogger();
log.error({ err }, "Something failed");
// → { requestId: "abc-123", err: { ... }, msg: "Something failed", ... }
```

**Edge Runtime limitation:** `src/middleware.ts` runs in Edge Runtime where `AsyncLocalStorage` is unavailable. Middleware uses a module-scoped child logger (`mwLogger`) with explicit context instead.

### Prisma Integration

Prisma query, warn, and error events are routed through pino:

| Prisma Event | pino Level | Visible When |
|-------------|------------|--------------|
| `query` | `debug` (20) | `LOG_LEVEL=debug` (dev default) |
| `warn` | `warn` (40) | Always (unless `LOG_LEVEL=error`) |
| `error` | `error` (50) | Always |

Query logs include `duration` (ms) for performance monitoring. In production (`LOG_LEVEL=info`), query logs are automatically suppressed.

## Client Logger

`clientLogger` is a zero-dependency wrapper that:

- Prefixes all messages with `[Chorus]` for easy DevTools filtering
- Gates output by level — production suppresses `debug` and `info`
- Delegates to native `console.debug/info/warn/error` (preserves browser stack traces)

```typescript
import { clientLogger } from "@/lib/logger-client";

clientLogger.error("Failed to fetch", error);
// DevTools: [Chorus] Failed to fetch Error: ...
```

## Environment Variables

| Variable | Scope | Default | Description |
|----------|-------|---------|-------------|
| `LOG_LEVEL` | Server | `debug` (dev) / `info` (prod) | Minimum server log level. Accepts: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent` |
| `NEXT_PUBLIC_LOG_LEVEL` | Client | `debug` (dev) / `warn` (prod) | Minimum browser log level. Accepts: `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | Both | — | Controls default levels and whether pino-pretty is loaded |

### Examples

```bash
# Development (default) — pretty output, all levels visible
pnpm dev

# Development — suppress Prisma query noise
LOG_LEVEL=info pnpm dev

# Development — only errors
LOG_LEVEL=error pnpm dev

# Production / Docker — JSON output, info and above
NODE_ENV=production node .next/standalone/server.js

# Silence all server logs
LOG_LEVEL=silent pnpm dev
```

## ESLint Enforcement

`eslint.config.mjs` includes:

```javascript
{ rules: { "no-console": "warn" } }
```

Only `src/lib/logger-client.ts` is exempted via inline `eslint-disable` comments (it must wrap `console.*` by design). All other files must use `logger` or `clientLogger`.

## Adding Logs to New Code

**Server-side (API routes, services, lib, MCP tools):**

```typescript
import logger from "@/lib/logger";

// Simple
logger.info("Server started");

// With structured data
logger.error({ err, userId }, "Failed to process request");

// Module-scoped (for long-lived modules)
const myLogger = logger.child({ module: "my-module" });
myLogger.warn({ retryIn: 5000 }, "Connection lost, retrying");
```

**Client-side (React components, contexts, pages):**

```typescript
import { clientLogger } from "@/lib/logger-client";

clientLogger.error("Failed to load data", error);
clientLogger.debug("Component mounted");
```
