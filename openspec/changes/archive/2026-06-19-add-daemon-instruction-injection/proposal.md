# Proposal: UI → daemon instruction injection (子2, re-anchored to DaemonSession)

## Why

The original user ask for Chorus 0.11.0 was: *"send an instruction to the agent under a daemon directly from the UI"* — a human types free text in the UI, and the online daemon runs it as the next turn of a Claude session, writing results back through the existing `chorus_*` tools.

The parent idea (`82049113`) reframed every daemon wake — autonomous task dispatch, @mention, elaboration, **and a human-typed instruction** — as one **turn** on a persistent **DaemonSession**. Sending an instruction is therefore *appending a `human_instruction` turn*, not inventing a new command type.

The foundation idea **子1 (`7039f1cf`, PR #332, commit `024c170`)** already shipped that model **plus most of this feature's plumbing**:

- `DaemonSession` / `DaemonSessionTurn` models, keyed `(agentUuid, sessionId)`, with `originConnectionUuid` pinning (`prisma/schema.prisma:494‑560`).
- Turn creation at the single notification chokepoint, symmetric for human and autonomous wakes (`notification-turn.ts:145`); the `human_instruction` action → trigger mapping and the `instructionText` free-text carrier already exist (`notification-turn.ts:70`, `notification.service.ts:151`).
- Ad-hoc sessions: `resolveOrCreateSession()` already accepts `directIdeaUuid = null` and a server-supplied `sessionId` (`daemon-session.service.ts:resolveOrCreateSession`).
- The origin-online gate `assertContinuable()` → `SessionReadOnlyError` (`daemon-session.service.ts`).
- Owner-scoped reads `getVisibleSessions()` / `getSessionTurns()` (`daemon-session.service.ts`).
- The **entire daemon CLI side**: `human_instruction` recognition, prompt build, `--resume`/new-session anchoring (`sessionId = directIdeaUuid ?? entityUuid`), turn lifecycle (`pending→running→ended`), the per-session serial WakeQueue, and reconnect backfill via the connection-scoped `GET /api/daemon/pending-turns` + `dispatchPendingTurn()` (`cli/event-router.mjs`, `cli/waker.mjs`, `cli/backfill.mjs`). **No daemon-execution changes are needed for the happy path.**

So 子2 is **not** a from-scratch feature. It is a thin, two-sided gap on top of 子1.

## What Changes

This change adds the **send side** and closes the **one delivery gap** 子1 left open:

1. **A UI-facing send endpoint** that turns a free-text instruction into a `human_instruction` turn on an existing session — owner-scoped, gated on the origin connection being online (reuses `assertContinuable` → read-only when offline), with a free-text length cap.
2. **Ad-hoc create-and-send**: when there is no idea-anchored session, the user picks one of the agent's online connections; the server generates the `sessionId`, pins the session's origin to the chosen connection, and creates the first `human_instruction` turn.
3. **Owner-scoped read for targeting**: a minimal list of the caller's daemon sessions (and the agent's online connections for the ad-hoc picker), each carrying whether its origin is currently online — enough to drive the send UI. *Full turn-by-turn transcript rendering stays in 子3.*
4. **Origin-only live delivery (the keystone fix).** 子1's spec already mandates "a turn is dispatched only to the origin connection," but the **live** wake path does not yet satisfy it: `notification.service.create()` emits the wake on the agent-wide key `notification:agent:{uuid}` (`notification.service.ts:182`) and the daemon notification stream is per-agent, so an agent with **two** online daemons would fan a `human_instruction` to both — and the non-origin daemon, lacking the cwd-bound on-disk transcript, would spawn a **divergent** session against the same `sessionId`. This change delivers the live `human_instruction` ping to **only the origin connection** by reusing the per-connection `control:{connectionUuid}` channel (子3's interrupt/resume channel) to trigger the same connection-scoped pending-turns sweep that reconnect-backfill already runs.
5. **Frontend send box**: a `Textarea` + send control (and an ad-hoc connection picker) in the existing Agent Connections detail pane, disabled with a reason when no online origin exists. Bilingual (`en`/`zh`) and reflected in `docs/design.pen`.

## Capabilities

- `daemon-instruction-injection` (new): send endpoints, ad-hoc create-and-send, owner-scoped targeting reads, origin-only live delivery, offline gating, and the free-text guard.

## Out of Scope (inherited from the idea)

- **No real-time insertion into a running turn** — `claude -p` is one-shot; an instruction queues as the next turn (the serial WakeQueue already enforces this).
- **No transcript panel / per-turn agent-output rendering** — that is 子3 (`25fe9cb7`).
- **No new `targetConnectionUuid` column on `Notification`** — the parent reframe explicitly rejected adding columns to the core model; delivery targeting reuses the existing per-connection control channel + the turn table.
- **No instruction in the Activity stream** — owner-scoped, instruction text lives only on the turn (总纲 Q8=c).
- **No daemon `claude -p` execution changes** — 子1 already handles `human_instruction` end-to-end on the daemon.
- **No ad-hoc cwd selection / cross-repo** — the ad-hoc session runs in the chosen connection's startup cwd.

## Impact

- **Server**: new REST routes under `/api/daemon-sessions` (send, ad-hoc create-and-send, owner-scoped list); a `sendInstruction` service function; a connection-targeted live-delivery ping for `human_instruction`.
- **Daemon (small)**: the control-handler gains one branch — on the new delivery ping, run the existing connection-scoped pending-turns sweep. No change to spawning or turn lifecycle.
- **Frontend**: a send box + ad-hoc connection picker in the Agent Connections detail pane; new `agentConnections` i18n keys (`en`/`zh`); `docs/design.pen` update.
- **No migration**: every model field this feature needs already exists from 子1.
