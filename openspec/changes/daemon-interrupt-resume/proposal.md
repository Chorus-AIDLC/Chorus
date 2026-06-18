# Proposal: Daemon interrupt/resume — server→daemon reverse control channel

## Why

The Chorus CLI daemon (`cli/`) is today a **one-way** subscriber: it opens an SSE
subscription to `/api/events/notifications`, and `cli/event-router.mjs` routes each
inbound notification by `notification.action` to a wake — spawning a local headless
`claude -p` subprocess (`cli/claude-spawner.mjs`) serialized per direct idea through the
`WakeQueue` (`cli/wake-queue.mjs`). There is **no path from the server back to the daemon**
to act on a *running* subprocess. Once a wake is spawned, the only way to stop it is to
kill the whole daemon.

This is the **③ interrupt/resume reverse-control-channel** slice (子3) of umbrella idea
`6fab91cd`, and the one its Round-1 elaboration flagged as **highest-risk / most-unknown**
because it requires building a brand-new server→daemon control direction. This sub-idea
(`4c9b3bca`) ran its own elaboration round; all eight decision points were answered by the
owner (every answer = the recommended option). This proposal turns those answers into a
buildable plan.

Concrete pain:

1. **No interrupt.** A user dispatches a task, the daemon wakes Claude, and it starts down
   the wrong path (bad approach, runaway loop, wrong task). The user can see it running
   (the 子2 execution-state view, `#323`) but has **no button to stop it** short of killing
   the daemon — which also drops every other concurrent and queued wake on that machine.
2. **No clean resume.** Even after a stop, there is no first-class way to continue the same
   Claude session where it left off. `claude --resume <directIdeaUuid>` is a latent
   capability (the session is already anchored on the direct idea uuid, `#325`), but nothing
   triggers it and nothing records that a task *was* interrupted.
3. **Crash ≠ interrupt, but both look the same.** If the subprocess crashes, the task is
   stuck `in_progress` with no signal distinguishing "the user stopped it on purpose" from
   "it died unexpectedly", and no consistent recovery path for either.

The 子2 execution-state view (`#323`, capability `daemon-execution-state`) deliberately
built the surface this slice hangs the interrupt button on, and the in-memory
`Waker.executions` registry this slice maps `task → running subprocess` against. The
reverse channel is the missing half.

## What Changes

- **New control-command channel (reuse transport, NOT the wake path).** A new
  `POST /api/daemon/control` REST endpoint (agent/user callable, owner-or-`task:admin`
  gated) publishes a **control event** — `control:{connectionUuid}` — over the existing
  `EventBus` (+ Redis fan-out), delivered to the daemon on its **existing** SSE
  subscription. Critically, this is **NOT** a persisted `Notification` and **NOT** a
  `WAKE_ACTIONS` entry: a wake-action notification would make the daemon spawn a *new*
  Claude to "handle the interrupt" — the exact opposite of killing the running one. The
  control event is a distinct SSE `type` the daemon's listener recognizes and routes to a
  **control handler**, never to the `WakeQueue`. The owner's elaboration answer (q8=a) asked
  this be built behind a small **control-dispatch interface** so a future dedicated
  bidirectional channel can replace the notification-stream transport without touching
  callers.
- **Connection-targeted + entity self-checked (q1=a).** The control event carries a
  `targetConnectionUuid` (the UI already knows which connection is running the entity, from
  the 子2 execution-state read API) **and** the target `{entityType, entityUuid}`. The
  daemon acts **only** when both match: the event's `targetConnectionUuid` equals its own
  registered `connectionUuid` (from the `connection_registered` handshake) **and** its
  in-memory `Waker.executions` map confirms it actually holds that entity's running
  subprocess. Double-checking means a stale/recycled `connectionUuid` (after a reconnect)
  can never mis-kill the wrong subprocess.
- **Authorization: owner or `task:admin` (q2=a).** The control endpoint authorizes the
  caller against the daemon agent that owns the target connection: only that agent's **owner**
  (the human `agent.ownerUuid`) or a caller with `task:admin` may issue an interrupt. No new
  permission bit; reuses the existing authz model.
