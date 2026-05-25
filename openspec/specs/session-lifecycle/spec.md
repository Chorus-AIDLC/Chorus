# session-lifecycle Specification

## Purpose

Defines the persisted state machine and read-path semantics for `AgentSession` rows. The capability covers: (a) the two-state model `{active, closed}` with no `inactive` state, (b) the query-time staleness filter (`status='active' AND lastActiveAt > now - 1h`) applied on default UI listings only, (c) the unfiltered MCP / audit-trail reads that preserve plugin-reuse and history navigation, (d) the implicit-heartbeat contract whereby every session-touching MCP tool refreshes `lastActiveAt` on success (with a closed-session guard), and (e) the deliberate decoupling of session lifecycle from task status — closing a session checks out task checkins but does not mutate `Task.status`.

## Requirements
### Requirement: AgentSession persisted state space SHALL be exactly `{active, closed}`

The `AgentSession.status` column MUST persist only the values `active` or `closed` from this change forward. The `inactive` value MUST NOT appear as a default and MUST NOT be written by any service code after this change lands. "Stale" is a derived predicate on `lastActiveAt`, never a stored state.

Project policy bars DML in Prisma migrations, so pre-existing rows carrying `status='inactive'` are NOT actively rewritten. Instead, the new state machine and read paths treat any residual `'inactive'` row as semantically equivalent to a closed session — it never matches the `status='active'` filter that gates default-list visibility, and it never re-enters circulation because the only code path that previously revived it (`heartbeatSession`'s `inactive → active` branch) is removed by this change.

#### Scenario: Pre-existing inactive rows are excluded from default-list reads

- **GIVEN** a database that already contains one or more `AgentSession` rows with `status='inactive'` (residue from a prior version)
- **WHEN** the Settings page per-agent session list, the project worker-avatar header, or any other default-list read path is loaded
- **THEN** none of those `'inactive'` rows MUST appear in the response
- **AND** no migration or runtime code path MUST issue an `UPDATE` to rewrite their `status` value (DDL-only migration policy)

#### Scenario: No service code path produces an inactive row

- **GIVEN** any happy-path or error-path call to a function in `src/services/session.service.ts`
- **WHEN** the call completes
- **THEN** the resulting row's `status` MUST be one of `active` or `closed`
- **AND** the source code of `src/services/session.service.ts` MUST NOT contain the literal string `"inactive"` after this change

#### Scenario: heartbeatSession does not contain a status-recovery branch

- **GIVEN** the function `heartbeatSession` in `src/services/session.service.ts`
- **WHEN** the file is read
- **THEN** the function body MUST NOT contain any branch whose effect is to transition a row from any status to `active` based on the prior status value
- **AND** the function body MUST refresh `lastActiveAt` unconditionally on the resolved session

### Requirement: The unused `expiresAt` field SHALL be removed

The `AgentSession.expiresAt` column MUST be removed from the Prisma schema and the underlying PostgreSQL table. No application code reads it today, so removing it has no behavioral side-effect; the removal eliminates a misleading affordance ("looks like sessions auto-expire" — they don't).

#### Scenario: Prisma schema no longer declares expiresAt

- **GIVEN** the file `prisma/schema.prisma`
- **WHEN** the file is read
- **THEN** the `AgentSession` model MUST NOT declare a field named `expiresAt`

#### Scenario: Database migration drops the column

- **GIVEN** a Postgres database upgraded through this change's migration
- **WHEN** the table `AgentSession` is inspected with `\d "AgentSession"`
- **THEN** the column `expiresAt` MUST NOT appear

#### Scenario: Service layer no longer references expiresAt

- **GIVEN** the file `src/services/session.service.ts`
- **WHEN** the file is read
- **THEN** it MUST NOT contain the identifier `expiresAt` in any function signature, body, or type
- **AND** the function `createSession` MUST NOT accept an `expiresAt` parameter

### Requirement: Default-list session reads SHALL filter by `status='active' AND lastActiveAt > now - 1h`

Read paths whose purpose is "show currently working sessions" — specifically the Settings page's per-agent session list and the project page's worker-avatar header — MUST apply a staleness filter so that sessions whose `lastActiveAt` is older than 1 hour are not surfaced even if their persisted status is still `active`. The threshold is a single named constant (`SESSION_STALE_THRESHOLD_MS = 60 * 60 * 1000`).

#### Scenario: Settings page list excludes stale active sessions

- **GIVEN** an agent with two `active` sessions: session A with `lastActiveAt = now - 10min`, session B with `lastActiveAt = now - 2h`
- **WHEN** the Settings page loads the agent's session list (via the dedicated UI-facing service entry point)
- **THEN** the response MUST include session A
- **AND** the response MUST NOT include session B
- **AND** the response MUST NOT include any `closed` session

#### Scenario: Project worker-avatar header excludes stale active sessions

- **GIVEN** a project with three `active` sessions checked into its tasks: session X with `lastActiveAt = now - 5min`, session Y with `lastActiveAt = now - 90min`, session Z with `lastActiveAt = now - 30min`
- **WHEN** `getActiveSessionsForProject` is called for that project
- **THEN** the returned worker list MUST include the agents behind sessions X and Z
- **AND** the returned worker list MUST NOT include the agent behind session Y solely on the basis of session Y

#### Scenario: Threshold cutoff is exactly 1 hour

- **GIVEN** a session with `status='active'` and `lastActiveAt = now - exactly 1h - 1ms`
- **WHEN** the Settings UI list is loaded
- **THEN** the session MUST NOT be returned
- **AND** if the same session's `lastActiveAt` is bumped to `now - 1h + 1ms` and the list is re-loaded, the session MUST be returned

### Requirement: Audit-trail and plugin-reuse session reads SHALL NOT apply the staleness filter

Read paths whose purpose is "navigate session history" or "look up a specific session by UUID" MUST NOT apply the staleness filter. This explicitly covers the `chorus_list_sessions` MCP tool (used by the plugin's sub-agent reuse logic), the `chorus_get_session` MCP tool, the REST `GET /api/sessions/[uuid]` endpoint, and the Activity-stream's denormalized `sessionUuid` dereference. Filtering these would either break plugin reuse (forcing spam-creation of new sessions) or break the audit trail (history links 404).

#### Scenario: chorus_list_sessions returns stale and closed sessions

- **GIVEN** an agent with three sessions: one active+fresh, one active+stale (last active 3h ago), one closed
- **WHEN** the agent calls `chorus_list_sessions` with no `status` filter argument
- **THEN** all three sessions MUST appear in the response
- **AND** when the agent calls `chorus_list_sessions({ status: "active" })` both active sessions (fresh and stale) MUST appear

#### Scenario: chorus_get_session returns a stale session by UUID

- **GIVEN** a session with `status='active'` and `lastActiveAt = now - 4h`
- **WHEN** the agent calls `chorus_get_session({ sessionUuid: <that uuid> })`
- **THEN** the call MUST succeed with that session in the response

#### Scenario: Activity-stream session dereference resolves stale sessions

- **GIVEN** an Activity row whose denormalized `sessionUuid` points to a session that has been stale for 24h
- **WHEN** the Activity stream is rendered and the session name is resolved through `getSessionName`
- **THEN** `getSessionName` MUST return the session's name string, not null

### Requirement: Every session-touching MCP tool SHALL refresh `lastActiveAt` on its successful path

Each MCP tool that takes a `sessionUuid` parameter and successfully resolves the session MUST update that session's `lastActiveAt` to `new Date()` before returning. This bakes "any session activity counts as a heartbeat" into the protocol so plugins no longer need to remember to call `chorus_session_heartbeat` explicitly during normal operation.

The tools in scope are: `chorus_get_session`, `chorus_close_session`, `chorus_reopen_session`, `chorus_session_checkin_task`, `chorus_session_checkout_task`, `chorus_session_heartbeat`. The standalone `chorus_session_heartbeat` is preserved for explicit keep-alive (e.g. an idle plugin pinging itself).

#### Scenario: chorus_session_checkin_task refreshes lastActiveAt

- **GIVEN** an active session whose `lastActiveAt` is `T0`
- **WHEN** the agent calls `chorus_session_checkin_task` for that session at time `T1 > T0`
- **THEN** the call MUST succeed
- **AND** a subsequent fetch of the session MUST report `lastActiveAt >= T1`

#### Scenario: chorus_session_checkout_task refreshes lastActiveAt

- **GIVEN** a session that has previously checked into a task and whose `lastActiveAt` is `T0`
- **WHEN** the agent calls `chorus_session_checkout_task` for that session at time `T1 > T0`
- **THEN** the call MUST succeed
- **AND** a subsequent fetch MUST report `lastActiveAt >= T1`

#### Scenario: chorus_get_session refreshes lastActiveAt

- **GIVEN** an active session whose `lastActiveAt` is `T0`
- **WHEN** the agent calls `chorus_get_session` for that session at time `T1 > T0`
- **THEN** the response MUST include the session
- **AND** a subsequent independent fetch of the same session MUST report `lastActiveAt >= T1`

#### Scenario: chorus_reopen_session refreshes lastActiveAt and transitions to active

- **GIVEN** a session with `status='closed'` and `lastActiveAt = T0`
- **WHEN** the agent calls `chorus_reopen_session` at time `T1 > T0`
- **THEN** the session's `status` MUST become `active`
- **AND** the session's `lastActiveAt` MUST be `>= T1`

### Requirement: closeSession SHALL preserve task status (no zombie-cleanup coupling)

`closeSession` MUST checkout every active session-task checkin (set `checkoutAt = now`) but MUST NOT alter the `status` of any underlying `Task`. Task lifecycle and session lifecycle are deliberately decoupled: a task that was being worked on by a now-closed session remains in whatever status it was in (e.g. `in_progress`, `to_verify`) so another agent or a human can pick it up. This is a contract pinning, not a behavior change — current code already satisfies it; the requirement exists to prevent regressions during this refactor.

#### Scenario: Closing a session leaves checked-in task statuses unchanged

- **GIVEN** an active session checked into a task whose `status='in_progress'`
- **WHEN** `chorus_close_session` is called for that session
- **THEN** the session's `status` MUST become `closed`
- **AND** the corresponding `SessionTaskCheckin.checkoutAt` MUST be set to `now`
- **AND** the task's `status` MUST remain `in_progress`
- **AND** no task-level state-change Activity MUST be emitted as a side effect of the session close

### Requirement: Closed sessions SHALL be retained indefinitely (no auto-deletion)

Closed sessions MUST NOT be hard-deleted, soft-deleted, archived, or pruned by any sweeper, cron job, or migration introduced by this change. The accumulation problem is solved exclusively by the default-list filter (preceding requirement) plus the `status='active'` clause within it. Historical closed sessions remain queryable indefinitely for audit and Activity-stream link integrity.

#### Scenario: No sweeper exists that deletes closed sessions

- **GIVEN** the entire repository after this change
- **WHEN** `src/`, `prisma/migrations/`, and any `bin/` or worker entry points are searched
- **THEN** no code path MUST exist that calls `prisma.agentSession.delete*` on rows whose `status` is `closed`
- **AND** no scheduled job, cron entry, or `setInterval` MUST exist that targets `AgentSession` rows for deletion

#### Scenario: An old closed session is still fetchable by UUID

- **GIVEN** a session with `status='closed'` and `closedAt` 90 days in the past
- **WHEN** the agent calls `chorus_get_session({ sessionUuid: <that uuid> })`
- **THEN** the call MUST succeed and return that session

### Requirement: A `lastActiveAt` index SHALL exist on `AgentSession`

The `AgentSession` model in `prisma/schema.prisma` MUST declare a non-unique index on `lastActiveAt`, and the corresponding Postgres index MUST exist after migration. The default-list filter's `lastActiveAt > now - 1h` predicate is hot enough (every Settings page load, every project page worker-avatar load) that a sequential scan would degrade noticeably as `AgentSession` row count grows.

#### Scenario: Prisma schema declares the index

- **GIVEN** the `AgentSession` model in `prisma/schema.prisma`
- **WHEN** the file is read
- **THEN** the model MUST contain `@@index([lastActiveAt])`

#### Scenario: Database has the matching index

- **GIVEN** a Postgres database upgraded through this change's migration
- **WHEN** `\di "AgentSession"*` is run
- **THEN** an index whose definition references the `lastActiveAt` column MUST be present

