# Design: Daemon interrupt/resume — server→daemon reverse control channel

## Overview

Build a **reverse** (server→daemon) control path on top of the daemon's existing one-way
SSE subscription, used to **interrupt** a running headless-Claude subprocess and **resume**
it. The guiding constraint, anchored by the umbrella idea's Round-1 answer (Q8=a) and this
sub-idea's q8=a: **reuse the notification SSE transport, but keep control commands off the
wake path**, behind a small control-dispatch interface that a future dedicated channel can
replace.

The single most important design decision is the **non-wake** nature of the control event.
The daemon's whole reason for existing is "a notification with a wake action → spawn a
Claude". An interrupt must do the opposite — *terminate* a running Claude. Therefore the
control command is **not** a persisted `Notification` and **not** a member of
`WAKE_ACTIONS`; it is a separate SSE event `type` the listener forks to a control handler
before the router ever sees it.

## Architecture

### End-to-end flow (interrupt)

```
User clicks "Interrupt" on a running execution row (Agent Connections detail pane)
   │  (UI already knows connectionUuid + {entityType,entityUuid} from the 子2 execution read API)
   ▼
POST /api/daemon/control  { command:"interrupt", targetConnectionUuid, entityType, entityUuid }
   │  authz: caller is the target connection's agent OWNER, or has task:admin  (q2=a)
   │  resolve target connection → its agentUuid → agent.ownerUuid; company-scoped
   ▼
control.service.dispatchControl(...)  →  eventBus.emit(`control:${targetConnectionUuid}`, {...})
   │  (additive event type; Redis fan-out for multi-instance, same as execution events)
   ▼
GET /api/events/notifications stream for that daemon  →  send(`data: {type:"control", ...}`)
   │  (the daemon's OWN connection stream — keyed per connection, see below)
   ▼
cli/sse-listener.mjs #processMessage  →  sees type==="control"  →  onControl(event)   ← NEW fork
   │  (NOT onEvent → router → queue)
   ▼
cli/control-handler.mjs:
   1. event.targetConnectionUuid === this daemon's registered connectionUuid?      (q1=a)
   2. waker.executions.get(`${entityType}:${entityUuid}`)?.child present & running?  (q1=a, q4=a)
      └─ both true → proceed; else ignore (stale connection / not ours)
   ▼
cli/process-killer.mjs.kill(child):  SIGINT → wait sigintTimeoutMs (default 10s) → hard kill tree  (q5=a, q6=a)
   ▼
waker marks the wake interrupted; reports task interrupted(reason="user") via MCP; snapshot drops the row
```

### End-to-end flow (crash)

```
subprocess exits non-zero / errors unexpectedly (no interrupt was requested)
   ▼
waker detects abnormal exit  →  report task status interrupted(reason="crash") via MCP
   ▼
existing reconnect-backfill re-fires the missed/again-dispatched wake automatically  (q7=a)
   →  claude --resume <directIdeaUuid>  (disk transcript exists → isNewSession=false)
```

### Why the control event must reach *the right daemon stream*

`eventBus` channels for notifications are keyed `notification:{recipientType}:{recipientUuid}`
and every one of the agent's daemon streams subscribes to the same key — so a wake
notification fans out to *all* of an agent's connections (acceptable: the WakeQueue + disk
probe dedupe). An interrupt must NOT fan out to every connection, because only one holds the
subprocess. We therefore key the control event **per connection**: `control:{connectionUuid}`.
The daemon's SSE route already knows its `conn.uuid` (it sends `connection_registered`), so
it subscribes that one stream to `control:{conn.uuid}` in addition to the existing
`notification:{userKey}` channel. The `targetConnectionUuid` in the payload is a
defense-in-depth re-check on the daemon side (q1=a), not the routing key alone.

## Data Model

The interrupted state lives on the **execution row**, not on `Task` — the daemon executes
task / idea / proposal / document wakes, so interruption is an execution-lifecycle fact keyed by
the same connection + entity the row already tracks. (`Task.interruptedReason` would only cover
1 of the 4 entity types and would pollute the task domain model with an infra concern — this was
corrected after owner review of the original task-centric draft.)

```prisma
model DaemonExecution {
  // ... existing fields (connectionUuid, entityType, entityUuid, rootIdeaUuid, startedAt) ...
  status            String   // running | queued | ended | interrupted   ← + interrupted (sticky)
  interruptedReason String?  // null | "user" | "crash"  — only set while status == interrupted
}
```

