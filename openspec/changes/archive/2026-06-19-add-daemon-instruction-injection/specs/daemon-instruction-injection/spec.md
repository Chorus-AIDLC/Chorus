# daemon-instruction-injection Specification

## ADDED Requirements

### Requirement: The server SHALL expose an owner-scoped endpoint to send a free-text instruction to an existing daemon session

The server SHALL expose `POST /api/daemon-sessions/{sessionUuid}/instruction` that accepts a free-text `instructionText` and creates exactly one `human_instruction` turn on the addressed `DaemonSession`. The endpoint SHALL be visibility-scoped identically to the daemon-session reads (a user caller may only address sessions of agents the user owns; an agent-key caller only its own; every query `companyUuid`-scoped) and SHALL return a not-found that does not disclose existence when the session is not visible. It SHALL NOT introduce a new permission bit. The created turn's `promptText` SHALL be the submitted text (canonical), and the turn SHALL be created through the existing notification chokepoint so human and autonomous wakes remain symmetric.

#### Scenario: A visible session accepts an instruction and creates a pending turn

- **GIVEN** a caller who can see session S (owns its agent), and S's origin connection is online
- **WHEN** the caller POSTs a non-empty `instructionText` to S's instruction endpoint
- **THEN** exactly one new `DaemonSessionTurn` MUST be created on S with `trigger = "human_instruction"`, `status = "pending"`, and `promptText` equal to the submitted text
- **AND** the response MUST be the standard success envelope carrying the created turn

#### Scenario: Sending to a session the caller cannot see is refused without disclosure

- **GIVEN** session S belongs to an agent owned by a different user
- **WHEN** that caller POSTs an instruction to S
- **THEN** the server MUST NOT create a turn
- **AND** the response MUST be a not-found that does not confirm S exists

#### Scenario: An instruction reuses the existing session rather than creating a second one

- **GIVEN** session S already exists with N turns
- **WHEN** an instruction is sent to S
- **THEN** the turn MUST be appended to S (the session row is reused, its `seq` increments) and no second `DaemonSession` row MUST be created for the same `(agentUuid, sessionId)`

### Requirement: Sending SHALL be blocked when the session's origin connection is offline

Because a daemon session is continuable only on its `originConnectionUuid` (the connection whose cwd holds the on-disk transcript that `claude --resume` requires), the send endpoint SHALL re-check the origin connection's online status at send time and SHALL refuse the send when the origin is offline, leaving the session read-only. The refusal SHALL be distinguishable by the client (a dedicated read-only / conflict response) from a not-found, and the session's existing history SHALL remain readable. The instruction SHALL NOT be routed to a different connection of the same agent.

#### Scenario: An offline origin makes the send read-only

- **GIVEN** session S whose origin connection is offline, while the same agent has another online connection D
- **WHEN** a caller attempts to send an instruction to S
- **THEN** the send MUST be refused with a read-only/conflict response (not a success, not a not-found)
- **AND** no turn MUST be created
- **AND** the instruction MUST NOT be routed to connection D

### Requirement: The server SHALL validate instruction text length and emptiness

The send endpoints SHALL reject an `instructionText` that is empty (or whitespace-only after trimming) and one that exceeds a single configured maximum character count, with a bad-request response, before any turn is created. The maximum SHALL be a single named server-side constant.

#### Scenario: An empty instruction is rejected

- **WHEN** a caller sends an `instructionText` that is empty or only whitespace
- **THEN** the server MUST respond with a bad-request and MUST NOT create a turn

#### Scenario: An over-length instruction is rejected

- **GIVEN** the configured maximum instruction length
- **WHEN** a caller sends an `instructionText` exceeding it
- **THEN** the server MUST respond with a bad-request and MUST NOT create a turn

### Requirement: The server SHALL support creating an ad-hoc session and sending its first instruction in one call

The server SHALL expose an endpoint that, for an agent the caller owns, creates a new ad-hoc `DaemonSession` (`directIdeaUuid = null`) pinned to a caller-chosen online connection of that agent, with a **server-generated** `sessionId`, and creates the first `human_instruction` turn on it. The server SHALL be the sole generator of the ad-hoc `sessionId` (single source of truth). The chosen connection SHALL be verified to belong to the agent and to be online; otherwise the call SHALL be refused (not-found for a connection the caller cannot see, read-only/conflict for an offline one). The ad-hoc session's working directory SHALL be the chosen connection's startup directory (no cwd selection is offered).

#### Scenario: Ad-hoc create-and-send pins the session to the chosen connection

- **GIVEN** a caller who owns agent A, and A has an online connection C
- **WHEN** the caller creates an ad-hoc session on C with a non-empty instruction
- **THEN** a new `DaemonSession` MUST be created with `directIdeaUuid = null`, a server-generated `sessionId`, and `originConnectionUuid = C`
- **AND** a `human_instruction` turn MUST be created on it with the submitted text