- **Two-stage kill, cross-platform (q5=a, q6=a).** On interrupt, the daemon sends `SIGINT`
  to the running subprocess for a graceful stop (giving Claude a chance to flush in-progress
  work), and if it has not exited after a **default 10s** timeout, escalates to a hard kill.
  The timeout is configurable via the daemon's existing layered resolution
  (`--sigint-timeout` flag > `CHORUS_DAEMON_SIGINT_TIMEOUT` env > `~/.chorus/daemon.json` >
  default). The kill targets the whole **process tree** with zero new native dependencies
  (CLAUDE.md pitfall #9): `taskkill /PID <pid> /T /F` on Windows; a detached process-group
  `kill(-pgid)` on POSIX so any grandchildren Claude spawned are also reaped.
- **`task → subprocess` mapping via the 子2 registry (q4=a).** `Waker.executions` (keyed
  `entityType:entityUuid`) is extended to also hold the live child handle/pid for the
  running wake, so an interrupt for an entity resolves directly to its subprocess — same
  source as the execution snapshot, zero new index.
- **New `interrupted` execution state + reason (q3=a, corrected to execution-level).** The
  interrupted state lives on the **`DaemonExecution`** row (keyed connection + entity), NOT on
  `Task` — because the daemon executes idea / proposal / document wakes too, so interruption is
  an execution-lifecycle fact that must apply to any wake-triggering resource, not just tasks.
  `DaemonExecution.status` gains an `interrupted` value and the model gains an
  `interruptedReason` (`user` | `crash`). User-requested interrupts and unexpected crashes
  **share** the `interrupted` state, distinguished by `interruptedReason`. It is **sticky**:
  snapshot/offline reconcile never auto-ends an `interrupted` row, so the "interrupted —
  resumable" affordance keeps showing after the killed subprocess drops out of the next
  snapshot. Created via a Prisma-CLI-generated, DDL-only migration. `Task` is unchanged.
  *(This corrects the original task-centric design after owner review: `Task.interruptedReason`
  would only cover 1 of the 4 entity types and pollute the task domain model with an infra
  concern.)*
- **Resume, by intent (q7=a).** A user-requested interrupt surfaces a **manual "Resume"**
  control on the interrupted execution row, which calls a new **`POST /api/daemon/resume`**
  endpoint (keyed connection + entity — the same daemon surface as interrupt, entity-generic,
  NOT a Task-level endpoint). That endpoint transitions the execution row `interrupted →
  running`, clears `interruptedReason`, and dispatches a **`resume` control command** on the
  reverse control channel to the holding connection. The daemon re-dispatches the wake for that
  entity (a synthetic `resource_resumed` wake), continuing via `claude --resume
  <directIdeaUuid>` (the disk-probe in `isNewSession` already selects `--resume` when the
  transcript exists). A **crash** (`interruptedReason = crash`) is recovered by the **existing
  reconnect-backfill** path automatically — no user action, not manually resumable — so an
  intentional stop is never silently auto-restarted against the user's intent.

## Capabilities

### New Capabilities

- `daemon-interrupt-resume`: the reverse control channel end to end — the
  `POST /api/daemon/control` endpoint and its authz, the non-wake `control:{connectionUuid}`
  SSE event type, the daemon-side control handler with connection+entity double-check, the
  two-stage cross-platform process-tree kill with configurable timeout, the
  `task → subprocess` handle mapping, the `interrupted` task state + `interruptedReason`, and
  the intent-based resume (manual button for user interrupts, reconnect-backfill auto-resume
  for crashes).

## Impact

- **Schema**: `DaemonExecution` gains `interruptedReason` (`user` | `crash`, nullable) and an
  `interrupted` value in its `status`. One Prisma-CLI migration (DDL-only, no backfill —
  memory: no-DML-in-migrations). No change to `Task`, `DaemonConnection`, or `AgentSession`.
- **Backend code**: new `POST /api/daemon/control` route (`src/app/api/daemon/control/route.ts`);
  a control-dispatch service that authorizes the caller (shared `authorizeConnectionControl`),
  resolves the target connection's owner, and publishes the `control:{connectionUuid}` event
  (commands `interrupt` + `resume`); a new `control:` event type in `src/lib/event-bus.ts`
  (additive — must not alter notification/presence/execution events); execution-state changes in
  `src/services/daemon-execution.service.ts` (the sticky `interrupted` status + reason,
  `reportExecutionInterrupt`, `resumeExecution`, reconcile keeps `interrupted` rows, reads
  include them); a new `POST /api/daemon/report-interrupt` route (the daemon records the
  interrupt/crash outcome) and a new `POST /api/daemon/resume` route (records the transition +
  dispatches the `resume` control command). No change to `src/services/task.service.ts`.
- **Daemon (npm CLI) code**: `cli/sse-listener.mjs` recognizes the `control` event type and
  routes it to a new control handler (NOT `onEvent`→router→queue); a new
  `cli/control-handler.mjs` that does the connection+entity double-check, invokes the killer on
  `interrupt`, and re-dispatches the wake on `resume`; a new `cli/process-killer.mjs`
  implementing the two-stage cross-platform process-tree kill; `cli/claude-spawner.mjs`
  returns/exposes the child handle and spawns POSIX children `detached` in their own process
  group; `cli/waker.mjs` stores the child handle in `executions` and reports the `interrupted`
  outcome via `cli/interrupt-reporter.mjs` (entity-generic, posts to
  `/api/daemon/report-interrupt` with the connection uuid); `cli/event-router.mjs` gains
  `dispatchResume`, and `resource_resumed` is added to `WAKE_ACTIONS` with a continue prompt in
  `cli/prompts.mjs` so the resume re-dispatch wakes the daemon. Layered config gains
  `sigintTimeoutMs`. Zero new npm dependencies; Bash-3.2-safe if any shell is touched.
- **Frontend code**: the Agent Connections detail pane (`src/app/(dashboard)/agent-connections/`)
  gains an **Interrupt** action on each running execution row, a sticky **Interrupted** section
  with a **Resume** action on each `interrupted` + `reason=user` row (and an "auto-recovers"
  hint for `crash` rows); all user-facing strings localized in `en` + `zh`; `design.pen` updated
  for the new controls.
- **Authorization**: owner-or-`task:admin`, server-enforced on the control endpoint; no new
  permission bit.
- **Dependency on 子1 / 子2**: this slice builds on 子2 (`daemon-execution-state`, `#323`
  — the execution registry + connection-targeted view) and the direct-idea session anchor
  (`#325`). 子1 (configurable concurrency) is independent. Recommended to land after 子2,
  which is already on `develop`.
- **Out of scope**: a dedicated bidirectional command channel (this slice only reserves the
  interface seam — q8=a); UI-injected mid-turn prompts ("inject a turn"); pause/suspend
  (SIGSTOP) as distinct from interrupt; interrupting non-Claude agent CLIs; bulk "interrupt
  all" controls.
