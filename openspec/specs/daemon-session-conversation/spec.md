# daemon-session-conversation Specification

## Purpose
TBD - created by archiving change daemon-session-conversation. Update Purpose after archive.
## Requirements
### Requirement: The server SHALL persist a daemon Claude conversation as a DaemonSession keyed per agent and session id

The server SHALL define a Prisma model `DaemonSession` representing one persistent daemon Claude conversation. It SHALL be uniquely keyed by `(agentUuid, sessionId)`, where `sessionId` is the conversation's stable business key — the `directIdeaUuid` for an idea-anchored session, or a server-generated uuid for an ad-hoc session. The model SHALL carry at least: `uuid` (public id), `companyUuid`, `agentUuid`, `sessionId`, `directIdeaUuid` (nullable — null marks an ad-hoc session with no idea lineage), `originConnectionUuid` (the `DaemonConnection.uuid` that owns the on-disk transcript, fixed at creation), `status` (`active` | `ended`), `title`, `createdAt`, `updatedAt`, and `lastTurnAt`. Its identity and history SHALL survive the holding connection going offline and the daemon restarting — a `DaemonSession` SHALL NOT be deleted or invalidated merely because its connection dropped. The model SHALL be created through a Prisma-CLI-generated migration containing only DDL (no data backfill), and its `agent` relation SHALL cascade-delete with its agent, matching existing model conventions.

#### Scenario: A conversation is keyed per agent and session id

- **GIVEN** a daemon agent A begins a Claude session whose session id is a direct idea uuid I
- **WHEN** the server records the conversation
- **THEN** a `DaemonSession` row MUST exist for `(agentUuid = A, sessionId = I)` with `directIdeaUuid = I`

#### Scenario: A second wake on the same session reuses the same conversation row

- **GIVEN** a `DaemonSession` already exists for `(agent A, session I)`
- **WHEN** a later wake for the same `(A, I)` occurs
- **THEN** the existing `DaemonSession` row MUST be reused rather than a second row created for `(A, I)`

#### Scenario: Conversation history survives the connection going offline

- **GIVEN** a `DaemonSession` whose `originConnectionUuid` connection has gone offline
- **WHEN** the session is queried afterward
- **THEN** the `DaemonSession` and its turns MUST still exist and be readable

#### Scenario: The migration is DDL-only

- **WHEN** the change is implemented
- **THEN** the generated migration MUST contain only schema DDL
- **AND** it MUST NOT contain data backfill statements

### Requirement: Every daemon wake SHALL be recorded as a turn on its DaemonSession

The server SHALL define a Prisma model `DaemonSessionTurn` representing one wake on a conversation. It SHALL carry at least: `uuid`, `sessionUuid` (referencing `DaemonSession.uuid`), `seq` (monotonic per session), `trigger` (one of `task_assigned`, `mentioned`, `elaboration`, `elaboration_verified`, `start_development`, `resume`, `human_instruction`), `promptText` (nullable — the free-text instruction body for a `human_instruction` turn, null for autonomous triggers), `status` (`pending` | `running` | `ended` | `interrupted`), `interruptedReason` (nullable — `user` | `crash` | `shutdown` | `offline`, set if and only if `status = "interrupted"`), `startedAt` (nullable), `endedAt` (nullable), and `createdAt`. Every wake-triggering event — whether an autonomous dispatch (task assignment, @mention, elaboration request, elaboration verified, start development, resume) or a human-typed instruction — SHALL produce exactly one turn on the corresponding `DaemonSession`, distinguished only by `trigger`. A turn SHALL reference the live execution it corresponds to (so the conversation turn and the `DaemonExecution` row are linked) without altering `DaemonExecution` reconcile semantics. The `trigger` field is a free-form string column; extending the enumeration SHALL NOT require a data-mutating migration.

The turn status state machine SHALL be: `pending → running`, `running → ended`, `running → interrupted`; `ended` and `interrupted` are terminal. Skips (including `pending → interrupted` — a pending turn is recoverable via backfill and stays pending), backward moves, and same-status re-application SHALL be rejected as invalid transitions that write nothing. The `interrupted` transition SHALL record `endedAt` (an interrupted turn has a definite end time) and persist the supplied `interruptedReason`. An interrupted turn SHALL NOT be automatically re-dispatched or reverted to `pending` — resending is a human decision.

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

