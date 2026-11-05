# Split daemon session anchors by wake purpose (Agent Team ⑤)

## Why

The daemon uses one key for two things. Both are the agent's **direct Idea**:

- the Chorus session business key (`DaemonSession.sessionId = directIdeaUuid`, which becomes the backend id `UUIDv5(agent, anchor)`);
- the wake-queue lane (`idea:<directIdeaUuid>` in `cli/waker.mjs` `keyFor`).

This causes two defects found after Agent Team ④ (PR #645):

1. **B3: a developer who is also a reviewer reviews in its own development session.**
   - ④ q4 lets the Team route a review to the agent that built the work.
   - That review wake resumes the developer's Idea session, so the review runs with full development memory.
   - ④ q4 requires the opposite: a reviewer round starts with no carried-over memory.
   - Reproduction: real `Waker` + `ClaudeSpawner`. Send `task_assigned` and then a review `mentioned` to the same agent on the same Idea. The second wake is `--resume` of the same native id.
2. **One agent cannot run two tasks of the same Idea in parallel.**
   - Every wake for (agent, Idea) shares one serial, coalescing lane.
   - So a Team whose development role has one agent runs independent tasks one after another.

## What Changes

The server chooses a **session anchor** per wake, based on the wake's purpose (elaboration answers q1, q2, q3, q5; round 3 q1):

| Wake | Anchor (`sessionId`) |
|---|---|
| Idea-level work: Idea assignment, elaboration, proposal authoring, orchestration (Team handoffs), Verify Elaborate, Start Development, Yolo, operations, human instructions on the Idea conversation | `<directIdeaUuid>`, unchanged |
| A task wake whose recipient is the task's current assignee agent (`task_assigned`, reopen, task comments and mentions, task FAIL VERDICT). Exception: when that assignee is also the Idea orchestrator, only `task_assigned` and reopen use the task anchor; its other task wakes (including VERDICT replies) stay in the Idea session. | `task:<taskUuid>` |
| A Team review request whose recipient is the requested reviewer | `review:task:<taskUuid>`, `review:proposal:<proposalUuid>` or `review:idea:<ideaUuid>` |

Behaviour that follows from the anchors:

- **Review wakes never resume a development session.**
  - The first review of a target opens a new session.
  - A re-review of the same target by the same reviewer resumes that reviewer's own review session.
- **The server delivers the anchor.** It is sent as `sessionId` on the SSE wake notification and the pending-turn backfill.
  - The daemon uses it both as the queue lane and as the backend session anchor.
  - Different anchors run concurrently, bounded by the agent's existing `maxConcurrency`.
  - The same anchor stays serial and coalesced.
- **A new task or review session starts without Idea-session memory.**
  - Its wake prompt identifies the session scope and points the agent at the Idea, proposal and task context.
  - A task-scoped prompt tells the agent to use its own git worktree when other task sessions of the same Idea may run concurrently in the same cwd (q4: the agent handles isolation; the daemon creates no worktree).
  - A review-scoped prompt reminds the reviewer that it is read-only.
- **New sessions start in the Idea session's working directory.** A new task or review session inherits the origin connection and cwd of the agent's Idea session when one exists, so it runs in the same repository.
- **Chat UI.** Task and review sessions stay grouped under their Idea as child sessions labelled "Task: <title>" or "Review: <title>" (q6). Each child session has its own transcript, running state, interrupt, resume and takeover command.
- **Execution, interrupt and resume are tracked per session.** Two anchors can share one entity (`task:T` and `review:task:T`), so `DaemonExecution` gains a `sessionId` discriminator (default `""`). Interrupt and resume target exactly one session.
- **No session migration (q7).**
  - Existing Idea sessions keep `sessionId = directIdeaUuid` and keep resuming.
  - Daemons that ignore the delivered `sessionId` fall back to today's per-Idea behaviour.

## Capabilities

### New Capabilities
- `daemon-session-anchor`: how the server chooses a session anchor per wake, how the daemon consumes it as queue lane and backend session, and how anchored child sessions are grouped, labelled and controlled in the UI.

### Modified Capabilities
- None as delta blocks. Existing specs (`daemon-session-conversation`, `daemon-wake-coalescing`, `team-review-routing`) keep their wording. Coalescing is now per anchor; for Idea anchors that is the same as before.

## Impact

- **Server:**
  - `src/services/notification-turn.ts` (where the anchor is chosen, origin inheritance)
  - `src/services/notification.service.ts` (SSE payload `sessionId`)
  - a new `src/lib/session-anchor.ts` helper
  - `src/services/notification-listener.ts` (Team handoffs marked as Idea-anchored)
  - `src/services/daemon-session.service.ts` (session title)
  - pending-turn backfill payload
- **Daemon:**
  - `cli/waker.mjs` `keyFor` and `sessionId`
  - `cli/event-router.mjs` (pending-turn and human-instruction keys)
  - `cli/control-handler.mjs` (interrupt by session)
  - `cli/prompts.mjs` (scope guidance)
- **UI:**
  - `src/components/agent-presence/chat/daemon-chat.tsx` (conversation grouping, child-session labels)
  - `src/components/agent-presence/chat/session-execution.ts` (execution match per session)
- **Control and resume:**
  - `src/app/api/daemon/control/route.ts` and `resolveControlSessionId` (interrupt by `sessionId`)
  - `src/app/api/daemon/resume/route.ts` (re-dispatch into the same session)
  - i18n keys (en and zh)
- **Docs:** develop / orchestrate / review skill docs in both `public/skill/` and `public/chorus-plugin/skills/`, plus `docs/` daemon notes.
- **Prisma:** one additive migration. It adds `DaemonExecution.sessionId String @default("")` and changes the unique key to `(connectionUuid, entityType, entityUuid, sessionId)`. `DaemonSession` is unchanged; its `sessionId` is already free-form and unique per agent.
- **Out of scope:**
  - Non-CLI clients (OpenClaw, Hermes, dsh) adopting per-anchor lanes. They keep working on per-Idea behaviour; tracked as a follow-up.
  - A daemon-managed worktree.
