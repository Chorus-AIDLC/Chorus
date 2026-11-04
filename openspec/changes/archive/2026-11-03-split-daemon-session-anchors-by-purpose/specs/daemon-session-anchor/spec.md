## ADDED Requirements

### Requirement: Server-chosen session anchor per wake

The wake chokepoint SHALL resolve a session anchor for every wake that has a direct Idea. That anchor SHALL be used as `DaemonSession.sessionId`:
- `<directIdeaUuid>` for Idea-level wakes;
- `task:<taskUuid>` for a task wake whose recipient is the task's current assignee agent;
- `review:<task|proposal|idea>:<uuid>` for a Team review request delivered to the requested reviewer.

Operations, human instructions and research wakes SHALL keep the Idea anchor.

A wake without a direct Idea SHALL keep its existing key.

A task or review session SHALL keep `directIdeaUuid` set to its direct Idea.

#### Scenario: Developer who also reviews gets a separate review session
- **WHEN** agent D receives `task_assigned` for task T of Idea I
- **AND THEN** D is @mentioned on T by a comment containing `Team review request — task, round 1`
- **THEN** the first wake's sessionId is `task:T`
- **AND** the second wake's sessionId is `review:task:T`
- **AND** the backend ids `UUIDv5(D, anchor)` differ, so the review never resumes the development session

#### Scenario: Re-review resumes the reviewer's own review session
- **WHEN** reviewer R reviewed task T in round 1 and is requested again for round 2
- **THEN** both review wakes use sessionId `review:task:T` and the second resumes the first

#### Scenario: Team handoff stays in the Idea session
- **WHEN** the server sends an Idea Team handoff about task T to orchestrator O, who is also T's assignee
- **THEN** the wake's sessionId is the direct Idea uuid

#### Scenario: VERDICT to an orchestrator who is also the task assignee stays in the Idea session
- **WHEN** orchestrator O assigned task T of Idea I to itself and worked T in session `task:T`
- **AND** a reviewer posts a PASS VERDICT on T that @mentions O
- **THEN** O's wake uses the Idea anchor I, not `task:T`

#### Scenario: Mismatched review envelope falls back
- **WHEN** a comment on a proposal says `Team review request — task, round 1`
- **THEN** no review anchor is applied and the wake uses the rule that would otherwise apply

#### Scenario: Task FAIL returns to the task session
- **WHEN** a task FAIL VERDICT on task T @mentions T's developer D
- **THEN** D's wake uses sessionId `task:T`

### Requirement: Anchored sessions inherit the Idea session's working directory

A newly created task or review session SHALL use the existing connection-selection precedence, in which the agent's Idea session origin is the idea-session origin. When not directed elsewhere, the new session SHALL inherit that Idea session's runtime cwd.

#### Scenario: Task session starts in the Idea repo
- **WHEN** agent D has an Idea session for I on connection C with runtime cwd P
- **AND** D is assigned task T of I with no pin
- **THEN** the session `task:T` is created on C with runtime cwd P

### Requirement: Daemon lanes follow the delivered anchor

The server SHALL include the resolved `sessionId` on the live `new_notification` SSE event, as it already does on pending-turn backfill.

The CLI daemon SHALL use a delivered task or review anchor both as its wake-queue key (`session:<sessionId>`) and as its backend session anchor.

Wakes with different anchors SHALL run concurrently, bounded by the agent's `maxConcurrency`. Wakes with the same anchor SHALL remain serial and coalesced.

A daemon that ignores `sessionId` SHALL keep working with per-Idea lanes.

#### Scenario: Two tasks of one Idea run in parallel for one agent
- **WHEN** agent D is assigned independent tasks T1 and T2 of Idea I and `maxConcurrency` ≥ 2
- **THEN** both wakes start without waiting for each other, in sessions `task:T1` and `task:T2`

#### Scenario: Interrupting one task session leaves its sibling running
- **WHEN** the user interrupts the running turn of session `task:T1`
- **THEN** only T1's subprocess is stopped and `task:T2` keeps running

### Requirement: Execution, interrupt and resume identity is per session

Each `DaemonExecution` row SHALL record the `sessionId` of a task or review lane, and `""` for Idea, ad-hoc and legacy lanes. It SHALL be unique per `(connectionUuid, entityType, entityUuid, sessionId)`.

Interrupt and resume SHALL accept a `sessionId` and act only on that session's execution. Without one, they SHALL keep the legacy entity match restricted to `sessionId = ""`.

#### Scenario: Same-entity sessions run and stop independently
- **WHEN** agent D has `task:T` and `review:task:T` running at the same time on one connection
- **THEN** two distinct execution rows are shown as running
- **AND** interrupting `review:task:T` stops only the review subprocess
- **AND** resuming it re-dispatches into `review:task:T`

### Requirement: Scoped wake prompt for anchored sessions

The wake prompt of a task-scoped session SHALL state that it has no Idea-session memory and direct the agent to read the task, proposal and Idea context. It SHALL also instruct the agent to work in its own git worktree before editing files when sibling task sessions may share the working directory.

The wake prompt of a review-scoped session SHALL state that it carries no development memory and that the reviewer stays read-only.

#### Scenario: Task prompt carries worktree guidance
- **WHEN** a wake runs in session `task:T`
- **THEN** its prompt contains the task-scope header with the worktree instruction

### Requirement: Anchored sessions are grouped under their Idea in the chat UI

The daemon chat SHALL show task and review sessions as child conversations under their Idea, labelled with localized "Task: <title>" or "Review: <title>" (en and zh).

Each child conversation SHALL have its own transcript, running state, interrupt, resume and takeover command, derived from that session's own backend id.

Existing Idea sessions SHALL keep their identity and remain resumable.

#### Scenario: Idea shows development and review child sessions
- **WHEN** agent D has sessions `<I>`, `task:T` and `review:task:T`
- **THEN** the chat lists the Idea conversation with two labelled child conversations
- **AND** each child conversation's takeover command resumes that session's own backend id
