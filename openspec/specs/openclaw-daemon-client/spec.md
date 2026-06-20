# openclaw-daemon-client Specification

## Purpose
TBD - created by archiving change align-openclaw-daemon-parity. Update Purpose after archive.
## Requirements
### Requirement: The OpenClaw host SHALL report turn lifecycle and execution state for every wake it runs

When the OpenClaw plugin runs a wake via `runEmbeddedAgent`, it SHALL report the turn lifecycle and execution state to the server through the shared daemon REST client, using its captured `connectionUuid`. It SHALL advance the turn to `running` when the run starts and to `ended` when the run completes, and it SHALL publish an execution-state snapshot reflecting the running (and any queued) entities for its connection, so the server's execution-state layer reconciles the OpenClaw connection identically to a chorus CLI connection. The session identifier used in these reports SHALL be the DaemonSession business key (`directIdeaUuid` when present, else the wake's `entityUuid`).

#### Scenario: A wake reports running then ended

- **GIVEN** the OpenClaw plugin has captured its `connectionUuid` and receives a wake for an entity
- **WHEN** the embedded agent run starts
- **THEN** the plugin MUST report a turn advance to `running` for that session
- **AND** when the run completes, it MUST report a turn advance to `ended`

#### Scenario: A running wake appears in the execution snapshot

- **GIVEN** a wake currently running on the OpenClaw connection
- **WHEN** the plugin publishes its execution-state snapshot
- **THEN** the snapshot MUST include the running entity with its `rootIdeaUuid` (or null) and `startedAt`
- **AND** the server MUST reconcile it so the connection's running task is visible in the Agent Connections surfaces

#### Scenario: The session id is the business key

- **WHEN** the plugin reports turn lifecycle or transcript for a wake
- **THEN** the reported `sessionId` MUST be the wake's `directIdeaUuid` when it has an idea ancestor, otherwise the wake's `entityUuid`

### Requirement: The OpenClaw host SHALL stream the conversation transcript from in-process run callbacks

The OpenClaw plugin SHALL observe the embedded agent's messages via `runEmbeddedAgent`'s per-message callbacks (assistant message and block callbacks) and SHALL post them to the transcript endpoint through the shared client as `{ role, text }` messages, so the conversation is readable in the UI as it progresses. It SHALL post only finalized user/assistant visible text — it SHALL NOT post thinking/reasoning internals or tool-call internals as transcript messages — matching the content filter the chorus CLI host applies to its stream-json source.

#### Scenario: Assistant output is posted as transcript

- **GIVEN** a running embedded agent that produces assistant output
- **WHEN** the plugin's per-message callback fires with finalized assistant text
- **THEN** the plugin MUST post a transcript message with `role = "assistant"` and that text for the wake's session

#### Scenario: Internals are not posted as transcript

- **WHEN** the embedded agent emits reasoning/thinking or tool-call internal events
- **THEN** the plugin MUST NOT post those as transcript messages
- **AND** only finalized user/assistant visible text MUST appear in the transcript

### Requirement: The OpenClaw host SHALL support real mid-run interrupt via AbortController

The OpenClaw plugin SHALL maintain an `AbortController` per in-flight run, keyed by `entityType:entityUuid`, and SHALL pass its `abortSignal` into `runEmbeddedAgent`. On an authorized `interrupt` control command verified for its own connection and a held entity, the plugin SHALL abort the matching run — a true mid-run stop — and SHALL report the interrupt with `reason = "user"`. When a run ends unexpectedly (the run promise rejects without an interrupt request), the plugin SHALL report `reason = "crash"`. The controller SHALL be deregistered when the run settles so a stale controller cannot abort a later run.

#### Scenario: An authorized interrupt aborts the running embedded agent

- **GIVEN** the OpenClaw plugin is running a wake for entity E with a registered `AbortController`
- **WHEN** it receives a verified `interrupt` control command for its connection and entity E
- **THEN** it MUST call `abort()` on E's controller so the in-flight run is cancelled
- **AND** it MUST report the interrupt with `reason = "user"`

#### Scenario: An unexpected run failure reports a crash

- **GIVEN** a running wake whose `runEmbeddedAgent` promise rejects with no interrupt requested
- **WHEN** the plugin observes the rejection
- **THEN** it MUST report the interrupt with `reason = "crash"`

#### Scenario: A settled run deregisters its controller

- **WHEN** a run completes, aborts, or rejects
- **THEN** its `AbortController` MUST be removed from the in-flight registry
- **AND** a subsequent interrupt for the same entity with no active run MUST be ignored (no run to abort)

### Requirement: The OpenClaw host SHALL map a session to a stable key so resume and deliver_turn continue the same conversation

The OpenClaw plugin SHALL derive the embedded-agent `sessionKey` deterministically from the DaemonSession business key (`directIdeaUuid` when present, else `entityUuid`) and SHALL resolve the existing session entry via the runtime session helper, so a `resume` re-dispatch or a `deliver_turn` instruction continues the **same** OpenClaw session (same `sessionId`/`sessionFile`) rather than starting a divergent one. This is the in-process analog of the chorus CLI host's `claude --resume <directIdeaUuid>`.

#### Scenario: A resume continues the same session

- **GIVEN** a session that previously ran for entity E and has an existing session entry
- **WHEN** the plugin receives a `resume` control command for E and re-dispatches the wake
- **THEN** it MUST resolve the same `sessionKey` derived from E's business key and continue the existing session entry rather than allocating a new `sessionId`

#### Scenario: A delivered instruction continues the same session

- **WHEN** the plugin runs a `human_instruction` turn obtained from the pending-turns read for an existing session
- **THEN** it MUST run it under the same derived `sessionKey` so the instruction lands in the same conversation

### Requirement: The OpenClaw host SHALL recover instructions via a connection-scoped pending-turns sweep

The OpenClaw plugin SHALL read connection-scoped pending turns from the shared client on reconnect and on a `deliver_turn` control ping, and SHALL run any unstarted `human_instruction` turn. Live `deliver_turn` delivery and reconnect backfill SHALL be idempotent — a turn run by one path SHALL NOT be re-run by the other — using a seen-set keyed by turn uuid, matching the chorus CLI host's at-most-once guarantee.

#### Scenario: A deliver_turn ping runs the targeted pending turn

- **GIVEN** the plugin receives a verified `deliver_turn` control command carrying a `turnUuid` for its connection
- **WHEN** it handles the command
- **THEN** it MUST read connection-scoped pending turns, select the one matching `turnUuid`, and run it
- **AND** it MUST NOT enqueue or run any other pending turn for that ping when a `turnUuid` is specified

#### Scenario: A reconnecting plugin recovers a missed instruction

- **GIVEN** an unstarted `human_instruction` turn created while the plugin was briefly disconnected
- **WHEN** the plugin reconnects and runs its pending-turns backfill
- **THEN** it MUST re-derive that turn from the pending-turns read and run it

#### Scenario: Live delivery and backfill do not double-run a turn

- **GIVEN** the same instruction turn observed by both the live `deliver_turn` path and a reconnect backfill sweep
- **WHEN** both paths see it
- **THEN** the turn MUST be run at most once (the later observation is a no-op via the shared seen-set keyed by turn uuid)

