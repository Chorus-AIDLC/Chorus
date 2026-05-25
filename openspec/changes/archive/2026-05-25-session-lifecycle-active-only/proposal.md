## Why

The current AgentSession lifecycle is broken: `markInactiveSessions()` is dead code (never called in production), the `expiresAt` schema field is read by nothing, and closed sessions accumulate indefinitely with no cleanup. As a result, the Settings page lists every historical session ever created, the project worker-avatar header shows zombies that have not heartbeated in days, and the `inactive` status — meant as a stale-detector — never fires. Users see a session graveyard and no useful "who is currently working" signal.

We want to collapse the lifecycle to the two states that actually matter (`active`, `closed`), express "stale" as a query-time filter on `lastActiveAt` rather than a persisted status, and make every session-touching MCP tool implicitly refresh `lastActiveAt` so heartbeat is no longer a separate ritual the plugin must remember to perform.

## What Changes

- **BREAKING**: Remove the `inactive` status from `AgentSession.status`. The persisted state space becomes `{active, closed}` only. Existing rows with `status='inactive'` are migrated to `active` (their `lastActiveAt` already encodes whether they are stale).
- **BREAKING**: Remove the `expiresAt` column from `AgentSession`. It was never read.
- Remove the `markInactiveSessions()` service function and its tests; the function is unreferenced in production code.
- Remove the `inactive → active` recovery branch inside `heartbeatSession()`; with no `inactive` state, the branch is dead.
- Add a `lastActiveAt` index on `AgentSession` to support the new filter.
- Introduce a single staleness threshold constant (1h) used by the new query filter.
- **UI behavior change**: list endpoints that drive the Settings page's per-agent session list and the project page's worker-avatar header MUST filter to `status='active' AND lastActiveAt > now - 1h`. Stale-but-not-closed sessions disappear from these defaults.
- **Audit-trail preservation**: `chorus_list_sessions`, `chorus_get_session`, the session detail page, and Activity-stream `sessionUuid` lookups are NOT filtered. Plugin reuse and history navigation continue to see every session.
- **Heartbeat-as-side-effect**: every MCP tool that takes a `sessionUuid` (`chorus_session_checkin_task`, `chorus_session_checkout_task`, `chorus_get_session`, `chorus_close_session`, `chorus_reopen_session`) MUST refresh `lastActiveAt = now()` on the session as part of its successful path. The standalone `chorus_session_heartbeat` tool stays as an explicit keep-alive but is no longer required for correctness.
- **No task-state coupling.** `closeSession` continues to checkout active task checkins but does NOT alter task `status`. Out of scope.
- **No closed-session deletion.** Closed sessions live forever in the database. The hide-from-default behavior is achieved entirely by the filter, not by deletion.

## Capabilities

### New Capabilities

- `session-lifecycle`: persisted state machine (`active`, `closed`), allowed transitions, what each transition does to checked-in tasks, and the "default-list staleness filter" contract that defines which read paths apply the `lastActiveAt > now - 1h` rule and which do not. Also covers the heartbeat-as-side-effect contract for session-touching MCP tools.

### Modified Capabilities

_None._ No existing `openspec/specs/<capability>/spec.md` covers session lifecycle today, so this is a brand-new capability.

## Impact

- **DB migration**: drop `expiresAt` column; backfill `inactive` rows to `active`; add `@@index([lastActiveAt])`. One-way; no rollback path needed because `expiresAt` was never read and `inactive` had no semantic load.
- **Service layer**: `src/services/session.service.ts` — delete `markInactiveSessions`, prune `inactive` branch from `heartbeatSession`, add filter helper, wire `touchLastActiveAt` into all session-touching service calls.
- **MCP tools**: `src/mcp/tools/session.ts` — every handler that resolves a session by UUID gains the side-effect refresh.
- **Default-list endpoints**: REST + service paths that feed the Settings sessions panel and the project worker-avatar header (`getActiveSessionsForProject`, `listAgentSessions` when called from Settings) start applying the staleness filter.
- **Tests**: drop `markInactiveSessions` tests; update `heartbeatSession` tests to remove the `inactive → active` case; add tests for the staleness filter and for the side-effect refresh in each touched tool.
- **Plugin**: no plugin-side changes required. `on-subagent-start.sh`'s reuse query continues to work because `chorus_list_sessions` is unfiltered.
- **Skill / Plugin docs**: `public/skill/`, `public/chorus-plugin/skills/chorus/`, `docs/MCP_TOOLS.md` — remove any mention of `inactive` and `expiresAt`; document the side-effect heartbeat contract.
- **No public API contract break for existing agents.** Tool names and shapes are unchanged; the only observable change is that idle sessions disappear from the Settings list after 1 hour.
