# Fix: daemon exit mid-turn leaves the turn stuck `running` forever

## Why

When a daemon process exits while a turn is in flight — whether killed hard (`kill -9`, crash, machine sleep) or stopped gracefully (Ctrl-C / SIGTERM) — the server is left with dirty state: the `DaemonSessionTurn` stays `running` forever. The UI (transcript header badge, turn band, conversation list) renders "Running" straight off `turn.status`, so the agent looks permanently busy on a turn that will never end.

Root cause (verified in code):

- The turn state machine is strict `pending → running → ended` (`src/services/daemon-session.service.ts` `NEXT_TURN_STATUS`), and the **only** writer of `running → ended` is the daemon's own `POST /api/daemon/turn-advance` call, sent from `cli/waker.mjs` after the headless subprocess exits. No server-side path ever finalizes a turn.
- The daemon's graceful shutdown (`cli/daemon.mjs` `stop()`) only disconnects the SSE listeners and MCP client — it neither stops in-flight subprocesses nor reports any turn terminal state. So even a clean Ctrl-C mid-turn orphans the turn.
- The existing offline reconcile (`reconcileOffline`, fired on SSE abort) flips only `DaemonExecution` rows to `ended`; it never touches `DaemonSessionTurn`.
- Reconnect backfill (`getPendingTurnsForConnection`) reads only `status = "pending"` turns, so a turn orphaned in `running` is invisible to every recovery path.

## What Changes

Per the resolved elaboration (idea `489ade18`, round 1):

1. **New terminal turn state `interrupted`** (elaboration q1: reuse the existing "interrupted" concept, aligned with `DaemonExecution`). Turn state machine becomes `pending → running → ended | interrupted`, with a nullable `interruptedReason` discriminator (`user` | `crash` | `shutdown` | `offline`). `interrupted` is terminal — an orphaned turn is finalized, never auto-retried (q2: finalize only; a turn may have partially executed, so automatic re-dispatch risks duplicate side effects).
2. **Server-side orphan-turn reconcile** (q3: event-driven + read-time fallback). When a daemon connection's `lastSeenAt` goes stale past the existing 90s threshold (age-only rule — never the stored `status` alone, which flips on every transient SSE abort), its sessions' `running` turns are finalized to `interrupted(offline)`: (a) the SSE-abort path arms a deferred reconcile after the staleness window, and (b) session read paths lazily finalize orphaned running turns on access — covering `kill -9`, server restarts, and (as an entailed side effect of the read-time fallback) converging any pre-existing dirty rows.
3. **Daemon graceful shutdown finalizes in-flight turns** (q4: interrupt-and-report). `stop()` interrupts in-flight subprocesses via the existing kill escalation, and the waker's exit path reports the turn terminal state before the process exits — `interrupted(shutdown)` on shutdown; and while touching this path, the exit report becomes outcome-aware generally (`ended` on clean exit, `interrupted(user)` on a user interrupt, `interrupted(crash)` on a dirty exit), matching what the execution row already records.
4. **UI renders interrupted turns distinctly** (q6: reuse the existing "interrupted" presentation vocabulary). Turn band / transcript header / conversation list treat `interrupted` as a terminal, visually quiet state with an "Interrupted" label — no more infinite spinner.
5. **No dedicated legacy-data cleanup** (q5: "不处理存量" — no migration DML, no admin sweep, no extra mechanism built for legacy rows). The convergence of old dirty rows is not a dedicated cleanup: it falls out of the q3 read-time fallback for free, so it is specified and tested as a property of that mechanism rather than as separate legacy-data work.

## Capabilities

- `daemon-session-conversation` (MODIFIED + ADDED): turn state machine gains `interrupted`; server-side orphan reconcile requirements.
- `daemon-rest-client` (MODIFIED): `turn-advance` payload carries the new status and optional reason.
- `cli-daemon` (ADDED): graceful shutdown finalizes in-flight turns before exit.
- `daemon-session-transcript-read` (ADDED): interrupted turn presentation.

## Impact

- **Schema**: `DaemonSessionTurn` gains nullable `interruptedReason` (DDL-only migration via `prisma migrate dev`; `status` is already a free-form string column).
- **Server**: `daemon-session.service.ts` (state machine, reconcile, read-path fallback), `daemon-connection.service.ts` (abort hook wiring), `/api/daemon/turn-advance` route.
- **CLI**: `cli/daemon.mjs` (`stop()`), `cli/waker.mjs` (exit reporting, interrupt-all), `cli/turn-reporter.mjs` / `cli/daemon-rest-client.mjs` (reason field).
- **UI**: `transcript-view.tsx`, `turn-band.tsx`, `conversation-list.tsx`, both locale files.
- **Compat**: a late `running → ended` report arriving after a turn was already finalized `interrupted` is rejected as `invalid_transition` (existing behavior for illegal edges) and logged — both sides converge on a terminal state, no crash.

OpenSpec change slug: fix-daemon-exit-orphan-running-turn
