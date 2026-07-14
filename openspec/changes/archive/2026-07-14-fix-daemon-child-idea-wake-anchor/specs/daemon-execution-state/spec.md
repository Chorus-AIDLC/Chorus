## ADDED Requirements

### Requirement: The execution snapshot and row SHALL carry the direct idea alongside the root idea

The daemon SHALL report a `directIdeaUuid` (the entity's directly-attached idea — the server-resolved `directIdeaUuid` the daemon already uses as its Claude session anchor) on every execution-snapshot entry, in addition to the existing `rootIdeaUuid`. The server SHALL accept `directIdeaUuid` at the `POST /api/daemon/execution-state` ingest boundary as an optional, nullable string, SHALL persist it on the `DaemonExecution` model as a nullable column, and SHALL include it in the `ExecutionView` read projection returned by every execution read (per-connection first paint, aggregate read, and the SSE `execution:{connectionUuid}` event). The `directIdeaUuid` column SHALL be added through a Prisma-CLI-generated migration containing only DDL (no `INSERT`/`UPDATE`/`DELETE` backfill). `rootIdeaUuid` SHALL remain reported, persisted, and projected unchanged.

#### Scenario: A child-idea task wake reports both ids distinctly

- **WHEN** the daemon wakes for a `task_assigned` notification whose task belongs to a child idea (the task's direct idea has a `parentUuid`)
- **THEN** the execution-snapshot entry it uploads carries `directIdeaUuid` equal to the child idea's uuid and `rootIdeaUuid` equal to the topmost ancestor idea's uuid, and the persisted row and the `ExecutionView` returned to clients carry both values distinctly.

#### Scenario: A top-level idea reports equal ids

- **WHEN** the daemon wakes for a wake whose entity's direct idea has no parent
- **THEN** the entry's `directIdeaUuid` and `rootIdeaUuid` are the same idea uuid.

#### Scenario: A wake with no idea ancestor reports null ids

- **WHEN** the daemon wakes for an entity that resolves to no idea (e.g. a standalone/quick task)
- **THEN** the entry's `directIdeaUuid` is null and the row/projection tolerate the null.

#### Scenario: An older daemon that omits the field is accepted

- **WHEN** a daemon that has not been updated uploads a snapshot entry without `directIdeaUuid`
- **THEN** the ingest endpoint accepts the entry and persists `directIdeaUuid` as null (the field is optional and nullable), without rejecting the snapshot.

### Requirement: A conversation's running/interruptible execution SHALL be matched by the direct idea, not the root idea

The chat UI SHALL determine whether a daemon execution belongs to an idea-anchored conversation by matching the execution's `directIdeaUuid` against the conversation's `directIdeaUuid` (in addition to matching a direct wake ON the idea, where the execution's `entityType` is `idea` and its `entityUuid` equals the conversation's `directIdeaUuid`). It SHALL NOT match a child-resource execution to a conversation by comparing the execution's `rootIdeaUuid` against the conversation's `directIdeaUuid`. Consequently, when a child idea receives a wake, the child idea's conversation SHALL show the running/interruptible state and the parent idea's conversation SHALL NOT.

#### Scenario: Child idea's conversation shows the run, parent's does not

- **WHEN** a child idea (whose parent is another idea) receives a `task_assigned`, `proposal_approved`, or `proposal_rejected` wake and the daemon is executing it
- **THEN** the child idea's conversation shows the in-progress / interruptible indicator, AND the parent idea's conversation shows no in-progress indicator for that run.

#### Scenario: A direct wake on the idea still matches its own conversation

- **WHEN** a conversation's idea receives a wake whose execution entity is the idea itself (e.g. `elaboration_verified`, reported as `entityType: "idea"`, `entityUuid: <idea>`)
- **THEN** that conversation shows the in-progress / interruptible indicator via the direct-idea match.

#### Scenario: An interrupt targets the child idea's run

- **WHEN** a human interrupts the in-progress run shown on a child idea's conversation
- **THEN** the interrupt targets the execution the child idea's conversation owns, not the parent idea's.
