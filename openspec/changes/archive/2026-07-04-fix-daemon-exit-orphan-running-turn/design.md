# Technical Design: Fix daemon-exit orphan `running` turns

## Overview

Give `DaemonSessionTurn` a terminal `interrupted` state and make sure every path a daemon can die on converges an in-flight turn to a terminal state:

- **Daemon-reported** (graceful shutdown, user interrupt, subprocess crash): the waker's existing exit report becomes outcome-aware and can report `interrupted` with a reason.
- **Server-inferred** (`kill -9`, machine sleep, network loss, daemon never comes back): server-side reconcile finalizes `running` turns whose owning connection is effectively offline, as `interrupted(offline)`.

No turn is ever auto-re-dispatched (elaboration q2): `interrupted` is terminal; the human decides whether to re-send. `pending` turns are deliberately untouched — they are the reconnect-backfill's job and re-deliver correctly today.

## Data Model

`DaemonSessionTurn` changes (DDL-only migration via `pnpm db:migrate:dev`):

```prisma
status            String  @default("pending") // pending | running | ended | interrupted
interruptedReason String? // null | user | crash | shutdown | offline — set iff status == interrupted
```

`status` is already a free-form string column (comment-documented enum), so only `interruptedReason` is a new column. `endedAt` is set on the `interrupted` transition too — an interrupted turn has a definite end time (used by elapsed rendering).

Reason vocabulary (superset of `DaemonExecution.interruptedReason`):

| reason | set by | meaning |
|---|---|---|
| `user` | daemon | authorized user interrupt stopped the subprocess |
| `crash` | daemon | subprocess exited dirty (non-zero / null) with no interrupt requested |
| `shutdown` | daemon | daemon graceful shutdown (SIGINT/SIGTERM) killed the subprocess |
| `offline` | server | connection went effectively offline with the turn still `running` |

## State machine (`daemon-session.service.ts`)

`NEXT_TURN_STATUS` becomes a set-valued edge map:

```
pending     → { running }
running     → { ended, interrupted }
ended       → {}          (terminal)
interrupted → {}          (terminal)
```

All other rules are unchanged: no skips (`pending → interrupted` is illegal — a pending turn is recoverable via backfill and must stay pending), no backward moves, same-status re-apply rejected, `invalid_transition` writes nothing. `advanceTurn` gains `interruptedReason` in its opts, persisted only on the `→ interrupted` edge; the `turn_status_changed` SSE trigger fires exactly as for `ended`.

**Late-report convergence:** if the server already finalized a turn `interrupted(offline)` and the daemon later reports `running → ended` (e.g. a >90s network partition where the subprocess actually finished), the report is rejected as `invalid_transition` and logged — the existing daemon-side rule (log, never crash the run) applies. Both sides are terminal; the turn stays `interrupted`. Transcript ingest does NOT check turn status, so messages that arrive late still append (history preserved).

## Server-side orphan reconcile

Liveness anchor: a turn's owner is `turn.session.originConnectionUuid` (continuation is origin-pinned), NOT the execution row's connection.

