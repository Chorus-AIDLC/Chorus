## Why

When an idea derived from a parent (a **child** idea) receives a daemon wake — a `task_assigned`, or a proposal `approve`/`reject` — the daemon chat UI shows the **parent** idea as "in progress" and interruptible, while the child that actually owns the woken session looks idle. The wrong conversation lights up, and a human trying to interrupt the running work targets the wrong idea.

Root cause is the daemon's **two-ID contract** leaking. Each wake resolves both a `directIdeaUuid` (the entity's directly-attached idea — the child) and a `rootIdeaUuid` (the topmost ancestor — the parent). The daemon correctly anchors the Claude session on `directIdeaUuid`, but the execution snapshot it reports carries only `rootIdeaUuid`. The chat UI's per-conversation match predicate (`session-execution.ts`) therefore matches an execution to a conversation via `exec.rootIdeaUuid === session.directIdeaUuid` — an equality that holds **only for a top-level idea** (where direct == root). For a child, a task/proposal wake resolves `directIdeaUuid = child`, `rootIdeaUuid = parent`, so the execution matches the **parent** conversation and the child shows idle. The `directIdeaUuid` needed to fix this is already computed by the daemon; it is simply dropped before the execution registry.

Separately — and independent of lineage — the daemon's `proposal_approved` wake prompt **drops the approver's note**. The `proposal_rejected` prompt already embeds the reviewer's reason (via the notification `message`), but the approve prompt omits it, so on approval the daemon does not know the reviewer's opinion and must re-fetch the proposal to discover it. The note is already carried on the notification `message`; the approve prompt just fails to surface it.

## What Changes

- **Thread `directIdeaUuid` through the execution snapshot end-to-end.** The daemon already resolves `directIdeaUuid` per wake; carry it on the execution registry entry, emit it in the execution snapshot, validate it at the ingest zod boundary, persist it as a new nullable `DaemonExecution.directIdeaUuid` column, and project it onto `ExecutionView`. Mirror the same field in the OpenClaw plugin's execution-snapshot client so both daemon hosts report the identical wire shape.
- **Match a conversation's execution by the DIRECT idea, not the root.** The chat UI predicate `executionMatchesSession` changes from matching `exec.rootIdeaUuid === session.directIdeaUuid` to matching `exec.directIdeaUuid === session.directIdeaUuid` (plus the existing direct `entityType==="idea"` case). Result: a child idea's task/proposal wake surfaces the running/interruptible state on the **child** conversation only; the parent shows nothing about the child's run (elaboration Q1 = child-only). This also fixes the identical mis-display for proposal `approve`/`reject` wakes, which anchor on the proposal's direct idea.
- **Deliver the reviewer's note inline on the approve wake, for every proposal wake.** The `proposal_approved` daemon prompt is updated to surface the approver's note (from the notification `message`, exactly as `proposal_rejected` already does) so the daemon knows the decision context without a follow-up fetch. Applies to all proposal wakes regardless of lineage (elaboration Q2 = inline note for both, Q4 = all proposal wakes). No new payload field — the note already rides `message`.

Out of scope (elaboration Q3 = reported symptoms only): the latent proposal-pin-inheritance direct-vs-root asymmetry (`resolveRootIdeaUuidForPin`) is **not** touched by this change.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `daemon-execution-state`: the execution snapshot / persisted row / read projection currently carry only `rootIdeaUuid` as the lineage anchor. This adds a `directIdeaUuid` field across the wire, the `DaemonExecution` model, and the `ExecutionView` projection, and makes the per-conversation execution match key the **direct** idea — so a child-idea wake surfaces on the child conversation, not its parent.
- `stage-advance-wake`: extended (via the daemon wake-prompt contract) so the `proposal_approved` wake surfaces the reviewer's note inline, matching `proposal_rejected`, for every proposal wake.

## Impact

- **Daemon (CLI)**: `cli/waker.mjs` (execution registry entry + `buildExecutionSnapshot` + the two set-sites in `markQueued`/`wake` carry `directIdeaUuid`), `cli/prompts.mjs` (`proposal_approved` body surfaces the note). `directIdeaUuid` is already resolved by `cli/lineage.mjs` and threaded in `attribution` — no lineage change.
- **OpenClaw plugin**: `packages/openclaw-plugin/src/daemon-client.ts` (`ExecutionEntry` + `buildExecutionSnapshot` + set-sites) and `packages/openclaw-plugin/src/daemon-rest-client.ts` (`DaemonExecutionRow` wire type) mirror the field so the second daemon host reports the identical shape.
- **Server**: `src/app/api/daemon/execution-state/route.ts` (`snapshotEntrySchema` accepts `directIdeaUuid`), `src/services/daemon-execution.service.ts` (`SnapshotExecution`, `DaemonExecutionRow`, `ExecutionView`, `toExecutionView`, `reconcileSnapshot` create+update). SSE delivery (`src/app/api/events/route.ts`) carries the field automatically via the `ExecutionView` spread.
- **Database**: one Prisma-CLI-generated migration adding a nullable `directIdeaUuid String?` column to `DaemonExecution` (DDL only, no backfill).
- **Frontend**: `src/components/agent-presence/chat/session-execution.ts` (the match predicate switches to `directIdeaUuid`); the re-exported `ExecutionView` type propagates the new field with no separate frontend type edit.
- **No new permission bit. No new MCP tool.** The note delivery reuses the existing notification `message` (no new wire field).
- **Tests**: CLI (`upload-hooks`, `daemon-rest-client`, `wake-orchestration`), OpenClaw (`daemon-client`), server (`daemon-execution.service`, `execution-state` route), and frontend (`session-execution`, `agent-presence-context`) snapshot-shape + match-predicate assertions; a `prompts` assertion that the approve prompt surfaces the note.
