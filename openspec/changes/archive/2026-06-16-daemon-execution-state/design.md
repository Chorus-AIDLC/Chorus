# Technical Design: Daemon execution-state reporting + UI

## Overview

Surface, in real time, which tasks a daemon connection is **running** and which are **queued**, on the existing Agent Connections page. The daemon already knows this — `WakeQueue` (`cli/wake-queue.mjs`) holds `running` and `pending` keys in process memory. This change gives that state a persistence model, an ingest path, a push channel, and a UI.

Data flow:

```
WakeQueue (running/pending)
  → daemon upload hook builds snapshot
  → POST /api/daemon/execution-state   (agent-key, REST)
  → daemon-execution.service reconciles DaemonTaskExecution rows for the connection
  → EventBus.publish("execution:{connectionUuid}", …)  (+ Redis fan-out)
  → SSE → Agent Connections detail pane re-renders running/queued list
```

Offline path (no daemon involvement):

```
SSE abort / stale heartbeat marks DaemonConnection offline
  → same code path reconciles that connection's running/queued rows to terminal
  → rows retained as history, no longer rendered as active
```

## Architecture

### Reuse, do not re-model

This change sits on top of two shipped capabilities and must not duplicate their models:

- **`daemon-connection-registry`** owns `DaemonConnection` (one row per SSE connection, keyed `(agentUuid, clientType, host)`), heartbeat liveness, and the exported `STALE_THRESHOLD_MS`.
- **`agent-connection-observability`** owns `GET /api/agent-connections`, the server-derived `effectiveStatus`, the owner-scoped visibility rule, and the Agent Connections page (master-detail, the detail pane currently a placeholder).

`DaemonTaskExecution` references `DaemonConnection` by `connectionUuid`. Visibility and the `effectiveStatus`/offline rule are inherited, not re-derived — the same `STALE_THRESHOLD_MS` constant decides "offline", so producer and consumer cannot drift.

### Why a persistent table (Q2)

The owner chose a persisted `DaemonTaskExecution` model over in-memory SSE pass-through. Rationale honored here: execution history is queryable after the fact, and a momentary SSE-subscriber gap does not lose the current snapshot (a late subscriber reads the table, then receives subsequent events). The cost — rows must be reconciled, including on offline — is handled below.

### Why SSE for execution but polling for connections (Q4)

`agent-connection-observability` deliberately chose 15s polling because connection liveness changes on a ~90s staleness horizon. Execution state changes on the order of seconds (a task starts, finishes, the next dequeues), so this change adds a push channel: a new `execution:{connectionUuid}` event on the existing `EventBus`. The page keeps its existing connection-list poll and **adds** an execution subscription for the selected connection — the two concerns use the cadence each warrants.

## Data Model

New Prisma model (relationMode = "prisma", cascade conventions match `AgentSession`/`DaemonConnection`):

```
model DaemonTaskExecution {
  id             Int       // internal serial
  uuid           String    // public id, @unique
  companyUuid    String
  agentUuid      String
  connectionUuid String    // → DaemonConnection.uuid
  taskUuid       String    // → Task.uuid
  rootIdeaUuid   String?   // null for a quick task with no root idea
  status         String    // "running" | "queued" | "ended"
  startedAt      DateTime? // set only while/once running
  createdAt      DateTime
  updatedAt      DateTime

  // indexes: (connectionUuid, status), (companyUuid, agentUuid), unique (connectionUuid, taskUuid)
}
```

- **`status` is a free-form string** (matching the project's `Document.type`/`status` convention), valued `running`, `queued`, or `ended`. `ended` is the terminal state used for completed, superseded, or offline-reconciled rows — the UI renders only `running`/`queued` as active; `ended` is history. Keeping one terminal value (rather than `completed`/`failed`/`stale`) is deliberate: this slice does not adjudicate task outcome (the task's own status does), it only reports daemon activity. A richer terminal taxonomy is a possible follow-up.
- **`(connectionUuid, taskUuid)` is unique** — a task appears at most once per connection; re-dispatch updates the existing row (queued → running → ended).
- **`rootIdeaUuid` is nullable** — mirrors the daemon's session anchor, which is null for a quick task. The UI groups running rows by root-idea session when present.
- Migration is **DDL-only** (CLAUDE.md: no DML/backfill in migrations). Generated via `pnpm db:migrate:dev`, never hand-written.

## API Design

### `POST /api/daemon/execution-state` (new, REST, agent-key callable)

- **Auth**: Bearer agent API key (same resolution as other agent-callable REST endpoints). Not an MCP tool, no new permission bit; the connection set is scoped by the authenticated agent.
- **Request body**: a full snapshot for one connection:
  ```
  {
    "connectionUuid": "…",                 // which connection this daemon registered as
    "executions": [
      { "taskUuid": "…", "rootIdeaUuid": "…"|null, "status": "running"|"queued", "startedAt": "…"|null },
      …
    ]
  }
  ```
