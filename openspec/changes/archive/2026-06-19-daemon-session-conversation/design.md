# Technical Design: DaemonSession persistent-conversation model

## Overview

Promote the daemon's Claude session from a transient on-disk artifact to a first-class persisted **conversation**. A `DaemonSession` is keyed by `(agentUuid, sessionId)` and holds an ordered list of `DaemonSessionTurn` rows; every wake — autonomous (`task_assigned` / `mentioned` / `elaboration` / `resume`) or human (`human_instruction`) — is one turn. Each turn captures `user`/`assistant` transcript text (rolling window). This is the foundation layer (子1); the UI send box (子2) and the viewing/continue UI (子3) build on it.

Two design tensions drive the shape, both resolved in elaboration:

1. **Durable conversation vs. ephemeral execution.** `DaemonExecution` is a snapshot-reconciled "what is running/queued *right now*" projection — rows flip to `ended` when absent from the next snapshot. A conversation must outlive that. So `DaemonSession`/`DaemonSessionTurn` are a **separate, durable** layer; a turn *references* its execution row but does not change execution-state semantics.
2. **Agent-stable identity vs. cwd-bound transcript.** A conversation's identity/history is stable across connection drops and restarts (keyed on `(agentUuid, sessionId)`). But `claude --resume <sessionId>` only works in the same cwd on the same machine (`~/.claude/projects/<cwd-escaped>/<sessionId>.jsonl`). So **continuation** is pinned to a fixed `originConnectionUuid`; an offline origin makes the session read-only rather than transferring it to another connection (which would `No conversation found`).

## Architecture

```
Human types instruction (子2 UI)            Autonomous wake (task/@mention/elaboration/resume)
            │                                              │
            └───────────────┬──────────────────────────────┘
                            ▼
            notification.service.create / createBatch   ← single chokepoint
                            │  (resolve/create DaemonSession via lineage.service;
                            │   create DaemonSessionTurn status=pending;
                            │   for human_instruction, denormalize promptText onto the notification)
                            ▼
        Notification (recipient = daemon agent)  ──SSE new_notification──▶ daemon
                            │                                                  │
                            │                              chorus_get_notifications (already happens)
                            │                              → reads action + (for human) promptText
                            ▼                                                  ▼
                    [persisted, canonical                         WakeQueue (per-direct-idea serial)
                     turn rows + backfill source]                            │
                                                          spawn claude -p (--resume if transcript on disk)
                                                                             │ turn pending→running
                                                          stream-json user/assistant text
                                                                             │
                                              POST /api/daemon/transcript  ◀──┘ (append; rolling window)
                                                                             │ turn running→ended
                                              transcript:{...} SSE ─────────▶ viewer (子3)
```

## Data Model

New Prisma models (`relationMode = "prisma"`, cascade on agent per convention). DDL-only migration, no backfill.

```prisma
model DaemonSession {
  id                  Int      @id @default(autoincrement())
  uuid                String   @unique @default(uuid())
  companyUuid         String
  agentUuid           String
  agent               Agent    @relation(fields: [agentUuid], references: [uuid], onDelete: Cascade)
  // Stable business key: directIdeaUuid for an idea-anchored session, or a
  // server-generated uuid for ad-hoc. Unique per agent.
  sessionId           String
  directIdeaUuid      String?  // null ⇒ ad-hoc (no idea lineage)
  // The connection/cwd that owns the on-disk transcript. Fixed at creation;
  // continuation is only ever routed here (cwd-bound --resume).
  originConnectionUuid String
  status              String   @default("active") // active | ended
  title               String?
  lastTurnAt          DateTime @default(now())
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
  turns               DaemonSessionTurn[]

  @@unique([agentUuid, sessionId])
  @@index([companyUuid, agentUuid])
  @@index([originConnectionUuid])
}

model DaemonSessionTurn {
  id            Int      @id @default(autoincrement())
  uuid          String   @unique @default(uuid())
  sessionUuid   String
  session       DaemonSession @relation(fields: [sessionUuid], references: [uuid], onDelete: Cascade)
  seq           Int      // monotonic per session
  trigger       String   // task_assigned | mentioned | elaboration | resume | human_instruction
  promptText    String?  // free-text body for human_instruction; null otherwise
  status        String   @default("pending") // pending | running | ended
  // Weak ref to the live execution row this turn corresponds to (no DB FK;
  // DaemonExecution rows are reconciled/transient).
  executionUuid String?
  startedAt     DateTime?
  endedAt       DateTime?
  createdAt     DateTime @default(now())
  messages      DaemonTranscriptMessage[]

  @@unique([sessionUuid, seq])
  @@index([sessionUuid, status])
}

model DaemonTranscriptMessage {
  id          Int      @id @default(autoincrement())
  uuid        String   @unique @default(uuid())
  turnUuid    String
  turn        DaemonSessionTurn @relation(fields: [turnUuid], references: [uuid], onDelete: Cascade)
  role        String   // user | assistant  (tool/thinking NOT stored)
  text        String   @db.Text
  seq         Int      // order within turn; used for rolling-window trim
  createdAt   DateTime @default(now())

  @@index([turnUuid, seq])
}
```