#### Scenario: Ad-hoc creation refuses an offline or unowned connection

- **GIVEN** a caller who owns agent A
- **WHEN** the caller targets a connection that is offline, or one that does not belong to A
- **THEN** the server MUST refuse (read-only/conflict for offline; not-found without disclosure for an unowned/absent connection) and MUST NOT create a session or a turn

### Requirement: A human-instruction turn SHALL be delivered live only to the session's origin connection

When an instruction turn is created, the server SHALL deliver the live wake to the session's `originConnectionUuid` and to no other connection of the same agent, so a non-origin daemon (which lacks the cwd-bound on-disk transcript) never spawns a divergent session for the same `sessionId`. Delivery SHALL use the existing per-connection control channel rather than the agent-wide notification fan-out, and SHALL NOT require adding a connection-targeting column to the `Notification` model. The live delivery SHALL carry no instruction text on the wire — the daemon SHALL obtain the text from the persisted turn (via the connection-scoped pending-turns read), so the persisted turn remains the single source of truth.

#### Scenario: Only the origin daemon is woken for an instruction

- **GIVEN** agent A has two online connections, C (the session's origin) and D
- **WHEN** an instruction turn is created for that session
- **THEN** the live delivery MUST target connection C only
- **AND** connection D MUST NOT be woken for that instruction

#### Scenario: The daemon resolves the instruction text from the turn, not the wire

- **WHEN** the origin daemon receives the live delivery for an instruction turn
- **THEN** the delivery payload MUST NOT contain the instruction text
- **AND** the delivery payload MUST target the connection only (it MUST NOT require an entity identifier, since the daemon's pending-turns sweep is connection-scoped)
- **AND** the daemon MUST obtain the text from the persisted turn via the connection-scoped pending-turns read

### Requirement: A lost live delivery SHALL NOT lose the instruction

Because the live delivery is fire-and-forget and the origin daemon may be briefly disconnected, the persisted turn SHALL be the durable record from which a missed instruction is recovered. On reconnect, the daemon's existing pending-turns backfill SHALL re-derive the unstarted `human_instruction` turn from the turn table and run it. Live delivery and backfill SHALL be idempotent so a turn handled by one path is not re-run by the other.

#### Scenario: A reconnecting daemon recovers an instruction it missed

- **GIVEN** an instruction turn was created while the origin daemon was momentarily disconnected, so the live delivery was not received
- **WHEN** the daemon reconnects and runs its pending-turns backfill
- **THEN** the unstarted instruction turn MUST be re-derived from the turn table and executed

#### Scenario: Live delivery and backfill do not double-run a turn

- **GIVEN** an instruction turn delivered live and also present in a reconnect backfill sweep
- **WHEN** both paths observe the same turn
- **THEN** the turn MUST be executed at most once (the second observation is a no-op)

### Requirement: The server SHALL expose an owner-scoped list of daemon sessions for instruction targeting

The server SHALL expose `GET /api/daemon-sessions` returning the sessions visible to the caller (owner-scoped, company-fenced — identical to the daemon-connection visibility rules), each carrying enough metadata to drive the send UI: at least its session identifier, `directIdeaUuid` (null for ad-hoc), `originConnectionUuid`, `status`, last-activity time, and a derived indicator of whether its origin connection is currently online. It SHALL NOT introduce a new permission bit and SHALL NOT return turn or transcript bodies (those belong to the separate transcript-viewing capability).

#### Scenario: A user sees only their own agents' sessions for targeting

- **GIVEN** user U owns agent A and user V owns agent B in the same company, each with a daemon session
- **WHEN** user U lists daemon sessions
- **THEN** the result MUST include A's session with its origin-online indicator
- **AND** it MUST NOT include B's session

#### Scenario: The list marks whether each session can currently receive an instruction

- **GIVEN** session S1 whose origin is online and session S2 whose origin is offline, both owned by the caller
- **WHEN** the caller lists daemon sessions
- **THEN** S1 MUST be marked as having an online origin and S2 as having an offline origin

### Requirement: The instruction send UI SHALL let an owner type and send an instruction, gated on origin availability

The frontend SHALL provide, within the existing Agent Connections view, a control for an owner to type a free-text instruction and send it to a selected daemon session, and a path to start an ad-hoc session on a chosen online connection. The send control SHALL be disabled with a visible reason when no online origin exists for the target (the session's origin is offline, or the agent has no online connection). All user-facing strings SHALL be internationalized in both `en` and `zh`. The change SHALL be reflected in `docs/design.pen`.

#### Scenario: Sending is disabled when no online origin is available

- **GIVEN** a selected session whose origin connection is offline
- **WHEN** the send UI renders
- **THEN** the send control MUST be disabled
- **AND** a localized reason MUST be shown

#### Scenario: Send strings are present in both locales

- **WHEN** the send UI is rendered in `en` and in `zh`
- **THEN** every user-facing string MUST resolve from the locale files in both languages with no hardcoded text
