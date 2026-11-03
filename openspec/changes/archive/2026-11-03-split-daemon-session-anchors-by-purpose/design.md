# Design: split daemon session anchors by wake purpose

## Context

Today a wake has a single identity, chosen at `createTurnAndResolveTarget` (`src/services/notification-turn.ts`, around L1046):

```
sessionId = directIdeaUuid ?? ctx.entityUuid
```

The daemon recomputes the same identity in two places:

- the queue lane: `keyFor` returns `idea:<directIdeaUuid>`;
- the session: `wakeBatch` uses `first.sessionId ?? directIdeaUuid ?? entityUuid` and then `backendSessionKey(sessionId, agentUuid)`.

The server only sends `sessionId` to the daemon on pending-turn backfill. It is not on the live SSE notification. `DaemonSession` is unique on `(agentUuid, sessionId)`, and `sessionId` is a free-form string, so session anchors need no `DaemonSession` schema change. The only schema change is the additive `DaemonExecution.sessionId` discriminator (D4b).

## Goals / Non-goals

**Goals**
- Review wakes never resume a development session. This fixes B3.
- Re-review affinity resumes the reviewer's own review session.
- One agent can run tasks of the same Idea concurrently.
- The server is the single source of the anchor (q5=a).
- Existing sessions and old daemons keep working (q7=a).

**Non-goals**
- A daemon-managed git worktree. q4=b leaves isolation to the agent.
- Per-anchor lanes in non-CLI clients (OpenClaw, Hermes, dsh).
- Changing Idea-level orchestration. Start Development and Yolo stay in the Idea session (round 3 q1=a).

## Decisions

### D1. Anchor format (`src/lib/session-anchor.ts`, new; pure, shared by server and UI)

```ts
type SessionAnchor =
  | { kind: "idea";   sessionId: string /* = directIdeaUuid */ }
  | { kind: "task";   sessionId: `task:${string}`;            entityType: "task";     entityUuid: string }
  | { kind: "review"; sessionId: `review:${"task"|"proposal"|"idea"}:${string}`; entityType: "task"|"proposal"|"idea"; entityUuid: string };

formatSessionAnchor(kind, entityType?, entityUuid?) → sessionId
parseSessionAnchor(sessionId, directIdeaUuid) → SessionAnchor | { kind: "adhoc" }
```

- An Idea anchor keeps the **bare** `directIdeaUuid`. This is what keeps existing sessions working without migration.
- The `task:` and `review:` prefixes cannot collide with the bare-UUID Idea and ad-hoc keys.
- Task and review sessions keep `directIdeaUuid = <direct idea>`. That keeps them grouped under the Idea (q6=a), and lineage, access and stale-turn logic stay unchanged.

### D2. Anchor resolution at the chokepoint (`resolveWakeSessionAnchor`)

Inputs: the wake context (`action`, `entityType`, `entityUuid`, `recipientUuid`), `directIdeaUuid`, and an optional transport-only `sessionAnchorHint`.

The hint is never persisted on the Notification row, like `pinnedHost` and `pinnedCwd`.

Rules are applied in order. The first match wins.

1. **No `directIdeaUuid`** → unchanged (`ctx.entityUuid`). Quick tasks are already task-keyed.
2. **Operations, `human_instruction`, research** → Idea anchor. Their existing invariants (`operation.mjs` and the research service require `sessionId === directIdeaUuid`) stay unchanged.
3. **`sessionAnchorHint` present** (see D3) → that anchor, after validation:
   - The hinted entity is checked with the existing lineage resolution. It must resolve to the same `directIdeaUuid` and belong to the same company. A mismatch falls back to rule 5 and logs a warning.
4. **The entity is a task and the recipient is the task's current assignee agent** → `task:<taskUuid>`.
   - **Orchestrator exception (4a).** If the recipient is also the Idea's current assignee (the orchestrator), only the task-start triggers use `task:<taskUuid>`. These are `task_assigned` and the task-reopen wake. Every other task wake for that recipient uses the Idea anchor, including comments, mentions and PASS / FAIL VERDICT replies. Verifying the task and advancing the DAG is orchestration, so it stays in the Idea session (round 3 q1).
   - Covers `task_assigned`, task status, reopen, comment and mention wakes.
   - "Current assignee agent" means `assigneeType ∈ {agent, agent_instance}`, resolved to its logical agent.
   - The hint `idea` overrides this rule (Team handoffs, D3).