#### Scenario: A start-development wake records a turn

- **GIVEN** a human clicks Start Development for an idea anchored to session I
- **WHEN** the server records the wake
- **THEN** a `DaemonSessionTurn` MUST be created on session I with `trigger = "start_development"`

#### Scenario: Turn trigger distinguishes wake kinds on one conversation

- **GIVEN** session I has received a task assignment, an @mention, and a human instruction
- **WHEN** the session's turns are listed
- **THEN** all three MUST appear as turns on the same `DaemonSession`, distinguished by their `trigger` values

#### Scenario: A turn links to its execution without changing execution semantics

- **WHEN** a turn begins running and a `DaemonExecution` row reflects the running entity
- **THEN** the turn MUST reference that execution
- **AND** the `DaemonExecution` snapshot-reconcile behavior MUST be unchanged by the turn linkage

#### Scenario: A running turn can be finalized as interrupted with a reason

- **GIVEN** a turn in status `running`
- **WHEN** it is advanced to `interrupted` with reason `shutdown`
- **THEN** the turn MUST persist `status = "interrupted"`, `interruptedReason = "shutdown"`, and a non-null `endedAt`
- **AND** the `turn_status_changed` SSE trigger MUST be published exactly as for an `ended` transition

#### Scenario: Interrupted and ended are both terminal

- **GIVEN** a turn in status `interrupted` (or `ended`)
- **WHEN** any further status transition is attempted (including a late `running → ended` report from a daemon that reconnected after the server already finalized the turn)
- **THEN** the transition MUST be rejected as invalid, writing nothing
- **AND** the rejection MUST be logged visibly, never crash the reporting side

#### Scenario: A pending turn is never interrupted

- **GIVEN** a turn in status `pending` whose connection goes offline
- **WHEN** orphan reconcile runs
- **THEN** the turn MUST remain `pending` (it stays recoverable via reconnect backfill)

### Requirement: The server SHALL create the turn at the notification chokepoint, symmetric for human and autonomous wakes

The server SHALL create the `DaemonSessionTurn` (with `status = pending`) at the same centralized point where the wake-triggering `Notification` is created (`notification.service` `create` / `createBatch`), so human-typed and autonomous wakes are handled symmetrically by one code path. The turn's owning `DaemonSession` SHALL be resolved or created there, deriving `directIdeaUuid` via the existing lineage resolution (`lineage.service`). The daemon SHALL transition the turn from `pending` to `running` when it begins executing it, and to `ended` when the subprocess completes. Turn creation SHALL NOT block or break notification creation, and a failure to create the turn SHALL be logged visibly rather than silently swallowed.

#### Scenario: A wake notification creates a pending turn

- **GIVEN** a wake-triggering notification is created for a daemon agent
- **WHEN** the notification chokepoint runs
- **THEN** a `DaemonSessionTurn` with `status = "pending"` MUST be created on the resolved `DaemonSession`

#### Scenario: The daemon advances the turn lifecycle

- **GIVEN** a `pending` turn for an entity the daemon is about to run
- **WHEN** the daemon starts the subprocess and later it completes
- **THEN** the turn MUST transition `pending → running` on start and `running → ended` on completion

#### Scenario: Turn creation failure does not break notification creation

- **GIVEN** the notification is created but creating the associated turn fails
- **THEN** the failure MUST be logged visibly
- **AND** it MUST NOT silently succeed nor abort the notification that was already created

### Requirement: A human-instruction wake notification SHALL carry the instruction text so the daemon needs no extra fetch

For a `human_instruction` turn, the wake notification delivered to the daemon agent SHALL carry the free-text instruction body as a write-once denormalized copy, so the daemon obtains it in the same `chorus_get_notifications` call it already performs to read notification detail — adding no extra round-trip. The **canonical** instruction text SHALL be the turn's `promptText`; the notification copy SHALL be display/transport only and SHALL NOT be the source of truth. The notification carrying instruction text SHALL have recipient = the daemon agent (not a human), so it does not appear in a human's notification bell.

#### Scenario: The daemon reads the instruction in its existing notification fetch

- **GIVEN** a `human_instruction` turn with `promptText` set
- **WHEN** the daemon fetches the wake notification detail it normally fetches
- **THEN** the instruction text MUST be present in that response without a separate turn-fetch call

