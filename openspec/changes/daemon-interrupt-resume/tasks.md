# Tasks: Daemon interrupt/resume

> Interrupted state is recorded on the **execution row** (`DaemonExecution`), not on `Task` —
> entity-generic (task / idea / proposal / document), corrected after owner review of the
> original task-centric draft.

## 1. Schema + execution interrupt/resume service (server)
- [x] 1.1 Add `interruptedReason` (`user`|`crash`, nullable) + `interrupted` status value to `DaemonExecution`; `Task` unchanged
- [x] 1.2 Prisma-CLI-generated, DDL-only migration (`add_daemon_execution_interrupted`, no backfill); regenerate client
- [x] 1.3 `reportExecutionInterrupt(...)` — mark the connection+entity row `interrupted` + reason (404 when no row)
- [x] 1.4 `resumeExecution(...)` — require `interrupted`+`reason=user` (reject crash/non-interrupted), transition back to `running` clearing reason
- [x] 1.5 Sticky reconcile: snapshot/offline sweep only ends `running`/`queued`; reads (`DISPLAYABLE_EXECUTION_STATUSES`) include `interrupted`; live-connection filter keeps interrupted rows visible offline
- [x] 1.6 Unit tests: report user/crash, resume happy/crash-not-resumable/not-found, sticky reconcile, displayable statuses

## 2. Reverse control channel: endpoints + dispatch + SSE event (server)
- [x] 2.1 `daemon-control.service.ts`: `dispatchControl(...)` (the swap-able seam) + shared `authorizeConnectionControl(...)`; commands `interrupt` + `resume`
- [x] 2.2 `control:{connectionUuid}` event type in `event-bus.ts` (additive; Redis fan-out; command union `interrupt|resume`)
- [x] 2.3 `POST /api/daemon/control`: Zod body, owner-or-`task:admin` authz, company-scoped resolve, 404 non-disclosure, standard envelope
- [x] 2.4 `POST /api/daemon/report-interrupt`: daemon records the interrupt/crash outcome (shared authz), publishes execution change
- [x] 2.5 `POST /api/daemon/resume`: refuses up front if the daemon is offline (`isConnectionLive` — the transient resume command would otherwise be dropped), else records the transition + dispatches the `resume` control command, publishes change
- [x] 2.6 Subscribe per-connection handler to `control:{conn.uuid}` in the notifications SSE route; tear down on abort
- [x] 2.7 Tests: authz matrix (owner / task:admin / neither / cross-company), unknown command rejected, event published once, no Notification row, both new routes

## 3. Daemon control path + resume re-dispatch (CLI)
- [x] 3.1 `sse-listener.mjs`: recognize `type:"control"`, route to `onControl`, never fall through to `onEvent`
- [x] 3.2 `control-handler.mjs`: on `interrupt` connection-uuid + entity double-check then kill; on `resume` re-dispatch (connection-uuid check only); ignore (logged) on mismatch
- [x] 3.3 `process-killer.mjs`: two-stage SIGINT→timeout→tree-kill; POSIX process-group kill, Windows `taskkill /T /F`; injectable; never throws
- [x] 3.4 `claude-spawner.mjs`: POSIX `detached:true` spawn; expose child handle; stdin/stdout unaffected
- [x] 3.5 `waker.mjs`: store child handle in `executions`; snapshot serializable-only; report interrupted(user/crash) via the entity-generic reporter
- [x] 3.6 `interrupt-reporter.mjs`: entity-generic, posts to `/api/daemon/report-interrupt` with `connectionUuid`
- [x] 3.7 Layered `sigintTimeoutMs` resolution (flag > env > daemon.json > 10000)
- [x] 3.8 `EventRouter.dispatchResume` + `resource_resumed` wake-action/prompt in `prompts.mjs` (drives `--resume`)
- [x] 3.9 Tests: control→zero enqueues; double-check pass/fail; resume re-dispatch; kill timing; snapshot excludes child; user-vs-crash; reporter; `resource_resumed` prompt

## 4. Frontend interrupt/resume controls (UI)
- [x] 4.1 Interrupt action on running execution rows → `POST /api/daemon/control`
- [x] 4.2 Sticky Interrupted section; Resume action on `interrupted`+`reason=user` rows → `POST /api/daemon/resume`; auto-recovers hint for `crash`
- [x] 4.3 Interrupted state badge/indicator; localized `en`+`zh` strings; shadcn/ui only
- [x] 4.4 Update `design.pen` for the new controls
- [x] 4.5 Tests: interrupted row renders Resume (user) / no-Resume (crash); resume POST body; sticky row not empty-state

## 5. Integration checkpoint: end-to-end interrupt + resume + crash recovery
- [x] 5.1 E2E (deterministic, fake child + fake timers): dispatch → running → interrupt → SIGINT → reportInterrupt(user) → resume control command → `--resume` continues same session
- [x] 5.2 E2E: subprocess crash → reportInterrupt(crash); reconnect-backfill auto-recovers
- [x] 5.3 E2E: stale connection uuid / not-held entity → no mis-kill; control event never spawns a new Claude
- [x] 5.4 Full suite green: `tsc --noEmit` + vitest (2302 app + 191 cli) + eslint on changed files