Additive nullable column on the existing `Notification` model (write-once denormalized copy, agent-recipient only):

```prisma
// On model Notification:
  instructionText String?  // denormalized copy of a human_instruction turn's promptText;
                           // canonical source is DaemonSessionTurn.promptText. Display/transport only.
```

**Why `DaemonTranscriptMessage` is its own table (not JSON on the turn):** append semantics + per-message rolling-window trim are cleaner as rows; avoids read-modify-write of a JSON blob under concurrent appends.

## API Design

- **`POST /api/daemon/transcript`** (new, agent-key, append). Body: `{ sessionId | turnUuid, messages: [{ role: "user"|"assistant", text }] }`. Validates the turn belongs to the authenticated agent's session within its company (404 non-disclosure otherwise — mirrors `daemon-execution.service.connectionBelongsToAgent`). Stores only `user`/`assistant` text; trims to the rolling-window max per session in application code. Publishes a `transcript:{sessionUuid}` event. Standard API envelope. No new permission bit.
- **Reads** (used by 子3, but the owner-scoped read functions live here): `getVisibleSessions` / `getSessionTurns`, owner-scoped exactly like `daemon-execution.service.getVisibleExecutions` (`agent.ownerUuid` for users, own agent for agent keys, always `companyUuid`-scoped).
- **No change** to `POST /api/daemon/execution-state` (snapshot-reconcile) or `POST /api/daemon/control` (interrupt/resume).

### SSE contract — three triggers, one channel

All live updates for a conversation ride a single per-session channel `transcript:{sessionUuid}` on the existing event bus (with the existing Redis fan-out). It is published on **three** triggers, so a 子3 viewer re-renders without polling or manual reload:

1. **turn created** — a new `DaemonSessionTurn` row appears (server-side, at the notification chokepoint).
2. **turn status changed** — `pending → running → ended` transitions (driven by the daemon's lifecycle reports landing in the service).
3. **transcript appended** — new `user`/`assistant` messages added to a turn (the ingest endpoint).

Because turn-create and turn-status-change both flow through the service layer's `createPendingTurn` / `advanceTurn` (the single chokepoint for those mutations), the publish for triggers (1) and (2) lives in `daemon-session.service` and fires for any caller of those functions; trigger (3)'s publish lives in the transcript ingest endpoint. The event payload identifies the session and the affected turn so the client can patch the right row. This is additive to the existing notification / presence / execution event types and does not alter them.

## Module Contracts

- **Session/turn mutations (server)** live in `daemon-session.service` (`resolveOrCreateSession`, `createPendingTurn`, `advanceTurn`). Contract: these are the **single chokepoint** for turn creation and status transitions, so they own publishing the `transcript:{sessionUuid}` SSE event for the "turn created" and "turn status changed" triggers (see SSE contract above) — any caller of these functions emits, no caller needs to remember to. `advanceTurn` publishes on each `pending→running→ended` transition.
- **Turn creation call site (server)** is `notification.service` `create`/`createBatch` (the single chokepoint where every wake notification is born). Contract: resolve-or-create the `DaemonSession` (via `lineage.service` for `directIdeaUuid`; `originConnectionUuid` = the target connection resolved for this wake), then call `createPendingTurn`. For `human_instruction`, also set `Notification.instructionText` = the turn's `promptText`. Turn-creation failure is logged visibly and never aborts the already-created notification (no silent swallow).
- **Turn lifecycle (daemon)**: the daemon transitions `pending → running` when it spawns, `running → ended` when the subprocess exits, reported via the existing MCP write path. `cli/waker.mjs` already tracks per-entity execution entries with the child handle and an `onChild` hook; the turn lifecycle hooks alongside this (`wake()` start → running, exit handler → ended), reusing the `executions` map keying.
- **Transcript upload (daemon)**: implement the currently-no-op `onTranscriptMessage` / `onSessionStart` in `cli/upload-hooks.mjs` (the signatures already carry `{ rootIdeaKey, sessionId, message }`). Parse stream-json NDJSON, keep only `user`/`assistant` text blocks, batch-POST to `/api/daemon/transcript`. Mirror the `createExecutionUploadHooks` style (injectable `fetchImpl`, Bearer creds, warn-not-throw).
- **Instruction read (daemon)**: no new fetch — `cli/event-router.mjs` already calls `chorus_get_notifications` and reads `n.action`; extend it to read `n.instructionText` for the `human_instruction` action and pass it through `markQueued`/`wake` as the prompt body. `cli/prompts.mjs` `buildPrompt` gains a `human_instruction` branch emitting that free text.
- **Continuation pinning (server)**: dispatching a turn resolves the session's `originConnectionUuid`; if that connection is not `online` (registry `effectiveStatus` via `STALE_THRESHOLD_MS`), refuse with a clear "session read-only / origin offline" error and do not route elsewhere. (子2 surfaces this as a disabled send box.)

## Implementation Plan

1. **Schema + migration** — add `DaemonSession`, `DaemonSessionTurn`, `DaemonTranscriptMessage`, and `Notification.instructionText`; Prisma-CLI migration (DDL only); `prisma generate`.
2. **Server: session/turn service** — resolve-or-create session, create/advance turns, owner-scoped reads, continuation-pinning check. Reuse `lineage.service` (directIdeaUuid) and the execution-service visibility pattern.
3. **Server: turn creation at the notification chokepoint** — hook `notification.service` create/createBatch; denormalize `instructionText` for `human_instruction`; visible-failure logging.
4. **Server: transcript ingest + SSE** — `POST /api/daemon/transcript` (append, text-only, rolling-window trim) + `transcript:{sessionUuid}` event on the existing bus/Redis fan-out.
5. **Daemon: turn lifecycle + instruction read** — advance pending→running→ended in `waker.mjs`; read `instructionText` in `event-router.mjs`; `human_instruction` prompt in `prompts.mjs`.
6. **Daemon: transcript upload hooks** — implement `onTranscriptMessage`/`onSessionStart` in `upload-hooks.mjs`; wire into the spawner's stream-json consumer.
7. **Integration checkpoint** — end-to-end: an autonomous task wake and a (test-injected) human_instruction wake both produce turns on one `DaemonSession`, transcript text lands via ingest, SSE pushes it, and continuation refuses when origin is offline.

## Risks & Mitigations

- **Daemon hot-path change (every wake records a turn).** Mitigation: turn create is server-side at the notification chokepoint (daemon only advances status it already tracks); upload hooks are fire-and-forget warn-not-throw, never blocking the wake.
- **`DaemonSession` vs `DaemonExecution` drift / duplication.** Mitigation: strict separation of concerns — execution = live snapshot (unchanged), session = durable history; turn holds a weak `executionUuid` link only. No reconcile logic touches sessions.
- **Lost delivery ping.** Mitigation: the turn is persisted before/at notification creation; reconnect-backfill re-derives **unstarted** turns from the turn table (not from notifications), so a dropped SSE ping never loses an instruction. (Backfill query: pending turns on sessions whose origin is this reconnecting connection.)
- **Privacy of stored text.** Mitigation: only `user`/`assistant` text (no tool args / paths-heavy output); rolling window bounds retention; owner-scoped reads; text is daemon-self-reported and display-only.
- **`claude --resume` cwd binding.** Mitigation: continuation pinned to `originConnectionUuid`; offline origin ⇒ read-only, never re-routed. Verify the new-vs-resume disk probe (`isNewSession`) still keys on the origin cwd.
- **External-tool specifics (Claude Code stream-json shapes, `--session-id`/`--resume` flags).** Mitigation: developers MUST verify message-type names and CLI flags against the installed `claude` version rather than LLM memory; the daemon already strips `\r` and parses NDJSON line-by-line.

## Out of Scope (deferred to 子2 / 子3 or later)

- UI send box for instructions (子2) and the transcript-viewing / continue-conversation UI (子3).
- Full stream-json relay (tool calls, tool results, thinking) — text-only for now.
- Full (non-windowed) transcript history / replay.
- Multi-agent-driver (codex / opencode) transcript normalization.
