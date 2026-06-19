# Technical Design: UI → daemon instruction injection (子2)

## Overview

Sending an instruction = creating a `human_instruction` **turn** on a `DaemonSession` and getting the session's **origin** daemon to run it as the next turn. The DaemonSession model (子1, PR #332) already provides the data model, the turn-creation chokepoint, the ad-hoc session path, the origin-online gate, owner-scoped reads, reconnect backfill, and the **entire daemon-side execution of a `human_instruction`**. This change adds the UI-facing send surface and closes the one live-delivery gap 子1 left open.

This design references existing code by `file:line` and is deliberate about what it **reuses** vs. **adds**, because the largest risk here is re-specifying something 子1 already shipped.

## What 子1 already provides (reuse, do not rebuild)

| Concern | Existing artifact | Location |
|---|---|---|
| Conversation + turn model | `DaemonSession`, `DaemonSessionTurn` (incl. `originConnectionUuid`, `promptText`, `seq`, `status`) | `prisma/schema.prisma:494‑560` |
| Turn creation (symmetric chokepoint) | `maybeCreateTurnForWakeNotification()` | `notification-turn.ts:145` |
| action→trigger map incl. `human_instruction` | `NOTIFICATION_ACTION_TO_TURN_TRIGGER` | `notification-turn.ts:70` |
| Free-text carrier on the notification | `instructionText` (write-once denormalized; turn `promptText` canonical) | `schema.prisma:579`, `notification.service.ts:151` |
| Ad-hoc session create | `resolveOrCreateSession({ directIdeaUuid: null, sessionId, originConnectionUuid })` | `daemon-session.service.ts` |
| Origin-online gate | `assertContinuable()` → `SessionReadOnlyError` | `daemon-session.service.ts` |
| Owner-scoped reads | `getVisibleSessions()`, `getSessionTurns()` | `daemon-session.service.ts` |
| Online-connection list (origin-first) | `listConnectionsForAgent()` (`effectiveStatus`) | `daemon-connection.service.ts` |
| Daemon: recognize + run `human_instruction` | `buildPrompt()` case, `sessionId = directIdeaUuid ?? entityUuid`, lifecycle `pending→running→ended` | `cli/prompts.mjs`, `cli/waker.mjs`, `cli/event-router.mjs` |
| Daemon: serial per-session queue | per-direct-idea WakeQueue | `cli/waker.mjs`, `cli/event-router.mjs:218` |
| Daemon: connection-scoped backfill | `GET /api/daemon/pending-turns` + `dispatchPendingTurn()` | `pending-turns/route.ts`, `cli/event-router.mjs:148` |
| Per-connection control channel | `control:{connectionUuid}`, `POST /api/daemon/control`, `createControlHandler()` | `daemon/control/route.ts`, `cli/control-handler.mjs` |

## Architecture

```
[User UI]                          [Server]                                   [Origin Daemon (connection C)]
  send box ── POST /api/daemon-sessions/{uuid}/instruction ─┐
                                   sendInstruction(auth, sessionUuid, text)
                                     ├─ owner-scoped session lookup (404 non-disclosure)
                                     ├─ assertContinuable()  ── offline ⇒ 409 read-only
                                     ├─ notification.service.create({ action:"human_instruction",
                                     │     recipientType:"agent", recipientUuid:agent,
                                     │     entityType, entityUuid:sessionId, instructionText })
                                     │     └─(chokepoint)─ maybeCreateTurnForWakeNotification()
                                     │                       └─ createPendingTurn(human_instruction, promptText)
                                     └─ dispatchControl({ command:"deliver_turn",            ─── control:{C} ──▶ onControl()
                                          targetConnectionUuid: session.originConnectionUuid })                  ├─ Check 1: targetConn === my conn
                                                                                                                 └─ GET /api/daemon/pending-turns?connectionUuid=C
                                                                                                                      └─ dispatchPendingTurn() ─▶ WakeQueue ─▶ claude --resume
```

The live path and the reconnect-backfill path now **converge** on the same connection-scoped pending-turns sweep, so both are origin-only and identical in effect.

### Send to an existing session — `POST /api/daemon-sessions/{sessionUuid}/instruction`

1. Resolve the session owner-scoped (reuse `getSessionTurns`/a session lookup that returns null when not visible) → **404 non-disclosure** if not visible, matching `pending-turns/route.ts:42`.
2. `assertContinuable(companyUuid, sessionUuid)` — if the origin connection is offline, return **409** with a read-only error code (`SessionReadOnlyError`). The session stays visible; only sending is blocked.
3. Validate `instructionText`: non-empty after trim, length ≤ `MAX_INSTRUCTION_CHARS` (a single named constant, e.g. 4000) → **400** otherwise.
4. Call `notification.service.create()` with `action: "human_instruction"`, `recipientType: "agent"`, `recipientUuid = session.agentUuid`, `entityType`/`entityUuid` set so the chokepoint resolves **the same session** (see "Session-key alignment"), and `instructionText`. The chokepoint creates the pending turn (canonical `promptText`).
5. Emit the **origin-targeted live delivery** (see keystone) instead of relying on the agent-wide notification fan-out.
6. Return the created turn view (`uuid`, `seq`, `status: "pending"`, `createdAt`) for optimistic UI.