#### Scenario: The turn is the source of truth for instruction text

- **GIVEN** a human-instruction turn and its notification copy of the text
- **WHEN** they are compared
- **THEN** the turn's `promptText` MUST be treated as canonical, and reconnect-backfill MUST re-derive unstarted instructions from turns, not from notifications

#### Scenario: The instruction notification targets the agent, not a human

- **WHEN** the instruction-carrying notification is created
- **THEN** its recipient MUST be the daemon agent
- **AND** it MUST NOT surface in a human recipient's notification list

### Requirement: The server SHALL expose an agent-callable endpoint that ingests per-turn transcript messages

The server SHALL expose `POST /api/daemon/transcript` that accepts, from an authenticated daemon, transcript messages for a specific turn of one of the agent's own sessions. The endpoint SHALL require authentication by an agent API key, SHALL NOT be an MCP tool, and SHALL NOT introduce a new permission bit — the writable set is scoped to the authenticated agent's own sessions. It SHALL use the standard API envelope and SHALL reject a session/turn that does not belong to the authenticated agent within its company without revealing that another agent's session exists. The endpoint SHALL have **append** semantics (it adds messages to a turn), distinct from the snapshot-reconcile semantics of the execution-state ingest. Only `user` and `assistant` text messages SHALL be accepted/stored; tool-call, tool-result, and thinking content SHALL NOT be stored. Stored messages SHALL be retained as a **rolling window** of at most a configured maximum count per session, with older messages trimmed in application code (no data-mutating migration).

#### Scenario: An unauthenticated transcript upload is rejected

- **GIVEN** a request to `POST /api/daemon/transcript` with no valid agent key
- **WHEN** the server handles it
- **THEN** the response status MUST be 401 and no transcript message MUST be stored

#### Scenario: Messages for the agent's own turn are appended

- **GIVEN** an agent key whose agent owns session S with turn T
- **WHEN** the agent posts `user`/`assistant` text messages for `(S, T)`
- **THEN** the response MUST be the standard success envelope
- **AND** the messages MUST be appended to turn T

#### Scenario: A transcript upload for another agent's session is rejected without disclosure

- **GIVEN** session S belongs to a different agent
- **WHEN** an agent key that does not own S posts transcript for S
- **THEN** the server MUST NOT store the messages
- **AND** the response MUST be a not-found that does not confirm S exists

#### Scenario: Non-text message kinds are not stored

- **GIVEN** a transcript upload containing tool-call, tool-result, or thinking entries alongside text
- **WHEN** the server ingests it
- **THEN** only the `user` and `assistant` text MUST be stored
- **AND** the non-text entries MUST NOT be persisted

#### Scenario: Stored transcript is bounded by a rolling window

- **GIVEN** a session whose stored messages already reach the configured maximum
- **WHEN** newer messages are appended
- **THEN** the oldest messages MUST be trimmed so the retained count does not exceed the maximum
- **AND** the trimming MUST be performed in application code, not by a data-mutating migration

### Requirement: Transcript and turn changes SHALL be pushed to subscribed clients over SSE

The server SHALL publish a transcript/turn event on the existing event bus (with the existing Redis fan-out for multi-instance deployments) when a turn is created, when its status changes, or when new transcript messages are appended, so a subscribed client viewing the session re-renders without polling on a fast interval and without a manual reload. This SHALL be additive to the existing notification, presence, and execution event types and SHALL NOT alter them.

#### Scenario: Appended transcript pushes an event

- **GIVEN** a client subscribed to a session's transcript updates
- **WHEN** the daemon appends new messages to a turn of that session
- **THEN** a transcript/turn event MUST be published on the event bus
- **AND** the subscribed client MUST update the displayed turn without a manual reload

#### Scenario: Existing event types are unaffected

- **WHEN** the transcript/turn event type is added
- **THEN** the existing notification, presence, and execution event types MUST continue to function unchanged

### Requirement: A daemon session's continuation SHALL be pinned to its origin connection

A `DaemonSession` SHALL be continuable (a new turn dispatched to it) only on its `originConnectionUuid` — the connection whose machine and working directory hold the on-disk Claude transcript that `claude --resume <sessionId>` requires. When the origin connection is offline, the session SHALL be read-only: its history remains visible, but no new turn SHALL be dispatched to a different connection of the same agent. The server SHALL NOT route a session's turn to any connection other than its origin connection, because a resume against a different working directory or machine would fail to find the transcript.

