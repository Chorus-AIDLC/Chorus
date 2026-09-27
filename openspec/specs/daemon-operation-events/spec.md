# daemon-operation-events Specification

## Purpose

Define how daemon-driven Idea creation and bounded Research are persisted,
delivered, executed and displayed as explicit operations, while preserving legacy
client compatibility and manual access to conversation history.

## Requirements

### Requirement: Operation requests SHALL persist explicit versioned semantics
The server SHALL persist `idea_creation_requested` and `research_requested` turns with a validated version-1 operationPayload and a server-composed compatibility prompt snapshot. Creation payload SHALL carry kind, ideaUuid, projectUuid, mode, researchFirst and descriptionText; Research SHALL carry kind and ideaUuid. Identity SHALL agree with the authorized session and Idea. The server SHALL preserve transactionality, attribution, origin and cwd boundaries.

#### Scenario: Both creation modes
- **WHEN** an authorized user dispatches elaborate or decompose with researchFirst true, false or omitted
- **THEN** exactly one Idea, its root session and one idea_creation_requested turn are committed atomically
- **AND** the versioned payload preserves the selected mode and full validated description

#### Scenario: Explicit Research repetitions
- **WHEN** an eligible Idea receives two completed Research submissions
- **THEN** two distinct research_requested turns persist on the existing root session with distinct UUIDs and ordered sequences
- **AND** neither request creates or claims another Idea or changes elaboration

#### Scenario: Identity mismatch or transaction failure
- **WHEN** payload identity disagrees with the authorized session, or any transaction write fails
- **THEN** dispatch is rejected with no partial operation persisted

### Requirement: Delivery SHALL preserve one canonical turn across client generations
The pending-turn HTTP boundary SHALL expose canonical trigger and payload to operationProtocol=1 clients and project new operation turns to human_instruction with the saved compatibility prompt for other clients. Projection SHALL preserve turn UUID, sequence, session and origin and SHALL NOT create or mutate a turn. Live deliver_turn and reconnect SHALL share this read contract; notification broadcasts SHALL NOT execute these operations independently.

#### Scenario: Live delivery followed by reconnect
- **WHEN** the same turn is delivered through its origin ping and reconnect backfill
- **THEN** one queue item is admitted by the client for that turn UUID and running admission prevents a second launch

#### Scenario: Legacy projection
- **WHEN** a client without operationProtocol=1 reads a new operation
- **THEN** it receives the same UUID as a human_instruction with an executable compatibility prompt
- **AND** no duplicate compatibility turn or new session is created

#### Scenario: Wrong origin
- **WHEN** another connection attempts to fetch or advance the operation
- **THEN** existing company, agent and session-origin fences reject the request

#### Scenario: Unsupported payload
- **WHEN** a canonical operation has a missing, unsupported or inconsistent payload
- **THEN** the new CLI shows a protocol error and does not spawn a subprocess or mark the turn completed
- **AND** the turn remains pending and is not permanently deduplicated away

### Requirement: New clients SHALL route and acknowledge operations explicitly
The upgraded CLI SHALL route by canonical operation semantics, invoke Idea or decomposition for creation and the bounded research-only workflow for Research, and isolate each operation on the existing serial session queue. It SHALL await exact-turn running admission before spawn and correlate terminal reports to that turn. Ordinary FIFO/coalesced settlement in operationProtocol=1 mode SHALL exclude both dedicated triggers.

#### Scenario: Research among ordinary messages
- **WHEN** Research is queued between mentions or ordinary instructions
- **THEN** it executes as a separate turn and ends after the bounded investigation without resuming development
- **AND** ordinary batches do not consume its pending record

#### Scenario: Creation routing
- **WHEN** a creation operation reaches the new CLI
- **THEN** mode determines Idea elaboration versus theme decomposition and researchFirst retains its existing optional-research semantics
- **AND** the pre-created Idea is not created or claimed again

#### Scenario: Spawn is denied or fails
- **WHEN** running admission fails or the cwd/configuration prevents launching
- **THEN** no subprocess is launched after failed admission and launch-abort reporting uses only the authorized exact-turn transition

#### Scenario: New client against older server
- **WHEN** a server ignores operationProtocol=1 and returns historical human_instruction shapes
- **THEN** the new CLI retains the existing ordinary and Research-prefix compatibility routes

#### Scenario: Terminal retry
- **WHEN** a terminal acknowledgement is retried with the same turn and backend identity
- **THEN** it is idempotent and does not duplicate usage or transcript side effects

### Requirement: Canonical Research SHALL preserve eligibility and compatibility fences
Research classification SHALL use the canonical trigger for new records and the historical human_instruction prefix only for legacy records. Eligibility, pending-read retirement, launch checks, FIFO exclusion and coalesced settlement SHALL use a consistent classifier. researchProtocol=1-only clients SHALL retain isolated Research execution; clients declaring neither protocol SHALL retain origin-scoped ordinary FIFO and merged acknowledgement.

#### Scenario: Stage changes after queueing
- **WHEN** development begins on the Idea or a relevant descendant before pending Research launches
- **THEN** the Research turn is retired through the existing stage-changed interruption and never spawned or replayed

#### Scenario: Canonical Research without identifying text
- **WHEN** a research_requested turn has prompt text without the historical prefix
- **THEN** Research eligibility and exact-turn restrictions still apply

#### Scenario: Legacy acknowledgement
- **WHEN** an origin legacy client executes projected operations as an ordinary coalesced batch
- **THEN** the corresponding canonical rows are acknowledged with existing FIFO/merged semantics and no longer appear in pending reads
- **AND** the server does not promise isolated or pre-spawn execution guarantees for that legacy client

### Requirement: Operation history SHALL remain visible without automatic chat opening
The UI SHALL display localized operation names and existing execution states for canonical turns, preserve manual access to session history and transcript, and SHALL NOT auto-open or focus chat after creation or Research submission. Diagnostic protocol fields SHALL NOT replace user-facing operation labels.

#### Scenario: Manual access after submission
- **WHEN** the user submits an operation and later opens its conversation manually
- **THEN** its existing history and actual turn status are available with the correct operation label
- **AND** no stale automatic session-focus target is replayed

#### Scenario: Already open conversation
- **WHEN** the user submits Research while another conversation is manually open
- **THEN** submission does not close or switch that conversation