- **Semantics — snapshot reconcile, not incremental**: the server treats `executions` as the authoritative current state for that connection. Tasks present are upserted to their reported status; rows for that connection **absent** from the snapshot transition to `ended`. This makes the endpoint idempotent and self-healing (a dropped event cannot leave a phantom-running row — the next snapshot corrects it), which the owner's snapshot-over-incremental answer (Q3) favors.
- **Authorization fences**: the `connectionUuid` must belong to the authenticated agent (and company); otherwise 404 (not 403 — do not reveal another agent's connection). `taskUuid`/`rootIdeaUuid` are validated to the company.
- **Response**: standard envelope `{ success: true, data: { reconciled: N } }`.
- **Side effect**: publish `execution:{connectionUuid}` on the `EventBus` after a successful reconcile.

### `GET /api/agent-connections` (existing, extended)

The existing read API gains, per connection, a lightweight `execution` projection (current `running`/`queued` rows for that connection) so the page renders correct state on first paint before any SSE event arrives. Additive field; owner/self scoping and `effectiveStatus` unchanged. (Alternatively a dedicated `GET …/execution-state` read route — the implementer picks whichever keeps the page's first-paint query single-round-trip; the AC requires only that initial state is fetchable without waiting for an event.)

## Module Contracts

- **Snapshot is authoritative per connection.** Both the ingest reconcile and the offline path converge on the same rule: a `running`/`queued` row not currently justified (absent from latest snapshot, or connection offline) becomes `ended`. One reconcile helper, two callers.
- **Offline reconciliation reuses the registry's threshold.** The offline transition hangs off the existing `markDisconnected` path (abort) and the same `STALE_THRESHOLD_MS` staleness rule the read API already applies — execution rows for an effectively-offline connection are never rendered active. No second timeout constant is introduced.
- **SSE event payload** carries the connection uuid and the new running/queued list (or a "fetch" signal the client uses to re-pull) — the implementer keeps it consistent with how the page consumes existing events; the contract is "an execution change for connection X causes a re-render of X's execution list within the SSE round-trip".
- **Daemon reads the real WakeQueue API.** `cli/wake-queue.mjs` exposes `enqueue(key, task)` and `pendingKeyCount`; internal `running`/`pending` structures back them. The upload hook must read actual state from this module (verify the current surface in code — do not assume getter names), map each key to its `taskUuid`/`rootIdeaUuid` (the waker already resolves root-idea lineage), and emit the snapshot.

## Implementation Plan

1. **Model + migration + service** — add `DaemonTaskExecution`, generate the migration, write `daemon-execution.service.ts` with the snapshot-reconcile helper, the visible-execution query (owner/self scoped, company-scoped), and the offline-transition helper. Wire the offline helper into the existing disconnect/stale path. Unit-tested in isolation (Prisma mocked).
2. **Ingest endpoint + SSE event** — add the route and the `EventBus` event type; the route validates auth + fences, calls reconcile, publishes. Integration-tested against the service.
3. **Daemon snapshot upload** — implement `cli/upload-hooks.mjs` to POST snapshots built from real `WakeQueue` state; wire into `cli/waker.mjs` lifecycle (on enqueue, on wake start, on wake finish). `cli/__tests__` coverage with a fake server.
4. **UI execution view** — replace the detail-pane placeholder with the running/queued list; subscribe to `execution:{connectionUuid}`; first paint from the read API; localize strings. This is the convergence point — its AC requires the full chain (daemon snapshot → ingest → SSE → render) to work end to end against a running connection.

## Risks & Mitigations

- **Phantom "running" after a crash.** If a daemon dies mid-task, its last snapshot still says `running`. Mitigation: the offline reconciliation transitions those rows to `ended` once the connection is effectively offline (same staleness rule as the read API), so the UI stops showing them — matching the owner's Q6 choice. No separate reaper needed for the UI to be correct; a background reaper for long-`ended` row pruning is a possible follow-up, not in scope.
- **Snapshot vs event ordering.** Because the endpoint reconciles a full snapshot rather than applying deltas, out-of-order or dropped events are self-correcting on the next snapshot — no phantom state accumulates.
- **SSE divergence from sibling page.** Adding a push channel to a page that otherwise polls is a small inconsistency; mitigated by keeping the connection list on its existing poll and scoping SSE strictly to the selected connection's execution list, so the two mechanisms do not overlap responsibilities.
- **Cross-platform daemon POST.** The upload hook runs on the same platforms as the daemon (incl. Windows). It uses the daemon's existing HTTP client and zero new dependencies; no shell-out, no platform-specific paths.
- **LLM-memory hazards.** Implementers must verify against code/docs, not memory: the real `WakeQueue` method/field names, the `EventBus.publish`/subscribe signature and event-name convention, the `STALE_THRESHOLD_MS` export, and the agent-key REST auth helper used by the existing agent-connections route.
