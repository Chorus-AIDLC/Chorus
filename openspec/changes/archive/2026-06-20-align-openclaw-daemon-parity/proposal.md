# Proposal: Bring the OpenClaw plugin to bidirectional daemon parity with `cli/daemon.mjs`

## Why

The Chorus daemon protocol is **bidirectional**: a daemon host opens the notification SSE stream, the server registers a `DaemonConnection`, and from then on the server can observe what the daemon is running (execution-state), read its conversation (transcript), and steer it over a reverse control channel (interrupt / resume / deliver_turn). The 0.11.0 daemon line built the **entire server side** of this — `DaemonConnection`, `DaemonTaskExecution`, the `/api/daemon/*` REST ingest endpoints, the `control:{connectionUuid}` channel, pending-turns, transcript-read — and a fully bidirectional **chorus CLI** host (`cli/daemon.mjs`, `clientType=claude_code`).

**The OpenClaw plugin — the second daemon host — never caught up.** It is single-direction only: it receives `new_notification` and wakes an in-process agent (`runEmbeddedAgent`), and that is all. Concretely (verified against the code, 2026-06-20):

1. **It throws away its own identity.** The server sends `data: {type:"connection_registered", connectionUuid}` immediately after handshake (`api/events/notifications/route.ts`), but `ChorusSseListener` has no `onConnectionId` callback (`sse-listener.ts`), so the event falls through `event-router.dispatch` as `type !== "new_notification"` and is "ignored". With no `connectionUuid`, every downstream report and every control command is unaddressable.

2. **It does not subscribe the reverse control channel.** The server opens `control:{connectionUuid}` per connection and pushes `interrupt` / `resume` / `deliver_turn`. The OpenClaw listener has no `onControl` fork, so: UI "Stop / Resume" on an OpenClaw connection does nothing, and UI→agent instruction injection (`deliver_turn`) never arrives.

3. **It reports nothing.** `wake.ts` is fire-and-forget `runEmbeddedAgent` that only logs locally. It never POSTs `turn-advance`, `transcript`, `execution-state`, or `report-interrupt`. So in the UI an OpenClaw connection is a **black box**: visibly online, but you cannot see what it runs, read its conversation, or stop it.

4. **It has no pending-turns safety net.** Its reconnect path only re-pulls unread notifications via MCP; it never reads the turn table, so a UI-issued instruction can neither be delivered live nor recovered on reconnect.

**The blocker we feared was illusory.** Early analysis (idea round 1) concluded mid-run interrupt and live transcript "need an SDK fork." That was wrong: it was read off the plugin's hand-written `openclaw-sdk.d.ts`, which declares `runtime?: unknown` and `runEmbeddedAgent: (params) => Promise<unknown>` — a shim that **hides the real SDK**. The real `../openclaw` source shows `runEmbeddedAgent(params: RunEmbeddedAgentParams): Promise<EmbeddedAgentRunResult>` already takes `abortSignal?: AbortSignal` (relayed through the whole run) and a full set of per-message streaming callbacks (`onAssistantMessageStart` / `onBlockReply` / `onToolResult` / `onReasoningStream`), and `src/cron/isolated-agent/` already runs embedded agents this exact "wake → run → deliver" way with abort + stable-key session resume + a serial-per-session / parallel-across-session lane queue. **Full bidirectional parity is achievable within the existing SDK — no fork.**

## What Changes

Bring the OpenClaw plugin (`packages/openclaw-plugin/`) to the same bidirectional daemon protocol the CLI host implements, re-mapped to the OpenClaw **in-process `runEmbeddedAgent`** host (not a `claude --resume` subprocess). The **server side is unchanged** — every endpoint and channel this consumes already exists.

- **Shared pure-REST daemon client (`daemon-rest-client`).** Extract the CLI daemon's reporter logic — `turn-advance`, `transcript`, `execution-state`, `report-interrupt`, and the `pending-turns` read — into one module that is the **single source of truth** for `/api/daemon/*` payload shapes, consumed by **both** `cli/daemon.mjs` and the OpenClaw plugin. These reporters were verified to be pure REST with zero host coupling (they need only `{ url, apiKey, getConnectionUuid, fetchImpl }`). The extraction is **behavior-preserving**: the CLI daemon keeps working and its existing tests stay green. Hand-porting a second copy into TS is explicitly rejected — drift in the payload contract is exactly the failure this idea exists to prevent.

- **Capture `connection_registered` and subscribe the control channel (`openclaw-event-bridge`).** Add `onConnectionId` (store `connectionState.connectionUuid`) and `onControl` (fork `type:"control"` events to a control handler, **never** into the wake path) to the SSE listener. The control handler honors the same double-check the CLI daemon uses (`targetConnectionUuid === my uuid` AND I hold the entity) before acting on `interrupt`; routes `deliver_turn` to a connection-scoped pending-turns sweep; routes `resume` to a re-dispatch.