#### Scenario: A turn is dispatched only to the origin connection

- **GIVEN** a `DaemonSession` whose `originConnectionUuid` is connection C
- **WHEN** a new turn is dispatched for that session
- **THEN** it MUST be delivered to connection C and to no other connection

#### Scenario: An offline origin connection makes the session read-only

- **GIVEN** a `DaemonSession` whose origin connection C is offline, while the same agent has another online connection D
- **WHEN** a human attempts to add a turn to that session
- **THEN** the attempt MUST be refused (the session is read-only) and the turn MUST NOT be routed to D
- **AND** the session's existing history MUST remain readable

### Requirement: Daemon session and turn visibility SHALL be owner-scoped

The server SHALL scope session/turn reads so that a user caller sees only the sessions of agents the user owns (`agent.ownerUuid`), and an agent-key caller sees only its own sessions, every query `companyUuid`-scoped — identical to the daemon-connection and execution-state visibility rules. Sessions of an agent owned by a different user SHALL NOT be returned to other members of the same company, and visibility SHALL NOT cross company boundaries. No new permission bit SHALL be introduced.

#### Scenario: A user sees only their own agents' sessions

- **GIVEN** user U owns agent A and user V owns agent B in the same company, each with a daemon session
- **WHEN** user U reads daemon sessions
- **THEN** the result MUST include agent A's session
- **AND** it MUST NOT include agent B's session

#### Scenario: Session visibility never crosses company boundaries

- **GIVEN** a daemon session belonging to an agent in company C2
- **WHEN** a caller in company C1 reads daemon sessions
- **THEN** the result MUST NOT include that session

### Requirement: The daemon SHALL exclude harness-injected synthetic content from the transcript it syncs

The Claude Code daemon backend SHALL NOT sync harness-injected synthetic conversation
content (for example, the full body of a loaded skill) to Chorus. The daemon's
stream-json transcript extractor SHALL drop any `type:"user"` stream envelope marked as
synthetic by Claude Code (the `isSynthetic: true` field on the live
`claude -p --output-format stream-json` stdout) before any text is extracted from it, so
that such content is never posted to `POST /api/daemon/transcript`. The exclusion SHALL
be a purely structural match on the synthetic marker — it SHALL NOT use a size threshold
or content/text-pattern heuristic — so that genuine human instructions, the agent's own
replies, tool-result summaries the agent authors, and error messages (none of which
carry the synthetic marker) are never dropped. The behavior SHALL be always on with no
configuration knob. This requirement SHALL apply to the Claude Code backend only; the
codex (`codex exec --json` / `item.completed`) backend extraction SHALL be unchanged.