**Orphan-eligibility rule (stricter than the read API's "effectively offline"):** a turn is orphan-eligible only when its origin connection's `lastSeenAt` is older than `STALE_THRESHOLD_MS` (90s, the registry's single constant — no second timeout). The rule is **age-only, deliberately NOT the OR-rule** (`status !== "online" || stale`) the execution read gate uses: `markDisconnected` flips `status` to `offline` the instant an SSE stream aborts, so under the OR-rule a session read landing in a transient abort→reconnect gap would falsely finalize a genuinely live turn (whose daemon then gets its `running → ended` rejected). Age-only is safe in both directions: a live daemon's 30s heartbeat keeps `lastSeenAt` fresh (never eligible), and a daemon that died without an abort (hard kill, sleep) goes stale within 90s even while `status` still reads `online`. Both reconcile triggers below use this same rule.

New service function `reconcileOrphanTurns(companyUuid, connectionUuid)` in `daemon-session.service.ts`:

1. Find sessions with `originConnectionUuid = connectionUuid` that have `running` turns.
2. Re-check the connection is orphan-eligible (age-only rule above) — the guard that makes every caller safe.
3. For each such turn, `advanceTurn(turn, "interrupted", { interruptedReason: "offline", endedAt: now })` — routing through the chokepoint keeps SSE emission and legality checks in one place.
4. Swallow-and-log its own errors when called from fire-and-forget paths (mirrors `reconcileOffline`).

Two triggers (elaboration q3 = event-driven + read-time fallback):

- **Deferred abort trigger:** the SSE abort handlers (`/api/events`, `/api/events/notifications`) — where `markDisconnected` + execution `reconcileOffline` already fire — additionally schedule `reconcileOrphanTurns` after `STALE_THRESHOLD_MS`. The delay (vs. executions' immediate flip) exists because SSE streams reconnect transiently; step 2's age-only re-check makes the deferred run a no-op when the daemon came back (a reconnected daemon's heartbeat refreshed `lastSeenAt`). A lost timer (server restart) is covered by the read-time fallback.
- **Read-time fallback:** the session read paths (single-session transcript read and session list) detect `running` turns whose origin connection is orphan-eligible (age-only: `lastSeenAt` stale past 90s — NEVER on `status` alone, see the rule above) and invoke the same reconcile inline (write-through, not a view-only mask — unlike executions' read-time gate, because turns are durable conversation history and must converge in the DB). This also converges pre-existing dirty rows on next access with zero migration DML (q5, entailed by the q3 read-time-fallback choice).

## CLI daemon graceful shutdown (elaboration q4 = interrupt-and-report)

- `cli/waker.mjs` gains a shutdown mode: a `shuttingDown` flag plus `interruptAll()` that marks every running entry as shutdown-interrupted and kills each live child via the existing `killProcessTree` escalation (SIGINT → SIGKILL, existing `sigintTimeoutMs`).
- The waker's exit report (currently always `running → ended`) becomes **outcome-aware**, mirroring what the execution row already records:
  - clean exit (code 0) → `ended`
  - `interrupting` flag (user interrupt) → `interrupted(user)`
  - `shuttingDown` flag → `interrupted(shutdown)`
  - otherwise (dirty exit) → `interrupted(crash)`
- `cli/daemon.mjs` `stop()` orders: stop taking new wakes (disconnect SSE first) → `waker.interruptAll()` → await in-flight wake promises (bounded by the kill escalation, plus a hard cap) so their turn-advance reports flush → disconnect MCP → exit. The signal handler awaits `stop()` as today.
- **Execution-row report gated during shutdown:** a shutdown-killed subprocess exits dirty with no user-interrupt flag, which the waker's existing exit logic would report as execution `interrupted(crash)` — a STICKY state that `reconcileOffline` deliberately skips and the read gate keeps showing, so every Ctrl-C would strand a crash-interrupted execution row. Therefore the waker's execution interrupt report gains a `!shuttingDown` gate: during shutdown, no execution interrupt is reported at all; the row is left `running` and the existing execution `reconcileOffline` flips it `ended` when the stream drops. Outside shutdown, execution reporting is byte-for-byte unchanged (sticky user-interrupt resumability, crash reporting).
- `cli/turn-reporter.mjs` + `cli/daemon-rest-client.mjs`: `advanceTurn` payload gains optional `interruptedReason`; `/api/daemon/turn-advance` route validates `status ∈ {running, ended, interrupted}` and `interruptedReason ∈ {user, crash, shutdown}` (daemon may not claim `offline` — that verdict is the server's).

## UI

`interrupted` is a terminal state with a distinct, quiet presentation (elaboration q6 — reuse the existing "interrupted" vocabulary, no new interaction):

- `turn-band.tsx`: `interrupted` renders like `ended` structurally (no pulse, no spinner, quiet spine) with an "Interrupted" badge in a warning-muted tone; reason is available for the label/tooltip (`offline`/`shutdown`/`crash`/`user` can share one generic "Interrupted" label — per-reason copy optional).
- `transcript-view.tsx` header badge: unchanged logic — an interrupted turn is simply not `running`; the `turns.find(running)` probe naturally stops matching once reconciled.
- `conversation-list.tsx`: running-dot logic unchanged (`status === "running"` only).
- i18n: `daemonChat.turnStatusInterrupted` (+ any reason strings) in **both** `messages/en.json` and `messages/zh.json`.

## Module Contracts

- `advanceTurn(turnUuid, status, opts)` — opts gains `interruptedReason?: string | null`; persisted only on `→ interrupted`. Return shape unchanged (`AdvanceTurnResult`).
- `reconcileOrphanTurns(companyUuid, connectionUuid): Promise<number>` — returns count finalized; never throws on the fire-and-forget path.
- REST `/api/daemon/turn-advance` body: `{ connectionUuid, sessionId, status, entityType?, entityUuid?, interruptedReason? }`.
- `TurnView` gains `interruptedReason: string | null` (serialized to the UI and in SSE `turn_status_changed`).

## Risks & Mitigations

- **False interrupt on transient disconnect** → both triggers use the age-only orphan-eligibility rule (`lastSeenAt` stale past 90s, never `status` alone) re-verified at write time; the abort trigger is additionally deferred by the same window.
- **Duplicate reconcile racing the daemon's own report** → all writes go through `advanceTurn`'s legality check; whichever terminal write lands first wins, the loser gets `invalid_transition` (logged, harmless).
- **Multi-instance servers** → the deferred timer is per-instance and best-effort; the read-time fallback is instance-independent and authoritative. Both are idempotent through the state machine.
- **Turn/execution divergence** (turn `interrupted(crash)` vs execution sticky `interrupted`) → intentional: turn = conversation history fact, execution = live resumability fact; they already diverge for `ended`.
