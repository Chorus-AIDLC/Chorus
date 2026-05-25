# Technical Design: session-lifecycle-active-only

## Overview

Collapse `AgentSession.status` to `{active, closed}`, retire the unused `expiresAt` field, and express "stale" as a query-time predicate on `lastActiveAt` rather than a persisted state. Make every session-touching MCP tool implicitly refresh `lastActiveAt`, so the plugin no longer needs to remember to send standalone heartbeats during normal operation.

This is a one-shot migration plus a small surface-area refactor; there is no feature-flag or staged rollout because the persisted-state simplification is one-way and the affected views (Settings sessions list, project worker avatars) are improved by the filter, not destabilized by it.

## Architecture

### State machine (after change)

```
                +------------+
   (create) --> |   active   | --(closeSession)--> +--------+
                +------------+                     | closed |
                       ^   ^                       +--------+
                       |   |                            |
                       |   +---- (any session-touching  |
                       |          tool refreshes        |
                       |          lastActiveAt = now)   |
                       +-------- (reopenSession) -------+
```

Two persisted states. `inactive` is gone. "Staleness" is computed at read time as `lastActiveAt < now - SESSION_STALE_THRESHOLD_MS` (1 hour).

### Read-path matrix (which queries apply the filter)

| Caller | Path | Filter applied? |
|---|---|---|
| Settings page per-agent session list | service: `listAgentSessionsForUI` (new dedicated entry point) | **YES** — `status='active' AND lastActiveAt > now - 1h` |
| Project page worker-avatar header | service: `getActiveSessionsForProject` | **YES** |
| MCP `chorus_list_sessions` | service: `listAgentSessions` | **NO** (plugin reuse depends on seeing all) |
| MCP `chorus_get_session`, REST `GET /api/sessions/[uuid]` | service: `getSession` | **NO** (history navigation) |
| Activity-stream `sessionUuid` deref | service: `getSessionName` | **NO** (denormalized link integrity) |
| Service-layer joins from Task views | service: `batchGetWorkerCountsForTasks` | **YES** — count of active+fresh checkins only |

The filter is enforced in service-layer functions, not in route handlers. New helper:

```ts
const SESSION_STALE_THRESHOLD_MS = 60 * 60 * 1000;
const freshSessionWhereClause = () => ({
  status: "active",
  lastActiveAt: { gt: new Date(Date.now() - SESSION_STALE_THRESHOLD_MS) },
});
```

Two distinct list functions live in the service so we never accidentally leak the filter into the audit-trail path:

```ts
listAgentSessions(...)        // no filter, MCP-facing, plugin reuse
listAgentSessionsForUI(...)   // filtered, Settings page only
```

### Heartbeat-as-side-effect

Every session-touching service function gains an unconditional `lastActiveAt: new Date()` write at the end of its successful path:

| Service function | Triggered by | Refresh? |
|---|---|---|
| `getSession` | `chorus_get_session`, REST GET | YES (read-but-touch is acceptable: this is how plugins implicitly heartbeat by polling their own session) |
| `closeSession` | `chorus_close_session` | YES (then transitions to `closed` — the refresh is semantically irrelevant once closed but cheap and uniform) |
| `reopenSession` | `chorus_reopen_session` | YES (already does this; codify) |
| `sessionCheckinToTask` | `chorus_session_checkin_task` | YES (already does this; codify) |
| `sessionCheckoutFromTask` | `chorus_session_checkout_task` | YES (new) |
| `heartbeatSession` | `chorus_session_heartbeat` | YES (the original purpose, retained as explicit keep-alive) |

Implementation pattern: extract a single private helper `touchLastActiveAt(tx, sessionUuid)` and call it from every entry point above. `getSession` is the controversial one — read operations don't usually mutate — but the alternative is to ask plugins to keep sending standalone heartbeats, which was the original failure mode. The cost of one extra `UPDATE` per session read is negligible and pays for itself by eliminating a whole class of "session looks dead but isn't" bugs.

> **Trade-off recorded.** A read mutating `updatedAt` is a minor breach of REST hygiene. We accept it because the alternative (plugin discipline) is what produced the current bug. If a future caller needs a strictly read-only fetch (e.g. an audit/export job), they should use a new dedicated `getSessionWithoutTouch` rather than re-add inactive-status logic.

## Data Model

### Migration

```sql
-- Step 1: collapse inactive rows to active (their lastActiveAt already encodes staleness)
UPDATE "AgentSession" SET status = 'active' WHERE status = 'inactive';

-- Step 2: drop the unused field
ALTER TABLE "AgentSession" DROP COLUMN "expiresAt";

-- Step 3: support the new staleness filter
CREATE INDEX "AgentSession_lastActiveAt_idx" ON "AgentSession"("lastActiveAt");
```

Prisma schema delta:

