# Technical Design: OpenClaw daemon bidirectional parity

## Overview

The Chorus daemon protocol has two halves: a **server half** (connection registry, execution-state, control channel, pending-turns, transcript-read — all already built and shipped for the CLI host) and a **host half** that opens the SSE stream, reports what it runs, and obeys reverse-control commands. The chorus CLI (`cli/daemon.mjs`) implements the host half against a spawned `claude` subprocess. This change implements the host half a **second time** for the OpenClaw plugin, whose host is an **in-process `runEmbeddedAgent`** call, not a subprocess — and factors the host-agnostic REST reporting into a shared client so the two hosts cannot drift.

Nothing here touches the server. Every `/api/daemon/*` endpoint and the `control:{connectionUuid}` channel already exist; this change makes a second client speak the same protocol.

## The host re-mapping (CLI subprocess → OpenClaw in-process)

This is the crux. Each CLI-host mechanism maps to an OpenClaw-host mechanism; the **wire protocol to the server is identical**.

| Concern | CLI host (`cli/daemon.mjs`) | OpenClaw host (this change) |
|---|---|---|
| Run an agent | spawn `claude -p --output-format stream-json` subprocess | `runtime.agent.runEmbeddedAgent(params)` in-process |
| Resume same session | `claude --resume <directIdeaUuid>` (disk transcript probe) | derive `sessionKey` from business key → `getSessionEntry` resolves the existing `sessionId`/`sessionFile` |
| Observe messages | parse subprocess `stream-json` line by line | inline callbacks `onAssistantMessageStart` / `onBlockReply` / `onToolResult` / `onReasoningStream` |
| Mid-run interrupt | `SIGINT`→`SIGKILL` to the process group | `AbortController.abort()` whose `signal` was passed into `runEmbeddedAgent` |
| Detect crash vs exit | subprocess non-zero exit code | `runEmbeddedAgent` promise rejects (or `result.meta.aborted` distinguishes user-abort) |
| Concurrency | daemon `wake-queue.mjs` | OpenClaw built-in command-queue lanes (serial-per-session via sessionKey, parallel-across-session) where free; full policy is sibling idea `6fab91cd` |

The server-facing payloads (`turn-advance`, `transcript`, `execution-state`, `report-interrupt`, `pending-turns`) are **byte-for-byte the same** regardless of host — which is exactly why they belong in a shared client.

## Architecture

```
        Chorus server (UNCHANGED)
   SSE /api/events/notifications ──connection_registered, new_notification, control──┐
   REST /api/daemon/{turn-advance,transcript,execution-state,report-interrupt,pending-turns}
                                                                                     │
        OpenClaw plugin (packages/openclaw-plugin/src/)                              │
   ┌─────────────────────────────────────────────────────────────────────┐         │
   │ sse-listener  ── onConnectionId ─▶ connection-state (connectionUuid)  │◀────────┘
   │               ── onControl ──────▶ control-handler                    │
   │               ── onEvent ────────▶ event-router (wake path only)      │
   │                                                                       │
   │ control-handler ─ interrupt ─▶ abort registry .abort(entityKey)       │
   │                  ─ resume ────▶ re-dispatch wake (synthetic resume)   │
   │                  ─ deliver_turn ▶ pending-turns sweep (this conn)     │
   │                                                                       │
   │ openclaw-daemon-client                                                │
   │   runEmbeddedAgent({ abortSignal, onBlockReply, ... })                │
   │     ├─ on spawn  ─▶ daemon-rest-client.turnAdvance(running)           │
   │     ├─ on message ▶ daemon-rest-client.transcript({role,text})       │
   │     ├─ on done   ─▶ turnAdvance(ended) + execution-state snapshot     │
   │     └─ on abort/reject ▶ report-interrupt(user|crash)                 │
   └───────────────────────────────┬───────────────────────────────────────┘
                                    │ imports
                       daemon-rest-client  ◀── ALSO imported by cli/daemon.mjs
```

## Module contracts

### `daemon-rest-client` (shared)
- **Factory:** `createDaemonRestClient({ url, apiKey, getConnectionUuid, fetchImpl, logger })` → `{ turnAdvance, transcript, executionState, reportInterrupt, readPendingTurns }`.
- **Auth:** `Authorization: Bearer <apiKey>` on every call (no other auth).
- **Payload shapes (the single source of truth):**
  - `turnAdvance({ connectionUuid, sessionId, status: "running"|"ended", entityType?, entityUuid? })` → `POST /api/daemon/turn-advance`
  - `transcript({ sessionId, messages: [{ role: "user"|"assistant", text }] })` → `POST /api/daemon/transcript`
  - `executionState({ connectionUuid, executions: [{ taskUuid, rootIdeaUuid|null, status, startedAt|null }] })` → `POST /api/daemon/execution-state`
  - `reportInterrupt({ connectionUuid, entityType, entityUuid, reason: "user"|"crash" })` → `POST /api/daemon/report-interrupt`
  - `readPendingTurns(connectionUuid)` → `GET /api/daemon/pending-turns?connectionUuid=…` → `{ turns: [{ turnUuid, sessionId, directIdeaUuid, trigger, promptText }] }`