As defense-in-depth, where a retained `text` block still wraps a
`<system-reminder>…</system-reminder>` span, the daemon SHALL strip that span from the
stored text, and SHALL drop the message entirely if no non-reminder text remains. The
extractor SHALL continue to never throw on an unrecognized shape (returning "not a
keepable message" instead).

#### Scenario: A loaded skill body is not synced

- **GIVEN** a Claude Code daemon session whose stream-json stdout contains a
  `type:"user"` envelope with `isSynthetic: true` carrying a `text` block with a skill
  body (e.g. text beginning "Base directory for this skill: …")
- **WHEN** the daemon's transcript extractor processes that envelope
- **THEN** the extractor MUST yield no message for it
- **AND** no skill-body text MUST be posted to `POST /api/daemon/transcript`

#### Scenario: A human instruction is still synced

- **GIVEN** a `type:"user"` envelope with no synthetic marker carrying a `text` block
  with a human wake instruction (e.g. text beginning "[Chorus] …")
- **WHEN** the daemon's transcript extractor processes that envelope
- **THEN** the extractor MUST yield a `user` message with that instruction text
- **AND** that text MUST be eligible to sync to Chorus

#### Scenario: A genuine agent reply that quotes injected text is not dropped

- **GIVEN** a `type:"assistant"` envelope with no synthetic marker whose `text` block
  happens to contain a phrase that also appears in injected content (e.g. the agent
  discusses "Base directory for this skill" in its own words)
- **WHEN** the daemon's transcript extractor processes that envelope
- **THEN** the extractor MUST yield an `assistant` message with the reply text
  (the structural match on the synthetic marker MUST NOT classify a non-synthetic
  message as injected based on its content)

#### Scenario: A wrapped system-reminder is stripped from retained text

- **GIVEN** a retained, non-synthetic `text` block that contains a
  `<system-reminder>…</system-reminder>` span alongside other text
- **WHEN** the daemon's transcript extractor processes it
- **THEN** the stored text MUST have the system-reminder span removed
- **AND** if removing the span leaves no non-whitespace text, the extractor MUST yield
  no message

#### Scenario: The codex backend extraction is unaffected

- **GIVEN** a codex `item.completed` `agent_message` stream item
- **WHEN** the daemon's transcript extractor processes it
- **THEN** the extractor MUST yield the assistant text exactly as it did before this
  change (the synthetic-content exclusion MUST NOT alter the codex dialect path)

### Requirement: The server SHALL finalize a running turn whose origin connection is stale

The server SHALL reconcile orphaned `running` turns — turns whose owning session's `originConnectionUuid` resolves to a connection whose `lastSeenAt` is older than the registry's single staleness threshold — by finalizing them to `interrupted` with `interruptedReason = "offline"`, routing through the same status-transition chokepoint (legality check + SSE emission) as every other transition. Orphan eligibility SHALL be judged by `lastSeenAt` age ONLY — never by the connection's stored `status` alone — because `status` flips to `offline` the instant an SSE stream aborts, and a read landing in a transient abort→reconnect gap would otherwise falsely interrupt a genuinely live turn. Two triggers SHALL exist: (1) an event-driven trigger armed from the daemon SSE stream's abort path that runs after the staleness window elapses and re-verifies age-based staleness before writing (so a transient reconnect, whose heartbeat refreshed `lastSeenAt`, makes it a no-op), and (2) a read-time fallback on the daemon-session read paths that detects and finalizes such turns inline when a session is read, so daemon deaths that never fired an abort (hard kill, server restart losing the timer) and pre-existing dirty rows converge without any data-mutating migration. Both triggers SHALL be idempotent through the state machine (a concurrent daemon report or duplicate reconcile loses the race as a logged invalid transition, harmless). Reconcile failures on fire-and-forget paths SHALL be logged, never thrown into stream teardown.

#### Scenario: Daemon killed hard, turn converges on next read

- **GIVEN** a daemon is killed with SIGKILL while a turn is `running`, so no abort fires and no daemon report will ever arrive
- **WHEN** the session is next read after the connection's `lastSeenAt` has aged past the staleness threshold
- **THEN** the turn MUST be finalized `interrupted` with reason `offline` and the read MUST return it in that state

#### Scenario: Transient SSE reconnect does not interrupt a live turn

- **GIVEN** a daemon's SSE stream aborts while a turn is `running` and the daemon reconnects within the staleness window
- **WHEN** the deferred reconcile armed by the abort runs
- **THEN** it MUST re-verify age-based staleness and write nothing (the turn stays `running`)

#### Scenario: A session read during the abort→reconnect gap does not interrupt a live turn

- **GIVEN** a daemon's SSE stream just aborted (connection `status` = `offline`) but its `lastSeenAt` is younger than the staleness threshold
- **WHEN** the session is read
- **THEN** the read-time fallback MUST NOT finalize the running turn (age-only rule; `status` alone is not evidence of death)

#### Scenario: Legacy dirty rows converge without migration DML

- **GIVEN** turns left permanently `running` by daemon exits that predate this change
- **WHEN** their sessions are read
- **THEN** the read-time fallback MUST finalize them `interrupted(offline)`
- **AND** no data-mutating migration is required for this convergence

#### Scenario: Reconcile loses the race to the daemon's own report

- **GIVEN** the daemon reports `running → ended` at the same moment the server reconcile attempts `running → interrupted`
- **WHEN** both writes reach the transition chokepoint
- **THEN** exactly one MUST win and the loser MUST be rejected as an invalid transition that writes nothing

### Requirement: Daemon flushes a turn's transcript before marking it terminal

The daemon SHALL flush any buffered (debounced) transcript for a wake's session to the
server BEFORE it advances that turn to a terminal status (`ended` or `interrupted`), so a
turn's trailing user/assistant text is persisted while the turn is still `running` and
attaches to the correct turn. The transcript upload hooks SHALL expose an `onSessionEnd`
operation that cancels the pending debounce timer and awaits the in-flight and buffered
batch. The flush SHALL be best-effort and non-throwing: a flush failure is logged and
never crashes or blocks the wake's exit path.

#### Scenario: Trailing transcript is flushed on clean subprocess exit

- **WHEN** a woken `claude` subprocess emits an assistant text message and then exits
  cleanly (code 0) within the transcript debounce window
- **THEN** the daemon flushes the buffered transcript to `POST /api/daemon/transcript`
  before it advances the turn to `ended`
- **AND** the turn shows the assistant's reply rather than "no conversation record".

#### Scenario: Active-session transcript is flushed on daemon shutdown

- **WHEN** the daemon is shutting down and a wake subprocess is interrupted mid-turn
- **THEN** the wake's exit path flushes the session's buffered transcript before advancing
  the turn to `interrupted`, within the bounded shutdown drain window.

### Requirement: Daemon retries a failed transcript upload before dropping it

The daemon's transcript upload SHALL retry a failed POST (transient network error or
non-2xx response) with a bounded number of attempts and backoff before giving up. If all
attempts fail, the daemon SHALL drop the batch with a single loud warning that names the
number of lost messages. The retry SHALL live in the transcript upload hook, not in the
shared single-shot REST client.