```prisma
model AgentSession {
  id              Int       @id @default(autoincrement())
  uuid            String    @unique @default(uuid())
  companyUuid     String
  agentUuid       String
  name            String
  description     String?
  status          String    @default("active")  // active | closed   (was: active | inactive | closed)
  lastActiveAt    DateTime  @default(now())
  // expiresAt    DateTime?                    -- REMOVED
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  taskCheckins    SessionTaskCheckin[]

  @@index([companyUuid])
  @@index([agentUuid])
  @@index([status])
  @@index([lastActiveAt])  // NEW
}
```

We do **not** add an enum constraint at the DB level (the project keeps these as strings everywhere else). The TypeScript type `SessionStatus = "active" | "closed"` enforces it at the application boundary.

## API Design

No new MCP tools. No new REST endpoints. The observable surface change is exclusively the new filter on the two default-list paths and the implicit `lastActiveAt` refresh on the side-effect tools. Tool input/output schemas are unchanged.

> **Naming nit:** the existing `chorus_session_heartbeat` tool stays. It's redundant during normal operation now, but useful for plugin background pingers and idle-timeout extension. Removing it is a separate cleanup — out of scope.

## Module Contracts

Cross-module contract that all session reads must respect:

1. **"Default-list" reads** (Settings page list, project worker avatars, anywhere a list of "currently working sessions" is shown by default) MUST go through a service function whose name ends in `ForUI` and which applies `freshSessionWhereClause`. Calling `listAgentSessions` from a default-list view is a code smell.
2. **"By UUID" reads** (`getSession`, Activity dereference) MUST NOT apply the filter. The caller already has the UUID; filtering would only break history.
3. **"Refresh on touch"**: every service function that takes a `sessionUuid` parameter and successfully resolves it MUST call `touchLastActiveAt` before returning, with the single exception of any future explicit-read-only entry point (none today).

These contracts are recorded in the spec scenarios so that `task-reviewer` can verify them post-implementation.

## Implementation Plan

1. **DB + schema** — migration script; `prisma generate`; restart.
2. **Service layer** — delete dead code (`markInactiveSessions`, the `inactive→active` branch in `heartbeatSession`, all `'inactive'` string literals); add `SESSION_STALE_THRESHOLD_MS`, `freshSessionWhereClause`, `touchLastActiveAt`; split `listAgentSessions` into `listAgentSessions` (unfiltered, MCP) + `listAgentSessionsForUI` (filtered); wire `touchLastActiveAt` into every session-touching path.
3. **MCP tool layer** — verify each `src/mcp/tools/session.ts` handler calls the correct (unfiltered) service function; nothing here changes if the service layer is correct.
4. **REST + UI layer** — point Settings page's session loader at `listAgentSessionsForUI`; verify project worker-avatar header still passes through `getActiveSessionsForProject`'s now-stricter filter. Make sure the per-agent count badge in Settings reflects the filtered count.
5. **Tests** — remove `markInactiveSessions` tests; remove `heartbeatSession` `inactive` recovery test; add tests for: filter cutoff at exactly 1h, default-list paths applying filter, MCP paths not applying filter, side-effect refresh on each session-touching tool.
6. **Docs** — update `docs/MCP_TOOLS.md`, `public/skill/` and `public/chorus-plugin/skills/chorus/` to remove `inactive`-status references and document the implicit-heartbeat contract.

These map 1:1 to task drafts.

## Risks & Mitigations

- **Risk**: existing rows with `status='inactive'` get migrated to `active`, and if any of them have a recent `lastActiveAt` they'll suddenly reappear as "active and fresh" in Settings.
  **Mitigation**: in practice nothing has been calling `markInactiveSessions` so there should be near-zero `inactive` rows in production. The migration log records the row count for audit.

- **Risk**: read-but-touch on `getSession` causes a hot-row write contention if the same session is polled concurrently from many clients.
  **Mitigation**: in current usage a session has at most one writer (the plugin) plus the human user clicking around. Concurrency is bounded by single-digit RPS per session. If we ever hit contention, we add a debounce in `touchLastActiveAt` ("skip update if `now - lastActiveAt < 30s`"). Not adding it preemptively — premature optimization.

- **Risk**: a future read path forgets the `ForUI` naming convention and calls `listAgentSessions` from a default-list view, leaking stale sessions back.
  **Mitigation**: the spec scenarios pin the contract; `task-reviewer` checks both directions (filter applied where required, filter NOT applied where forbidden).

- **Risk**: someone re-introduces an `inactive` literal in a future feature.
  **Mitigation**: TS string-union type makes this a type error at compile time; lint rule unnecessary.

- **Risk**: plugin reuse depends on seeing closed/old sessions by name. If the filter accidentally creeps into `chorus_list_sessions`, plugins will spam-create new sessions on every sub-agent start.
  **Mitigation**: explicit spec scenario forbidding the filter on `chorus_list_sessions`. Reviewer checks.
