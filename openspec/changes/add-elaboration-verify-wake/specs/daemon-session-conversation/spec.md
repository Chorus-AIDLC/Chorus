# daemon-session-conversation Specification

## MODIFIED Requirements

### Requirement: Every daemon wake SHALL be recorded as a turn on its DaemonSession

The server SHALL define a Prisma model `DaemonSessionTurn` representing one wake on a conversation. It SHALL carry at least: `uuid`, `sessionUuid` (referencing `DaemonSession.uuid`), `seq` (monotonic per session), `trigger` (one of `task_assigned`, `mentioned`, `elaboration`, `elaboration_verified`, `resume`, `human_instruction`), `promptText` (nullable — the free-text instruction body for a `human_instruction` turn, null for autonomous triggers), `status` (`pending` | `running` | `ended`), `startedAt` (nullable), `endedAt` (nullable), and `createdAt`. Every wake-triggering event — whether an autonomous dispatch (task assignment, @mention, elaboration request, elaboration verified, resume) or a human-typed instruction — SHALL produce exactly one turn on the corresponding `DaemonSession`, distinguished only by `trigger`. A turn SHALL reference the live execution it corresponds to (so the conversation turn and the `DaemonExecution` row are linked) without altering `DaemonExecution` reconcile semantics. The `trigger` field is a free-form string column; extending the enumeration SHALL NOT require a data-mutating migration.

#### Scenario: An autonomous task dispatch records a turn

- **GIVEN** a task is assigned to a daemon agent, producing a wake on session I
- **WHEN** the server records the wake
- **THEN** a `DaemonSessionTurn` MUST be created on session I with `trigger = "task_assigned"`

#### Scenario: A human instruction records a turn carrying its text

- **GIVEN** a human submits a free-text instruction to session I
- **WHEN** the server records it
- **THEN** a `DaemonSessionTurn` MUST be created on session I with `trigger = "human_instruction"` and `promptText` set to the submitted text

#### Scenario: An elaboration-verified wake records a turn

- **GIVEN** a human verifies the elaboration of an idea-anchored session I
- **WHEN** the server records the wake
- **THEN** a `DaemonSessionTurn` MUST be created on session I with `trigger = "elaboration_verified"`

#### Scenario: Turn trigger distinguishes wake kinds on one conversation

- **GIVEN** session I has received a task assignment, an @mention, and a human instruction
- **WHEN** the session's turns are listed
- **THEN** all three MUST appear as turns on the same `DaemonSession`, distinguished by their `trigger` values

#### Scenario: A turn links to its execution without changing execution semantics

- **WHEN** a turn begins running and a `DaemonExecution` row reflects the running entity
- **THEN** the turn MUST reference that execution
- **AND** the `DaemonExecution` snapshot-reconcile behavior MUST be unchanged by the turn linkage