- **`Task` is unchanged.** No `interrupted` status, no `interruptedReason` — the task's domain
  state machine stays clean.
- **`interrupted` is sticky**: snapshot reconcile (absent-from-snapshot → `ended`) and offline
  reconcile only target `running`/`queued` rows, so they never auto-end an `interrupted` row.
  The killed subprocess is gone (absent from the next snapshot), yet the row keeps showing as
  "interrupted, resumable" until a resume re-dispatch reports the entity active again (the
  reconcile upsert then clears `interruptedReason`).
- The `task → subprocess` mapping still lives in daemon memory (`Waker.executions`), never
  persisted (consistent with the daemon's stateless, disk-probe-driven design).
- **Migration**: Prisma-CLI-generated, DDL-only (add column `DaemonExecution.interruptedReason`;
  `status` is a free String so no enum DDL). No backfill (memory: no-DML-in-migrations).
- `Task`, `DaemonConnection`, `AgentSession` are **unchanged**.

### Execution interrupt/resume service (`src/services/daemon-execution.service.ts`)

- `reportExecutionInterrupt(companyUuid, connectionUuid, entityType, entityUuid, reason)` —
  marks the matching row `interrupted` + `interruptedReason`; returns false (→ route 404) when
  no row matches.
- `resumeExecution(companyUuid, connectionUuid, entityType, entityUuid)` — requires
  `interrupted` + `reason=user` (rejects `crash` / non-interrupted as `not_resumable`),
  transitions the row back to `running` clearing the reason.
- Reads (`getVisibleExecutions` / `getExecutionsForConnection`) include the sticky
  `interrupted` status (`DISPLAYABLE_EXECUTION_STATUSES`); the live-connection filter keeps
  `interrupted` rows visible even when the connection has gone offline.
- The `Task` service (`src/services/task.service.ts`) is **not** touched.

## API Design

### `POST /api/daemon/control`  (NEW)

Agent-key **or** user-session callable; **not** an MCP tool (same posture as
`/api/daemon/execution-state` and the root-idea endpoint); no new permission bit. Standard
API envelope (`src/lib/api-response.ts`, wrapped with `withErrorHandler`).

Request body (Zod-validated):

```jsonc
{
  "command": "interrupt",            // enum — only "interrupt" in this slice; "resume" is a task re-dispatch, see below
  "targetConnectionUuid": "uuid",    // which daemon connection holds the subprocess (from 子2 read API)
  "entityType": "task",              // "task" | "idea" | "proposal" | "document" (the execution row's key)
  "entityUuid": "uuid"
}
```

Authorization (q2=a):
1. Resolve `targetConnectionUuid` → its `DaemonConnection` (company-scoped). If it does not
   exist *within the caller's company*, return **404** (do not reveal another company's /
   another owner's connection — same non-disclosure rule as the execution endpoint).
2. Resolve the connection's `agentUuid` → `Agent.ownerUuid`.
3. Allow iff caller is that owner **or** caller has `task:admin`. Else **403**.
4. On success: publish `control:{targetConnectionUuid}` and return `{ success: true }`. The
   endpoint does **not** wait for the kill to complete (fire-and-forward); the daemon records
   the resulting `interrupted` execution state asynchronously via `POST /api/daemon/report-interrupt`.

### `POST /api/daemon/report-interrupt`  (NEW — daemon records the outcome)

The daemon posts here after a wake's subprocess exits interrupted/crashed. Body
`{ connectionUuid, entityType, entityUuid, reason }`; agent-key callable; authz via the shared
`authorizeConnectionControl` (owner or `task:admin`; absent connection → 404 non-disclosure). It
calls `reportExecutionInterrupt` to mark the row `interrupted` + reason, then publishes an
execution change so any UI viewing the connection updates. 404 when no active row matches.

### `POST /api/daemon/resume`  (NEW — the resume trigger, entity-generic)

This is the server action the UI **Resume** button calls. Body
`{ connectionUuid, entityType, entityUuid }`; standard envelope, `withErrorHandler`; authz via
the shared `authorizeConnectionControl`. Keyed on connection + entity — the **same daemon
surface as interrupt**, NOT a Task-level endpoint — so it works for task / idea / proposal /
document wakes alike. Behavior:

0. **Liveness gate (before mutating anything):** the `resume` control command is a transient
   SSE event (not a persisted, backfill-replayed notification), so if the target daemon is
   OFFLINE it would be dropped and the resume silently lost — and a row flipped to `running` on
   an offline connection is hidden by the live-connection read filter, so it would vanish from
   the UI. The route refuses up front via `isConnectionLive(companyUuid, connectionUuid)` (the
   same `status==="online" && lastSeenAt within STALE_THRESHOLD_MS` verdict the reads use):
   400, the row stays `interrupted` (resumable once the daemon reconnects), nothing dispatched.
1. `resumeExecution` requires the row to be `interrupted` with `interruptedReason = "user"` (a
   `crash` is auto-recovered by reconnect-backfill and is NOT manually resumable — q7=a;
   rejected with a 400). Otherwise it transitions the row `interrupted → running`, clearing
   `interruptedReason`.
2. Dispatch a **`resume` control command** on the reverse control channel
   (`control:{connectionUuid}`) to the holding connection, then publish an execution change.
3. The daemon's control handler turns the `resume` command into a synthetic `resource_resumed`
   re-dispatch through the existing router/queue → waker. Because the direct-idea transcript
   already exists on disk, the daemon's `isNewSession` probe selects `--resume <directIdeaUuid>`
   automatically — so the woken Claude continues the SAME session.

So resume is **symmetric with interrupt** — both ride the per-connection control channel and are
entity-generic — while still reusing the existing wake machinery (router → WakeQueue → waker →
`--resume`) for the actual re-spawn. The only new daemon piece is `EventRouter.dispatchResume` +
the `resource_resumed` wake-action/prompt.

### Control SSE event (NEW type, additive)

Published on `control:{connectionUuid}`; delivered on the daemon's existing stream. Shape:

```jsonc
{ "type": "control", "command": "interrupt", "targetConnectionUuid": "uuid", "entityType": "task", "entityUuid": "uuid" }
// command is "interrupt" | "resume"
```

`src/app/api/events/notifications/route.ts` subscribes the per-connection handler to
`control:{conn.uuid}` (only when `conn` is non-null, i.e. a real daemon), and tears it down
on abort alongside the existing notification handler. Browser clients never receive it (they
have no `conn`).

## Module Contracts

Shared conventions so the tasks compose without rework:

- **Control-dispatch interface (q8=a).** Server side, the publish step is a single function
  `dispatchControl({ companyUuid, targetConnectionUuid, command, entityType, entityUuid })`
  in a new `src/services/daemon-control.service.ts`. The route calls only this; the
  notification-stream transport (eventBus emit) lives behind it. A future dedicated channel
  swaps the body of this one function. Daemon side, the symmetric seam is
  `SseListener.onControl(event)` (new optional callback, mirroring `onEvent` / `onConnectionId`).
- **Control event type guard.** `cli/sse-listener.mjs` `#processMessage` already special-cases
  `type === "connection_registered"`. Add a sibling branch: `type === "control"` → call
  `this.onControl(event)` and `continue` (never fall through to `onEvent`). So the router /
  WakeQueue never sees a control event.
- **`Waker.executions` entry gains a child handle.** Extend the entry shape to
  `{ entityType, entityUuid, rootIdeaUuid, status, startedAt, child }` where `child` is the
  live `ChildProcess` (or `null` while queued). `buildExecutionSnapshot()` MUST continue to
  emit only the serializable fields (it maps explicitly — do not spread `child` into the
  uploaded snapshot). The killer reads `child`; the snapshot never sees it.
- **Killer contract.** `cli/process-killer.mjs` exports
  `killProcessTree(child, { sigintTimeoutMs, platform, logger }) → Promise<{ killed: boolean, escalated: boolean }>`.
  It is pure-ish (platform + spawn injectable for tests), never throws into the wake path,
  and logs visibly (memory: no-silent-errors). POSIX: `process.kill(-child.pid, "SIGINT")`
  then after timeout `process.kill(-child.pid, "SIGKILL")` (requires the child be spawned
  `detached: true` so it leads its own process group). Windows: spawn
  `taskkill /PID <pid> /T /F` (there is no graceful per-tree signal on Windows; the SIGINT
  stage is best-effort `child.kill()` on the direct process, then `taskkill /T` escalation).
- **Detached spawn (POSIX).** `cli/claude-spawner.mjs` adds `detached: true` to the POSIX
  spawn options so the child leads a process group `kill(-pgid)` can target. This must NOT
  change stdin prompt delivery or stdout NDJSON parsing. On Windows `detached` is not used
  (taskkill walks the tree by PID).
- **Layered config.** `sigintTimeoutMs` resolves `--sigint-timeout` flag >
  `CHORUS_DAEMON_SIGINT_TIMEOUT` env > `~/.chorus/daemon.json` `sigintTimeoutMs` > default
  `10000`, mirroring the existing credential/concurrency resolution style.
- **Interrupt vs crash reporting.** The waker tracks whether an exit was *interrupt-initiated*
  (the control handler set a per-entity "interrupting" flag) or *unexpected*. On
  interrupt-initiated exit → report `interrupted(reason="user")`. On unexpected non-zero
  exit with no interrupt flag → report `interrupted(reason="crash")`. Clean exit (code 0) is
  unchanged (no interrupted state).

## Implementation Plan

1. **Schema + execution interrupt/resume service** (server): add the sticky `interrupted`
   status + `interruptedReason` to `DaemonExecution` (Prisma-CLI DDL migration), the
   `reportExecutionInterrupt` / `resumeExecution` service methods, sticky reconcile, and reads
   that include `interrupted`. `Task` is untouched. Foundation for everything downstream.
2. **Control endpoint + dispatch service + SSE event** (server): the reverse channel's server
   half — `POST /api/daemon/control` (commands `interrupt` + `resume`), shared
   `authorizeConnectionControl`, `dispatchControl`, the `control:` event type, and the
   per-connection subscription in the SSE route; plus `POST /api/daemon/report-interrupt` and
   `POST /api/daemon/resume`.
3. **Daemon control path + resume re-dispatch** (CLI): SSE listener `control` fork,
   `control-handler.mjs` (connection+entity double-check on interrupt; re-dispatch on resume),
   `process-killer.mjs` (two-stage cross-platform tree kill), detached POSIX spawn, `executions`
   child-handle wiring, entity-generic `interrupt-reporter.mjs`, interrupt-vs-crash reporting,
   layered `sigintTimeoutMs`, `EventRouter.dispatchResume`, and the `resource_resumed`
   wake-action/prompt in `cli/prompts.mjs`.
4. **Frontend interrupt/resume controls** (UI): Interrupt action on running rows, a sticky
   Interrupted section with Resume on `reason=user` rows (auto-recovers hint for `crash`),
   localized strings, `design.pen` update.
5. **Integration checkpoint**: end-to-end interrupt + resume against a real running wake,
   plus crash auto-recovery — exercised together.

## Risks & Mitigations

- **Mis-kill the wrong subprocess after a reconnect (stale `connectionUuid`).** Mitigated by
  the q1=a double-check: connection-uuid match **and** in-memory entity ownership must both
  hold; the entity self-check is authoritative even if a recycled connection uuid leaks.
- **Control event treated as a wake (spawns a new Claude).** Mitigated structurally: control
  is a non-persisted SSE type forked before the router; it is never added to `WAKE_ACTIONS`
  and never enters the `WakeQueue`. A test asserts a `control` event produces zero enqueues.
- **Orphaned grandchildren on POSIX.** Claude may spawn its own children; killing only the
  direct pid leaves orphans. Mitigated by `detached: true` + process-group kill (q6=a).
- **Windows has no SIGINT-to-tree.** `taskkill /T /F` is forceful, not graceful; the graceful
  stage is best-effort on Windows. Documented; the 10s window still applies before escalation.
  The Windows path MUST be verified against a real Windows host before claiming support
  (hallucination-aware: re-verify `taskkill` flags and `child.kill` semantics).
- **Auto-resume overriding user intent.** Mitigated by q7=a: only *crashes* auto-recover via
  reconnect-backfill; *user* interrupts wait for an explicit Resume click.
- **Redis fan-out / multi-instance.** The `control:` channel rides the same eventBus + Redis
  pub/sub as execution events; per-connection keying means only the instance holding that
  daemon's stream delivers it. Verify the additive event type does not collide with existing
  channels.
- **Race: interrupt arrives after the wake already finished.** The entity self-check finds no
  running `child` and the control handler no-ops (logged) — safe.
