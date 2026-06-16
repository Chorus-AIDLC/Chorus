# Proposal: Daemon execution-state reporting + UI

## Why

The Chorus CLI daemon (idea `9b76ccd7`) wakes a local headless `claude -p` subprocess per dispatched task and serializes wakes through an in-process `WakeQueue` (`cli/wake-queue.mjs`): same root idea runs serially, different root ideas run concurrently up to a cap. That queue already tracks exactly what a user would want to see — which keys are `running` and which are `pending` (queued) — but the state lives **only in the daemon process memory and is never reported anywhere**.

The sibling observability slice (idea `f2fe9a7f`, capability `agent-connection-observability`) shipped the Agent Connections page, but it is **read-only connection liveness only**. Its connection detail pane is a literal "coming soon" placeholder — per-connection session/transcript nesting and any notion of "what is this daemon doing right now" were explicitly deferred. So today a user can see *that* their daemon is online, but not *what task it is working on* or *what is waiting behind it*.

Concrete pain:

1. **No execution visibility.** A task is dispatched, the daemon picks it up, Claude works for minutes — and the UI shows only the task's coarse status (`assigned`/`in_progress`). The user cannot see that the daemon is actively running task X on root-idea session Y, started 3 minutes ago, with tasks W and Z queued behind it.
2. **No backlog visibility.** When several tasks are dispatched at once and exceed the concurrency cap, the surplus queues silently inside the daemon. The user has no way to know work is waiting rather than stalled.
3. **Blocks downstream control.** The interrupt/resume capability (sibling idea `4c9b3bca`, "子3") needs a surface to hang an interrupt button on and a task→subprocess mapping to act against. That surface is the per-connection execution view this change builds.

This is the **②execution-state reporting + UI** slice of umbrella idea `6fab91cd`, whose Round-1 elaboration split the umbrella into three independently-shippable sub-ideas. It fills the connection detail placeholder with real running/queued data.

## What Changes

- **New `DaemonTaskExecution` Prisma model** — one row per `(connection, task)` the daemon is running or has queued: `connectionUuid`, `taskUuid`, `rootIdeaUuid` (nullable — a quick task has no root idea), `status` (`running` | `queued` | terminal), `startedAt` (nullable — only set when running), `updatedAt`, plus `companyUuid`/`agentUuid` for scoping. Created via a Prisma-CLI-generated migration (no hand-written SQL, DDL-only). The owner who answered elaboration chose a **persistent** table over in-memory pass-through so execution history is queryable.
- **New REST ingest endpoint `POST /api/daemon/execution-state`** — agent-key callable, not an MCP tool, no new permission bit. Same "REST, agent-key callable" contract as the root-idea-resolution and agent-connections endpoints. The daemon POSTs its current execution snapshot (the WakeQueue's running + queued keys mapped to task/root-idea uuids); the server reconciles the table for that connection and emits an SSE event.
- **Daemon-side upload hook implementation** — the no-op `UploadHooks` stubs in `cli/upload-hooks.mjs` (`onConnect`/`onSessionStart`/`onTranscriptMessage`) plus a new execution-snapshot hook are wired to POST the snapshot. The WakeQueue is the source of truth; the hook reads its running/pending state. The daemon must verify the actual WakeQueue API (`enqueue`, `pendingKeyCount`, internal `running`/`pending`) against the code rather than assuming method names.
- **New `execution:{connectionUuid}` SSE event type** — published through the existing `EventBus` (+ Redis pub/sub) so the Agent Connections page updates in real time. This **deliberately diverges** from `agent-connection-observability`'s "polling, not SSE" decision: connection liveness changes slowly (90s staleness window, 15s poll is fine), but which task is running changes on the order of seconds, so execution state warrants a push channel. The owner confirmed this divergence in elaboration (Q4).
- **Agent Connections detail-pane execution view** — the connection detail `ComingSoonPlaceholder` is replaced with a live list of the connection's `running` and `queued` tasks (task title/link, root-idea session, `running`/`queued` badge, started/elapsed for running rows), subscribed to the new SSE event. The list-reservation requirement in `agent-connection-observability` is satisfied by real data here.
- **Offline reconciliation** — when a connection goes offline (heartbeat older than the registry's `STALE_THRESHOLD_MS`, the same constant `agent-connection-observability` reuses), its `running`/`queued` rows transition to a terminal state so the UI stops showing them as active. The owner's Q6 answer was "an offline daemon shows **no active execution**" (do not keep rendering it as running). Combined with the persistent-table choice (Q2=a), this is reconciled — and explicitly owner-confirmed in the idea comments — as: stop *rendering* the rows as running/queued, but *retain* them (`ended`) as queryable history rather than deleting them. "Clear" here means "stop showing as active", not "delete".

## Capabilities

### New Capabilities

- `daemon-execution-state`: The daemon execution-state concept end to end — the `DaemonTaskExecution` model, the ingest endpoint contract, the daemon snapshot upload, the `execution:{connectionUuid}` SSE channel, the detail-pane execution view, owner-scoped visibility, and offline reconciliation semantics.

## Impact

- **Schema**: one new `DaemonTaskExecution` model + one Prisma-CLI migration (DDL-only, no backfill). No change to `DaemonConnection` or `AgentSession`.
- **Backend code**: new `src/services/daemon-execution.service.ts` (reconcile snapshot, query visible execution, offline transition), new route `src/app/api/daemon/execution-state/route.ts`, a new `EventBus` event type in `src/lib/event-bus.ts`, and a hook into the offline-marking path so going offline reconciles execution rows.
- **Frontend code**: replace the detail-pane placeholder in `src/app/(dashboard)/agent-connections/page.tsx` (and/or a new child component) with the execution list; add an SSE subscription for `execution:{connectionUuid}`. All user-facing strings localized in `en` + `zh`.
- **Daemon (npm CLI) code**: implement `cli/upload-hooks.mjs` to POST snapshots; read state from `cli/wake-queue.mjs`; wire the hook into the wake lifecycle in `cli/waker.mjs`. Cross-platform, zero new npm dependencies (CLAUDE.md pitfall #9).
- **Visibility**: owner-scoped, identical rule to `agent-connection-observability` — users see only their own agents' executions; agent keys see only their own. Server-enforced, no new permission bit.
- **Dependency on 子1 (concurrency model, `e3cabd3c`)**: none for this slice. The WakeQueue's running/queued state exists today; 子1 only makes the concurrency cap configurable, which lengthens the queued list without changing the reported fields. Confirmed in elaboration (Q7).
- **Out of scope**: configurable concurrency cap (子1), interrupt/resume reverse-control channel (子3), full transcript ingest/replay (`f2fe9a7f` transcript panel), execution state on the task detail page (deferred — this slice surfaces only on the Agent Connections page per umbrella Q7), and a server-side reaper for stale rows (offline transition is handled inline on the offline-marking path; a background reaper remains a possible follow-up).
- **Backward compat**: fully additive. The ingest endpoint and SSE event are new; an older daemon that never POSTs simply shows an empty execution list, exactly as the placeholder did.