### Ad-hoc create-and-send — `POST /api/daemon-sessions/ad-hoc`

Body: `{ agentUuid, connectionUuid, instructionText }`.

1. Verify the caller owns `agentUuid` (owner-scoped, company-fenced) and that `connectionUuid` belongs to that agent and is **online** (reuse `connectionBelongsToAgent` + `effectiveStatus`) → 404 non-disclosure / 409 if offline.
2. Server **generates** `sessionId` (a fresh uuid) — the single source of truth, so the UI can show/resume it immediately (子2 Round-1 Q3).
3. `resolveOrCreateSession({ directIdeaUuid: null, sessionId, originConnectionUuid: connectionUuid })` — creates the ad-hoc DaemonSession pinned to the chosen connection (its cwd = that connection's startup dir, 总纲 Q6=a).
4. Create the `human_instruction` notification + turn exactly as the existing-session path (steps 3‑6 above), with `entityUuid = sessionId`.

### Owner-scoped targeting reads — `GET /api/daemon-sessions`

Thin route over `getVisibleSessions(auth)` (already owner-scoped + company-fenced). Each row carries `originConnectionUuid`, `directIdeaUuid`, `sessionId`, `status`, `lastTurnAt`, and a derived **`originOnline`** boolean (compute via the same online check `assertContinuable` uses) so the send box can render enabled/disabled without a second call. The ad-hoc picker reuses the existing `GET /api/agent-connections` for the agent's online connections. **No turn/transcript bodies here** — that is 子3.

## Keystone: origin-only live delivery (the gap 子1 left)

**Problem.** 子1's spec requires "a turn is dispatched only to the origin connection," and that holds for the backfill path (`getPendingTurnsForConnection` is connection-scoped) and for the send-gate (`assertContinuable`). But the **live** wake still rides the agent-wide notification SSE: `notification.service.create()` emits on `notification:agent:{uuid}` (`notification.service.ts:182`), the daemon notification stream is per-agent (`events/notifications/route.ts:68`), and `Notification` has no `targetConnectionUuid`. With two online daemons for one agent, both wake; the **non-origin** daemon has no on-disk transcript for `sessionId`, so its probe yields `isNew=true` and it spawns a **divergent** Claude session against the same server-side `sessionId` — corrupting the conversation.

**Why not the obvious fixes.**
- *Add `targetConnectionUuid` to `Notification`* — the parent reframe explicitly rejected widening the core model; that rejection is the whole reason 子1 chose the "turn = carrier, wake = ping" shape.
- *Filter in `event-router` by an instruction's connection* — the live notification carries no connection, and the router has no per-connection notion for the agent-wide stream.

**Chosen mechanism (reuses 子3's channel + 子1's sweep).** Deliver the live `human_instruction` ping on the **per-connection** `control:{originConnectionUuid}` channel — the same channel interrupt/resume already use, which is keyed per connection precisely so a command reaches *only one* daemon (`event-bus.ts:62` comment). Add a third control command `deliver_turn`:

- **Server**: extend `CONTROL_COMMANDS` with `deliver_turn`; after creating the notification+turn, `sendInstruction` calls `dispatchControl({ command: "deliver_turn", targetConnectionUuid: session.originConnectionUuid })`. The `deliver_turn` wire payload carries **only** `targetConnectionUuid` — **no `entityType`/`entityUuid`** — because the daemon's pending-turns sweep is connection-scoped (it finds the turn by connection, not by entity), and an ad-hoc session's `sessionId` is intentionally a *non-lineage* key that would not fit the fixed `CONTROL_ENTITY_TYPES` union that `interrupt`/`resume` use. Treat `deliver_turn` as a control command whose targeting is connection-only: its dispatch path and the route's zod body validation must accept the command without requiring `entityType`/`entityUuid` (the simplest shape is a small command-specific variant rather than forcing the interrupt/resume entity fields). Authorization on `POST /api/daemon/control` is unchanged (owner-or-`task:admin`, 404 non-disclosure); `sendInstruction` already proved ownership, so it dispatches directly via the service rather than re-HTTP.
- **Daemon**: `createControlHandler` gains a `deliver_turn` branch. After **Check 1** (`targetConnectionUuid === my connectionUuid` — the existing anti-mis-route guard at `control-handler.mjs`), it triggers the **existing** connection-scoped pending-turns backfill sweep (the same code reconnect runs) rather than spawning anything itself — and needs no entity from the wire, since the sweep is keyed purely on the connection. That sweep reads `GET /api/daemon/pending-turns?connectionUuid=C`, finds the new `pending` `human_instruction` turn, and calls the already-built `dispatchPendingTurn()` → WakeQueue → `claude --resume`. No running-child requirement (mirrors the existing `resume` branch, `control-handler.mjs`).

**Durability is automatic.** The turn is persisted before the ping. If the control ping is lost (it is fire-and-forget, like interrupt/resume) or the daemon was briefly offline, the **reconnect backfill** re-derives the same `pending` turn from the turn table — the canonical source — so an instruction is never silently lost (子2 Round-2 Q6). The notification row still exists as the owner-scoped record + the daemon's text source if it ever reads via notifications. The shared `seen` set (`event-router.mjs:34`, keyed `turn:{uuid}`) makes live-ping + backfill idempotent: whichever arrives first wins, the other is a no-op.

## Session-key alignment (must match the daemon's anchor exactly)

The daemon anchors a session on `sessionId = directIdeaUuid ?? notification.entityUuid` (`waker.mjs`, and `dispatchPendingTurn` sets `entityUuid = sessionId`, `entityType = directIdeaUuid ? "idea" : "task"` — `event-router.mjs:184`). The server chokepoint derives `sessionId = directIdeaUuid ?? entityUuid` only when `entityType ∈ {task,document,proposal,idea}`, else treats it as ad-hoc keyed on `entityUuid` (`notification-turn.ts:95,173`). To guarantee the send creates a turn on **the intended existing session** (not a new one):

- For an **idea-anchored** session, the notification's `entityType`/`entityUuid` must resolve (via lineage) to the same `directIdeaUuid` the session was created with. Safest: pass the session's own `directIdeaUuid` as `entityType:"idea", entityUuid:directIdeaUuid` so lineage is an identity.
- For an **ad-hoc** session, pass `entityType` ∉ lineage set (so no lineage walk) and `entityUuid = sessionId`, matching the daemon's `entity:{type}:{sessionId}` queue key and `--resume <sessionId>`.

This alignment is the one subtle correctness point; the integration checkpoint task verifies a sent instruction lands on the **existing** session row (no second row, `seq` increments).

## Module Contracts

- **Send service** `sendInstruction(auth, { sessionUuid, instructionText })`: returns `{ turn: TurnView }` on success; throws typed errors mapped by the route to `404` (not visible), `409` (`SessionReadOnlyError`), `400` (empty/over-length). Owner-scope + company fence enforced before any mutation.
- **Ad-hoc service** `createAdHocSessionWithInstruction(auth, { agentUuid, connectionUuid, instructionText })`: returns `{ session: SessionView, turn: TurnView }`.
- **Control wire**: `deliver_turn` carries `{ command, targetConnectionUuid }` only — **no instruction text and no entity** on the wire (text is on the persisted turn; the daemon fetches it via the connection-scoped pending-turns read, which needs no entity). This is deliberately narrower than `interrupt`/`resume`, which carry `entityType`/`entityUuid`. Forward-compatible: the daemon ignores unknown commands (`control-handler.mjs`).
- **API envelope**: all routes use `success()` / `errors.*` from `src/lib/api-response.ts` via `withErrorHandler`.

## Risks & Mitigations

- **Divergent session on the wrong daemon** (the keystone) → live delivery is connection-targeted via `control:{origin}` + Check 1; backfill is connection-scoped. Both origin-only.
- **Lost live ping** → turn persisted first; reconnect backfill re-derives from the turn table; `seen` set dedups. No double-run, no loss.
- **Send to a session whose origin just went offline** → `assertContinuable` re-checked at send time → 409 read-only; UI also gates on `originOnline`.
- **Wrong-session turn (key drift)** → explicit session-key alignment rules above + integration-checkpoint verification.
- **Local-path leakage / abuse** → owner-scoped only; length cap; instruction not written to Activity (总纲 Q8=c). Privacy posture inherited from 子1 (daemon self-reported, display-only).
- **Re-specifying 子1** → this design only *calls* 子1's services and adds one control command + UI; the spec deltas below assert behavior, not 子1's internals.

## Implementation Plan

1. Server: `deliver_turn` control command + `sendInstruction` / `createAdHocSessionWithInstruction` services + the three routes (`GET /api/daemon-sessions`, `POST …/{uuid}/instruction`, `POST …/ad-hoc`), with owner-scope, gating, and length cap. Unit + route tests.
2. Daemon: `deliver_turn` branch in `createControlHandler` → connection-scoped pending-turns sweep. Unit tests (Check-1 mismatch = no-op; match = sweep invoked).
3. Frontend: send box + ad-hoc connection picker in the Agent Connections detail pane; `agentConnections` i18n keys (`en`/`zh`); `originOnline` gating; toasts. `docs/design.pen` update.
4. Integration checkpoint: end-to-end — send → turn created on the *existing* session (no dup row, `seq`++) → origin-only delivery → daemon runs it; offline origin → 409; ad-hoc create-and-send resumes on the picked connection.