#### Scenario: Transient upload failure is retried and succeeds

- **WHEN** the first transcript POST for a turn returns a transient error (e.g. HTTP 502)
  and a subsequent attempt would succeed
- **THEN** the daemon retries within the attempt budget and the transcript is persisted
- **AND** no transcript is lost.

#### Scenario: Persistent upload failure is dropped loudly, not silently

- **WHEN** every attempt in the retry budget fails
- **THEN** the daemon logs a warning naming the dropped message count
- **AND** does not crash the wake.

### Requirement: Duplicate unconsumed human instructions collapse to one turn

The server SHALL NOT create a duplicate `human_instruction` turn when the same session
already has an unconsumed (`status = "pending"`) `human_instruction` turn with identical
instruction text; it SHALL instead return the existing turn and re-issue its delivery
ping. The collapse SHALL apply ONLY to the same session, a `pending` turn (never a
`running` or terminal turn), the `human_instruction` trigger, and an exact text match — so
distinct instructions, and re-sends after the prior turn has started, still create new
turns.

#### Scenario: Retrying the same instruction does not pile up empty turns

- **WHEN** a user sends an instruction, sees no visible response, and sends the identical
  instruction text again while the first turn is still `pending`
- **THEN** the server returns the existing pending turn rather than creating a second one
- **AND** the conversation does not accumulate duplicate empty turns 2 / 3 / 4.

#### Scenario: A different instruction still creates a new turn

- **WHEN** a user sends an instruction whose text differs from any pending instruction on
  the session, or whose prior identical turn has already advanced to `running`
- **THEN** the server creates a new `human_instruction` turn.

### Requirement: A successful instruction send clears the composer

The daemon-session reply UI SHALL clear the compose input as the success signal when an
instruction send is accepted by the server (HTTP 2xx). It SHALL NOT show a success toast
(that was tried and read as noise); blind re-sends are made harmless server-side by the
idempotent-collapse requirement rather than discouraged by a toast. Send failures SHALL
continue to surface their server-provided reason.

#### Scenario: A successful send clears the composer without a toast

- **WHEN** the user sends an instruction and the server responds 2xx
- **THEN** the compose input is cleared
- **AND** no success toast is shown.

### Requirement: An empty terminal instruction turn reads honestly

The UI SHALL present a `human_instruction` turn that has reached a terminal status
(`ended` or `interrupted`) and produced no visible messages as a comprehensible "turn
ended without a reply" state — rather than a neutral dead-end "this turn kept no
conversation record". The user re-asks through the normal reply box; the band itself
carries no retry control. Autonomous turns (non-`human_instruction`) SHALL keep the
existing neutral no-messages placeholder. All new user-facing strings SHALL be localized
in every supported locale (en, zh, ko, ja).

#### Scenario: Empty ended human-instruction turn reads honestly

