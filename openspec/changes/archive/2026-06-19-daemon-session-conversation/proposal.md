## Why

The server has no model of a daemon's Claude **conversation**. A daemon anchors each Claude session on a `directIdeaUuid` and continues it with `claude --resume`, but that session lives only as a transient `--session-id` CLI argument plus an on-disk `~/.claude/projects/<cwd>/<id>.jsonl` transcript — invisible to Chorus. `AgentSession` models swarm sub-agent checkin/checkout (a different thing); `DaemonExecution` models the *live* running/queued snapshot (not durable conversation history). So today a user can see *that* a daemon is running a task, but never *what the agent said*, cannot review a finished session, and has no way to send the agent a new instruction from the UI.

This change adds the missing layer: model the daemon's Claude session as a **persistent conversation (`DaemonSession`)** whose every wake — autonomous task dispatch, @mention, elaboration, resume, and human-typed instruction — is a **turn**. This is the foundation (子1) for sending instructions from the UI (子2) and viewing/continuing a session's transcript (子3). It is derived from the umbrella idea "daemon 会话 = 持久化对话" and reuses the daemon-core observation that an Idea is the mainline and task/@mention/elaboration are turns on it — promoting that line from an on-disk artifact to a first-class entity.

## What Changes

- **New `DaemonSession` model** — one persistent conversation per `(agentUuid, sessionId)`, where `sessionId` is the `directIdeaUuid` (or a server-generated uuid for an ad-hoc session). Carries a **fixed `originConnectionUuid`** (the connection/cwd that owns the on-disk transcript), `directIdeaUuid` (nullable; null ⇒ ad-hoc), `status` (`active` | `ended`), `title`, and `lastTurnAt`. Identity and history survive connection drops and daemon restarts.
- **New `DaemonSessionTurn` model** — one row per wake on a session: `seq`, `trigger` (`task_assigned` | `mentioned` | `elaboration` | `resume` | `human_instruction`), `promptText` (the free-text body for a human instruction; null for autonomous triggers), `status` (`pending` | `running` | `ended`), `startedAt`, `endedAt`.
- **New per-turn transcript storage** — `user` + `assistant` text messages only (no tool calls / thinking / raw output), kept as a **rolling window** (most-recent-N per session) to bound size and privacy exposure.
- **Server creates the turn at the notification chokepoint** — the existing `notification.service` `create`/`createBatch` is where every wake-triggering notification is born; the turn (`status = pending`) is created there, symmetric for human and autonomous triggers. `directIdeaUuid` resolution reuses `lineage.service`.
- **The wake notification carries the instruction text** — for a `human_instruction` turn the notification (recipient = the daemon agent) carries the free-text body as a write-once denormalized copy, so the daemon reads it in the `chorus_get_notifications` call it already makes (zero extra round-trip). The **canonical** text lives on the turn; `reconnect-backfill` re-derives unstarted turns from the turn table, not from notifications — so a lost ping never loses an instruction.
- **New per-turn transcript ingest endpoint** — `POST /api/daemon/transcript` (agent-key, append semantics), distinct from the snapshot-reconcile `execution-state` endpoint, plus an additive SSE push so a viewer sees turns/messages live.
- **Daemon records a turn for every wake** — task_assigned / mentioned / elaboration / resume / human_instruction all become turns on the same `DaemonSession`. The daemon uploads `user`/`assistant` text per turn via the new ingest, landing the previously-no-op `onTranscriptMessage` / `onSessionStart` hooks.
- **Continuation is pinned to the origin connection** — a turn can only be dispatched to the session's `originConnectionUuid`. If that connection is offline, the session is **read-only** (history still visible); it is never transferred to another connection, because `claude --resume` only works in the same cwd on the same machine.
- **Owner-scoped visibility**, consistent with the daemon-connection registry and execution-state rules.

This change delivers the **model + relay + turn-recording** foundation only. It does **not** include the UI send box (子2) or the transcript-viewing / continue-conversation UI (子3).

## Capabilities

### New Capabilities
- `daemon-session-conversation`: the persistent `DaemonSession` + `DaemonSessionTurn` models, server-side turn creation at the notification chokepoint, the wake-notification instruction-text carrier, the per-turn transcript ingest endpoint + SSE, the all-wakes-record-a-turn daemon behavior, origin-connection-pinned continuation, and owner-scoped visibility.

### Modified Capabilities
<!-- None. DaemonExecution (daemon-execution-state) and the wake path (cli-daemon) are REUSED unchanged: DaemonExecution remains the live running/queued snapshot; a turn references its execution row but does not alter execution-state reconcile semantics. The notification model gains a denormalized instruction-text field, but that is an additive column delivered by this new capability, not a behavioral change to an existing spec's requirements. -->

## Impact

- **Schema (Prisma, DDL-only migration)**: new `DaemonSession`, `DaemonSessionTurn`, and per-turn transcript message storage; an additive nullable instruction-text column on `Notification`. `agent` relations cascade-delete consistent with existing models. No data backfill.
- **Server**: turn creation hook in `notification.service`; `directIdeaUuid` resolution via `lineage.service`; new `POST /api/daemon/transcript` ingest + `transcript:{...}` SSE channel; owner-scoped read paths for sessions/turns; reconnect-backfill extended to re-derive unstarted turns.
- **Daemon (npm CLI)**: every wake records turn start/end; `onTranscriptMessage` / `onSessionStart` upload hooks implemented (currently no-op); the daemon reads instruction text from the notification it already fetches; continuation honors `originConnectionUuid`.
- **Reused unchanged**: `DaemonExecution` / `DaemonConnection` models, `WakeQueue` + reconnect-backfill, `control:{connectionUuid}` (still interrupt/resume only), the `directIdeaUuid` lineage anchor.
- **Not in this change**: UI surfaces (子2/子3), full stream-json relay (tool calls / thinking), full-history (non-windowed) storage, multi-agent-driver transcript normalization.