5. **Otherwise** → Idea anchor (today's behaviour).

### D3. Where hints are set

- **Team review request** (`mention.service.ts`, where the full comment `content` is known):
  - When the comment has a line matching `/^Team review request\s+[—-]\s+(proposal|task|code)\b/m` and no line starting with `VERDICT:`, every agent mention recipient of that comment gets a hint of `review:<targetType>:<targetUuid>`.
  - The target is the **comment's own target**: the orchestrate protocol posts the request on the review target.
  - The kind must match the target type: `proposal`→proposal, `task`→task, `code`→idea. On a mismatch no hint is set and a warning is logged.
- **Team handoff** (`notifyIdeaTeamHandoff`): hint `idea`. Orchestrator handoffs about a task always land in the orchestrator's Idea session, even when the orchestrator is also the task's assignee.
- **VERDICT replies:**
  - A task FAIL VERDICT mentions the task developer on the task, so rule 4 gives `task:<uuid>`. The developer resumes its task session, as intended.
  - PASS and proposal VERDICTs mention the orchestrator or product delegate. They get the Idea anchor by rule 5, or by rule 4a when the orchestrator is also the task's assignee.

### D4. Origin and cwd for new anchored sessions

- The connection is still selected by the existing precedence: instance pin, then idea-session origin, then project cwd pin, then the narrow.
- For a task or review anchor, "idea-session origin" means the agent's **Idea session** (`sessionId = directIdeaUuid`). `resolveIdeaSessionOriginTarget` keeps looking up the Idea session.
- A newly created anchored session copies the Idea session's `runtimeCwd` when the wake was not directed elsewhere. New task and review sessions therefore run in the same repository as the Idea work.
- The cross-cwd re-point logic applies to the anchored session's own row.

### D4b. Per-session execution identity (schema change)

Two anchors of one agent can share a wake entity. `task:T` and `review:task:T` share (task, T); `review:idea:I` and the Idea session `I` share (idea, I). Because these now run in separate lanes, their runs can overlap. Execution, interrupt and resume identity must therefore be per session:

- **Schema.** Add `DaemonExecution.sessionId String @default("")` and change the unique key to `@@unique([connectionUuid, entityType, entityUuid, sessionId])`, with a Prisma migration.
  - `""` means an Idea, ad-hoc or legacy lane. Existing rows and old daemons keep `""` and behave exactly as today.
  - A scoped (task or review) lane stores its anchor string.
- **Daemon.**
  - The in-memory `executions` registry, the snapshot upload and the turn and execution reports key on `(entityType, entityUuid, scopedSessionId)`.
  - `scopedSessionId` is the anchor for task and review lanes and `""` otherwise.
- **Control.**
  - `/api/daemon/control` (interrupt) and the daemon `control-handler` accept an optional `sessionId`. When it is present, they target only the execution with that `sessionId`.
  - `resolveControlSessionId` resolves an anchored session by its own `sessionId`.
  - Without `sessionId`, the legacy entity match applies, restricted to `sessionId = ""` rows.
- **Resume.** `/api/daemon/resume` re-dispatches using the execution row's `sessionId`, so the resumed turn lands in the same session.
- **Ownership.** An Idea session matches only executions whose `directIdeaUuid` matches and whose `sessionId` is `""`. Anchored sessions match their own `sessionId`.
- **Other call sites.**
  - `daemon-execution.service.ts` `hasRunningExecution` (around L642) keeps its Idea-wide "any running work under this Idea" meaning, so anchored executions count.
  - `research-eligibility.service.ts:116` filters a turn by uuid and needs no change. T1 confirms both and documents the outcome.

### D5. Session title

On create, a task or review session gets `title`:

- `Task: <task title>`
- `Review: <task title | proposal title | idea title>`

The title is truncated by the existing rules. The UI localizes the prefix from `parseSessionAnchor(sessionId).kind`; the stored title is the fallback.

### D6. Wire: `sessionId` on live SSE

- `notification.service.ts` adds `sessionId` (the resolved anchor) to the `new_notification` SSE payload whenever a turn was created. This covers the single and batch paths.
- Backfill already carries `sessionId`.
- Old daemons ignore the field and keep per-Idea lanes and sessions. The server-side turn still lives on the new session row. That is acceptable degradation: the turn settles through `(agentUuid, sessionId)`, which the old daemon reports as `directIdeaUuid`. The T1 implementation must make the settle path tolerate the mismatch. It may do this by including `turnUuid`, which old daemons already send.

### D7. Daemon consumption

- **`keyFor(notification)`**: when `notification.sessionId` is a task or review anchor (via `parseSessionAnchor`), return `{ key: "session:<sessionId>", rootIdeaUuid, directIdeaUuid }`. Otherwise keep today's keys.
- **`event-router`**:
  - `#dispatchPendingTurnNow` already threads `sessionId` into `#resolveAndEnqueue`, so `keyFor` picks it up.
  - Human-instruction and operation keys stay `idea:` because they are Idea-anchored by D2.
  - The router must also forward `sessionId` from the live SSE event into the notification object it enqueues.
- **`wakeBatch`**: already uses `first.sessionId`. The coalesced-batch entity synthesis stays `idea:<direct>` only for Idea anchors. For anchored lanes, the batch entity is the anchor entity.
- **Concurrency**: different keys run concurrently under `maxConcurrency`, with no new knob. "Opt-in" (q3=a) means a Team or orchestrator choosing to assign several tasks of one Idea to the same agent; nothing changes for agents that receive one task at a time.
- **`control-handler` interrupt**: resolve the target by the execution's own `sessionId` (D4b), not by `entry.directIdeaUuid ?? entityUuid`. Interrupting one session must not stop a sibling, including a same-entity sibling (`task:T` vs `review:task:T`).
- **`prompts.mjs`**: add a scope header for anchored wakes.
  - Task: "This wake runs in a task-scoped session for task <uuid>; it has no memory of the Idea session — read the task, its proposal and the Idea first. Other tasks of the same Idea may run concurrently in this working directory: before editing files, work in your own git worktree (e.g. EnterWorktree / `git worktree add`)."
  - Review: "This is a review-scoped session for <kind> <uuid>; it never carries development memory. Stay read-only."
  - Keep the OpenClaw twin note where applicable (OpenClaw is out of scope).

### D8. UI (`src/components/agent-presence/chat/daemon-chat.tsx`, `src/components/agent-presence/chat/session-execution.ts`)

- **Conversation key**: `daemon_session:<sessionId>` for task and review anchors. Idea anchors keep `idea:<directIdeaUuid>`.
- **Grouping**: the conversation list nests anchored sessions under their Idea conversation as child rows, with a localized label:
  - `daemonChat.childSession.task` = "Task: {title}"
  - `daemonChat.childSession.review` = "Review: {title}"

  An Idea with only anchored sessions still shows an Idea group header.
- **Running and interrupt matching** (`session-execution.ts`): match executions by `execution.sessionId` (D4b). An anchored session matches `execution.sessionId === session.sessionId`. An Idea session matches `directIdeaUuid` with `execution.sessionId === ""`. Interrupt and resume send the session's `sessionId`.
- **Takeover and resume**: use the session's own `backendSessionId`, or `backendSessionKey(sessionId, agentUuid)`, instead of assuming `claude --resume <directIdeaUuid>`.
- **Both themes**: use semantic tokens only.
- **`docs/design.pen`**: update via the Pencil MCP. When that MCP is unavailable in the executing session, record it as a follow-up in the task report.

## Risks / Trade-offs

- **Text-marker detection of review requests.** It depends on the orchestrate protocol's mandated envelope. It is mitigated by requiring the target-type match and the no-`VERDICT:`-line rule; a missed match degrades to today's behaviour (Idea anchor), not to a wrong anchor.
- **Parallel task sessions in one cwd can conflict.** This is mitigated by prompt guidance (q4=b) and the develop-skill worktree instructions. Residual risk is accepted.
- **Lost Idea-session context for task sessions** is intended. The prompt points the agent to Chorus context.
- **Places that assume one session per Idea** (`orchestrator.service.ts:56`, `notification-turn.ts:682-691`, `daemon-instruction.service.ts:272` and `:838`) must keep selecting the Idea session by `sessionId = directIdeaUuid`. The execution-level sites are handled in D4b.

## Migration

- **Sessions:** no session migration. Existing rows are Idea or ad-hoc anchored by construction.
- **Executions:** one additive Prisma migration adds `DaemonExecution.sessionId` (default `""`) and swaps the unique index. Existing rows get `""`.