- **WHEN** a `human_instruction` turn is terminal and has no visible messages
- **THEN** the turn band shows a "turn ended without a reply" message (no retry button).

#### Scenario: Empty autonomous turn keeps the neutral placeholder

- **WHEN** an autonomous (non-`human_instruction`) turn has no visible messages
- **THEN** the turn band shows the existing neutral no-messages placeholder.

### Requirement: A known transcript-relay failure is surfaced on the turn

The system SHALL record and surface a KNOWN transcript-relay failure on the turn it
belongs to, so a turn whose reply was produced but never uploaded reads as "the reply
could not be uploaded" rather than the misleading "no reply received". When the daemon's
transcript upload finally fails for a turn (retry budget exhausted / non-2xx / network),
the daemon SHALL forward the failure reason on the same exit-path turn-advance report it
already sends, on the terminal edge. The server SHALL persist this reason as an annotation
on the turn WITHOUT changing the turn's terminal status (a clean exit stays `ended`), and
SHALL expose it in the turn view. The annotation SHALL be written only on a terminal edge
(never on `running`), and SHALL be absent when the upload succeeded. The UI SHALL, for a
terminal turn that carries a relay-failure annotation and shows no messages, present a
distinct honest message with the raw failure reason shown DIRECTLY (inline, not behind a
hover); a turn that DID relay text SHALL render its messages normally. All new user-facing
strings SHALL be localized in every supported locale (en, zh, ko, ja).

#### Scenario: A relay-failed reply is reported honestly, not as "no reply"

- **WHEN** a turn's transcript upload fails after the retry budget is exhausted and the
  wake exits
- **THEN** the daemon forwards the failure reason on the terminal turn-advance, the server
  persists it on the (still-`ended`) turn, and the UI shows "the reply could not be
  uploaded" with the reason displayed inline — not "no reply received".

#### Scenario: A successful relay leaves no annotation

- **WHEN** a turn's transcript upload succeeds (possibly after a retry)
- **THEN** no relay-failure annotation is recorded on the turn
- **AND** the turn renders its messages normally.

#### Scenario: The annotation never alters turn status

- **WHEN** a relay-failure reason accompanies a `→ running` transition
- **THEN** the server ignores it (the annotation is terminal-only), so a resumed turn
  never carries a stale relay failure.

### Requirement: The daemon chat conversation list SHALL show a loading state while it loads, distinct from its empty state

The daemon session chat conversation list (the left pane of the "View all" chat modal) SHALL render a loading affordance — a set of skeleton placeholder rows — while its session data is still being fetched, and SHALL render its "no conversations" empty state ONLY after the fetch has completed and genuinely returned no conversations for the selected agent. The loading state and the empty state SHALL be visually distinct so a user can never mistake an in-flight load for an empty list.

The loading affordance SHALL be gated on the conversation list's OWN fetch status alone, not on the independently-settling presence/connections status, so the empty state is never shown during the window where connections have loaded but the session list has not. The loading affordance SHALL appear on the first load (and any load where the list has no data yet), and SHALL NOT re-appear on the periodic background refresh once a first load has succeeded — the background refresh updates the list silently without flashing the loading state.

A load failure with no cached conversations SHALL continue to show the distinct error card, never the empty state and never an indefinite loading state.

#### Scenario: Loading state shows while the list is still fetching

- **GIVEN** the daemon chat modal is open and the conversation list fetch has not yet completed
- **WHEN** the connections/presence status has already settled to loaded but the session list is still loading
- **THEN** the conversation list MUST render the loading affordance (skeleton placeholder rows)
- **AND** it MUST NOT render the "no conversations" empty state

#### Scenario: Empty state shows only after a settled empty load

- **GIVEN** the conversation list fetch has completed successfully
- **WHEN** the selected agent has zero conversations
- **THEN** the conversation list MUST render the "no conversations" empty state
- **AND** it MUST NOT render the loading affordance

#### Scenario: Rows show after a settled non-empty load

- **GIVEN** the conversation list fetch has completed successfully
- **WHEN** the selected agent has one or more conversations
- **THEN** the conversation list MUST render the conversation rows
- **AND** it MUST NOT render either the loading affordance or the empty state

#### Scenario: Background refresh does not flash the loading state

