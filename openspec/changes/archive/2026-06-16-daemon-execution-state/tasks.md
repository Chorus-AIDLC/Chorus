# Tasks: Daemon execution-state reporting + UI

> Chorus task drafts are the source of truth for execution; this list mirrors them for the OpenSpec change record.

## 1. Model, migration, and execution service
- [ ] Add `DaemonTaskExecution` Prisma model + Prisma-CLI migration (DDL-only)
- [ ] `daemon-execution.service.ts`: snapshot-reconcile helper, owner/self-scoped visible-execution query, offline-transition helper
- [ ] Wire offline transition into the existing disconnect/stale path; unit tests (Prisma mocked)

## 2. Ingest endpoint + SSE event
- [ ] `POST /api/daemon/execution-state` (agent-key, fences, standard envelope)
- [ ] New `execution:{connectionUuid}` EventBus event type (+ Redis fan-out); publish on reconcile + offline
- [ ] Integration tests against the service

## 3. Daemon snapshot upload (npm CLI)
- [ ] Implement `cli/upload-hooks.mjs` to POST snapshots built from real `WakeQueue` state
- [ ] Wire into `cli/waker.mjs` lifecycle (enqueue / wake start / wake finish); `cli/__tests__` with a fake server

## 4. UI execution view (integration checkpoint)
- [ ] Replace detail-pane placeholder with running/queued lists; first paint from read API; subscribe to execution SSE
- [ ] Localize en + zh; empty state
- [ ] End-to-end: daemon snapshot → ingest → SSE → render verified against a real connection