- **Constraint:** zero host coupling — no `child_process`, no `claude`, no stream-json, no OpenClaw imports. Pure REST + injected `fetchImpl`. Errors are surfaced (logged + thrown/returned), never silently swallowed.
- **Extraction discipline:** the CLI daemon's existing reporter modules (`turn-reporter.mjs`, `upload-hooks.mjs`, `interrupt-reporter.mjs`, the pending-turns read in `backfill.mjs`) become thin wrappers over this client. The CLI daemon's existing test suite is the behavior-preservation oracle — it must stay green.

### `connection-state` (OpenClaw)
- Holds the live `connectionUuid` captured from `connection_registered`; exposes `getConnectionUuid()` to the rest client and control handler. Cleared/refreshed on reconnect.

### `control-handler` (OpenClaw)
- Receives forked `type:"control"` events. **Double-check before acting** (mirrors `daemon-interrupt-resume`): act only when `event.targetConnectionUuid === getConnectionUuid()` AND (for `interrupt`) the abort registry holds a live run for `{entityType, entityUuid}`. Otherwise log + ignore.
- `interrupt` → `abortRegistry.get(key).abort()`.
- `resume` → synthesize a resume wake for the entity → re-dispatch through the wake path (continues the same session).
- `deliver_turn` → `readPendingTurns(connectionUuid)`, filter to `event.turnUuid` (full sweep if absent), run the unstarted turn.
- **Never enqueues a wake for the control event itself** — control is not a wake.

### `openclaw-daemon-client` (OpenClaw)
- Wraps `runEmbeddedAgent` for a wake. Creates an `AbortController`, registers it under `entityType:entityUuid`, passes `abortSignal` + transcript callbacks into the run.
- Lifecycle reporting via `daemon-rest-client`: `turnAdvance(running)` on spawn, `transcript(...)` per message, `turnAdvance(ended)` + execution snapshot on completion, `reportInterrupt(user|crash)` on abort/reject. De-registers the controller in a `finally`.
- **Session mapping:** `sessionKey = deriveSessionKey(directIdeaUuid ?? entityUuid)`, resolved via `runtime.agent.session.getSessionEntry({ sessionKey, agentId })` so a resume/deliver_turn continues the same `sessionId`/`sessionFile`.

## Idempotency & safety

- **At-most-once turn execution:** live `deliver_turn` and reconnect backfill share a `seen` set keyed by `turn:<uuid>`, exactly as the CLI host does — a turn observed by either path is a no-op for the other.
- **Interrupt double-check** prevents a stale/recycled `connectionUuid` from aborting the wrong run.
- **No silent errors:** every rest-client call and the control handler log failures visibly (project policy). A failed report never crashes the run; a failed run still reports its terminal state.
- **Offline send safety:** the server already refuses `deliver_turn` to an offline origin and recovers via pending-turns; the OpenClaw client inherits this for free by reading pending-turns on reconnect.

## Risks & Mitigations

- **R1 — CLI daemon regression during extraction.** Pulling reporters into the shared client could subtly change behavior. *Mitigation:* extraction is mechanical and behavior-preserving; the CLI daemon's existing tests gate it; do the extraction first, prove green, then add the OpenClaw consumer.
- **R2 — SDK type surface drift.** Hand-declaring the real SDK surface in `openclaw-sdk.d.ts` can drift from upstream `../openclaw`. *Mitigation:* a task first checks whether `openclaw`'s published `dist/plugin-sdk` types are cleanly importable (preferred — always in sync); only hand-declare the **minimal** used surface if import is not viable, and type it against the verified real shapes. Verify SDK specifics against the real source, not LLM memory.
- **R3 — In-process abort semantics.** `abortSignal` aborts cooperatively; a run mid-tool-call may take a moment to unwind. *Mitigation:* report `reason=user` and rely on `result.meta.aborted`; the execution row's `interrupted` status is sticky server-side, so the UI reflects the stop even before the run fully unwinds.
- **R4 — Streaming callback fidelity.** Inline callbacks may surface partial/reasoning text we don't want in the transcript. *Mitigation:* post only finalized user/assistant text (the same filter the CLI host applies to stream-json — no thinking/tool internals), mapped to `{ role, text }`.
- **R5 — Session-key collision.** A wrong derivation could resume into the wrong conversation. *Mitigation:* derive strictly from the business key (`directIdeaUuid` else `entityUuid`), matching the server's session identity; covered by an explicit resume/continuity test.

## Implementation order

1. Extract `daemon-rest-client`; refactor CLI daemon onto it; prove CLI tests green. (foundation)
2. Type the real SDK surface in the plugin (`openclaw-plugin-sdk`). (unblocks typed calls)
3. Capture `connection_registered` + control subscription/routing (`openclaw-event-bridge`).
4. Build `openclaw-daemon-client`: run + lifecycle/transcript reporting + abort registry + session mapping + pending-turns backfill.
5. Integration checkpoint: end-to-end wake → report → observe in UI → interrupt → resume → deliver_turn against a live local server.
6. Skill-doc / design sync.