- **GIVEN** the conversation list has completed its first successful load and is showing rows or the empty state
- **WHEN** the periodic background refresh re-fetches the session list
- **THEN** the conversation list MUST continue showing its settled content without re-rendering the loading affordance

#### Scenario: A load failure shows the error card, not the empty or loading state

- **GIVEN** the conversation list fetch fails and there are no cached conversations
- **WHEN** the chat body decides what to render
- **THEN** it MUST render the distinct load-error card
- **AND** it MUST NOT render the "no conversations" empty state or the loading affordance

### Requirement: Server-paginated visible session list

The `GET /api/daemon-sessions` endpoint SHALL support opt-in, backward-compatible
server-side pagination of the caller's visible daemon sessions, matched to the
agent-first chat UI. The endpoint SHALL expose three modes selected by query parameters,
and every mode SHALL enforce the same owner/self + company visibility fence as the
existing unpaginated read (an agent key sees only its own sessions; a user/super_admin sees
only sessions of agents they own; never cross-owner or cross-company).

#### Scenario: Legacy full-list mode is unchanged

- **WHEN** the endpoint is called with no pagination query parameters
- **THEN** it SHALL return `{ sessions }` containing every visible session, enriched with
  `originOnline` and naming fields, ordered by `lastTurnAt` descending — byte-identical in
  shape to the pre-change response
- **AND** non-chat callers (the connections view, the send-instruction targeting picker)
  SHALL continue to work without modification

#### Scenario: Agent-index mode

- **WHEN** the endpoint is called with `view=agents`
- **THEN** it SHALL return, for each agent that has at least one visible session, an entry
  carrying `agentUuid`, the agent's most recent session `lastTurnAt`, and its visible
  `sessionCount`
- **AND** it SHALL compute this with a single grouped aggregate, performing NO per-session
  origin/naming enrichment and NO orphan-turn reconcile
- **AND** the cost SHALL scale with the number of distinct agents, not the total session count

#### Scenario: Per-agent cursor page mode

- **WHEN** the endpoint is called with `agentUuid=<uuid>` and optional `limit` and `before`
- **THEN** it SHALL return `{ sessions, nextCursor, hasMore }` where `sessions` is one page of
  that agent's visible conversations ordered by `lastTurnAt` descending (ties broken by a
  stable secondary key), `nextCursor` is the cursor to pass as `before` for the next page (or
  `null` when none remain), and `hasMore` indicates whether older conversations exist
- **AND** `limit` SHALL default to the client page size and be clamped to a bounded range
- **AND** origin-online enrichment, naming enrichment, and the orphan-turn reconcile SHALL run
  only over the returned page, not the full history

#### Scenario: Per-agent page enforces visibility scope

- **WHEN** a caller requests `agentUuid` for an agent it may not see (an agent it does not own,
  or in another company)
- **THEN** the endpoint SHALL return an empty page rather than another owner's sessions, without
  disclosing whether that agent exists

### Requirement: Chat modal consumes the paginated session list

The daemon chat modal SHALL load its conversation list through the paginated endpoint so the
payload it fetches is bounded by what it displays, while preserving its agent-first behavior.

#### Scenario: Agent axis from the index

- **WHEN** the chat modal opens
- **THEN** it SHALL populate its agent Select and choose a default agent using the agent-index
  mode (unioned with the live connection list for currently-connected agents), without fetching
  any conversation rows for non-selected agents

#### Scenario: Per-agent page load and load-more

- **WHEN** an agent is selected in the chat modal
- **THEN** the modal SHALL fetch the first page of that agent's conversations from the per-agent
  page mode and render them newest-first
- **AND** the "Load more" control SHALL fetch the next page via the server cursor and append it,
  de-duplicated by session uuid, rather than slicing a fully-fetched client-side array

#### Scenario: Bounded background refresh

- **WHEN** the chat modal's periodic refresh runs
- **THEN** it SHALL refetch only the selected agent's first page (resettling online status and
  surfacing newly-started conversations at the top), not the caller's entire session history

#### Scenario: Live updates still merge

- **WHEN** a conversation is started or re-pointed, or a live transcript event arrives, while the
  chat modal is open
- **THEN** the modal SHALL merge it into the currently loaded page (prepend/patch/append) exactly
  as before, without requiring a full-list refetch