- **In-process bidirectional daemon client (`openclaw-daemon-client`).** Re-implement the CLI host's run+report behaviors for the OpenClaw host:
  - **Observability回传:** report turn lifecycle (`turn-advance`: pending→running on spawn, →ended on completion), an execution-state snapshot, and a **streaming transcript** fed by inline `runEmbeddedAgent` callbacks (`onAssistantMessageStart` / `onBlockReply` / `onToolResult`), posting the same `{ role, text }` shape the CLI host posts.
  - **Real mid-run interrupt:** keep an `AbortController` per in-flight execution keyed by `entityType:entityUuid`; a control `interrupt` aborts the matching run (true mid-run stop via `abortSignal`), then `report-interrupt` fires `reason=user`; a `crash` (run rejects) reports `reason=crash`.
  - **Session resume mapping:** derive the OpenClaw `sessionKey` deterministically from the DaemonSession business key (`sessionId = directIdeaUuid`, else `entityUuid`) so `resume` / `deliver_turn` re-enter the **same** OpenClaw session via the existing `getSessionEntry` resolution — the in-process analog of `claude --resume <directIdeaUuid>`.
  - **Pending-turns backfill:** on reconnect, and on a `deliver_turn` ping, read connection-scoped pending turns from the turn table and run the unstarted `human_instruction` turn; live delivery and backfill are idempotent so a turn runs at most once.

- **Declare the real SDK surface the plugin uses (`openclaw-plugin-sdk`).** Replace the opaque `runtime?: unknown` shim with a typed declaration of exactly the surface this work consumes — `runtime.agent.runEmbeddedAgent(params)` with `abortSignal` and the streaming callbacks, `runtime.agent.session.getSessionEntry` / `resolveSessionFilePath`, and the control/connection plumbing — typed against the real `../openclaw` shapes, so these calls are compile-time checked rather than `unknown`-cast. A task first verifies whether the published `openclaw` `dist/plugin-sdk` type defs are cleanly importable; if so, import them instead of hand-declaring.

- **Skill docs + design.** Sync the four plugin skill surfaces per `plugin-maintenance` where the OpenClaw daemon behavior is documented, and update `docs/design.pen` only if a user-facing surface changes (this work is largely client-side plumbing; the Agent Connections UI already renders execution-state/transcript/controls produced by the server).

## Capabilities

### New Capabilities

- `daemon-rest-client`: a shared, host-agnostic pure-REST client for the `/api/daemon/*` reporting surface (`turn-advance`, `transcript`, `execution-state`, `report-interrupt`, `pending-turns` read), consumed by both the chorus CLI daemon and the OpenClaw plugin as the single source of truth for those payload shapes.
- `openclaw-daemon-client`: the OpenClaw in-process host's bidirectional daemon behavior — running a wake via `runEmbeddedAgent` with streaming-transcript callbacks, reporting turn lifecycle and execution-state, real mid-run interrupt via `AbortController`, deterministic session-resume mapping, and pending-turns backfill.

### Modified Capabilities

- `openclaw-event-bridge`: add `connection_registered` capture (own `connectionUuid`) and reverse `control:{connectionUuid}` channel subscription/routing (interrupt / resume / deliver_turn) that never enters the wake path.
- `openclaw-plugin-sdk`: declare the real `runtime.agent.runEmbeddedAgent` (with `abortSignal` + streaming callbacks) and session-helper surface the plugin uses, replacing the opaque `runtime?: unknown` shim.

## Impact

- **Code:** `packages/openclaw-plugin/src/` (sse-listener, event-router, wake, new control-handler / reporters / connection-state modules, `openclaw-sdk.d.ts`); a new shared `daemon-rest-client` module; `cli/daemon.mjs` + its reporter modules refactored to consume the shared client (behavior-preserving).
- **Server:** none. All `/api/daemon/*` endpoints, the `control:{connectionUuid}` channel, pending-turns, execution-state, and transcript-read already exist and are unchanged.
- **UI:** none required for the protocol; the Agent Connections execution-state / transcript / interrupt-resume surfaces already render whatever any daemon host reports, so an OpenClaw connection becomes observable and controllable with no UI change. (Any OpenClaw-specific affordance, if added, follows the existing localized patterns and updates `docs/design.pen`.)
- **Out of scope:** the daemon dispatch **concurrency model** (parallel/serial policy) is owned by sibling idea `6fab91cd` — this change single-flights correctly and leans on OpenClaw's built-in lanes where free, but does not define the cross-idea concurrency policy. No SDK fork (the real SDK suffices). No server schema or endpoint changes.
