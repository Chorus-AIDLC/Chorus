## ADDED Requirements

### Requirement: Session activity SHALL be delivered as start and end events without new persistence

The system SHALL publish exactly two new company-wide session-activity event kinds: `session_started` when a daemon session turn transitions into `running`, and `session_ended` when that running turn transitions to a terminal state. Each event SHALL identify the company, session, running activity token, direct Idea when present, agent, and origin connection. The implementation SHALL reuse existing `DaemonSession` and `DaemonSessionTurn` data and SHALL NOT add a database table, column, persisted Idea activity flag, execution enrichment, or activity history.

#### Scenario: Running transition publishes start

- **WHEN** a visible session turn transitions from pending to running
- **THEN** one `session_started` event is published after the successful write with that turn UUID as its activity token

#### Scenario: Terminal transition publishes end

- **WHEN** a running session turn transitions to ended or interrupted
- **THEN** one `session_ended` event is published after the successful write with the same activity token

#### Scenario: Non-running transitions publish neither event

- **WHEN** a turn is created pending, remains in the same state, or transitions without entering or leaving running
- **THEN** neither new session-activity event kind is published

#### Scenario: Existing persistence remains unchanged

- **WHEN** session activity events are implemented
- **THEN** no Prisma schema or migration change is introduced and existing session, turn, transcript, and execution persistence semantics remain unchanged

### Requirement: Event-stream bootstrap SHALL reconstruct currently running activities

The company-wide dashboard event stream SHALL forward live `session_started` and `session_ended` events for every session in the caller's company. On initial connection and reconnect it SHALL also query company-visible currently running turns and replay each through the same `session_started` payload shape. The stream SHALL attach its live listener before reading the bootstrap snapshot, and the client SHALL treat repeated starts idempotently by activity token. For a user subscriber, each activity SHALL include subscriber-relative `canOpen` authorization derived from existing agent ownership; for an agent-key subscriber, visibility SHALL remain self-only. Cross-company activity SHALL remain fenced. No periodic activity poll or new REST endpoint SHALL be added.

#### Scenario: Already-running session appears on first connection

- **WHEN** the dashboard event stream opens while a visible session turn is already running
- **THEN** the stream sends a `session_started` payload for that activity without waiting for a new transition

#### Scenario: Reconnect removes stale client state

- **WHEN** the stream reconnects after missing a session end
- **THEN** bootstrap contains only activities still running and the frontend replaces its prior session-activity state with the reconstructed set

#### Scenario: Concurrent live start and bootstrap are idempotent

- **WHEN** the same running activity is observed by both the live listener and bootstrap query
- **THEN** the frontend retains one activity token and one active session entry

#### Scenario: User observes another user's activity without chat authorization

- **WHEN** another user in the same company has a running session
- **THEN** its start, end, and bootstrap activity are forwarded with `canOpen: false`

#### Scenario: Owned activity carries chat authorization

- **WHEN** the current user's owned agent has a running session
- **THEN** its start, end, and bootstrap activity are forwarded with `canOpen: true`

#### Scenario: Agent keys and company fences remain isolated

- **WHEN** an agent-key caller observes activity or any caller encounters another company's session
- **THEN** the agent key receives only its own activity and cross-company activity is never forwarded

### Requirement: Frontend SHALL derive active Ideas and preserve exact-session chat focus

The shell-level frontend provider SHALL maintain active session state from `session_started` and `session_ended` events. A session SHALL be active while at least one running activity token remains, and an Idea SHALL be active while at least one such session has its `directIdeaUuid`. The provider SHALL group by direct Idea, deduplicate by session UUID, retain subscriber-relative `canOpen`, and derive available display data by joining the existing connection list in memory. Activating an owned session SHALL carry its existing `sessionUuid` together with the familiar agent and optional host/CWD focus, so desktop and mobile open that exact conversation without a new backend lookup. A session with `canOpen: false` SHALL remain visible but SHALL NOT invoke navigation.

#### Scenario: Overlapping activities keep a session active

- **WHEN** a session has two running activity tokens and one receives `session_ended`
- **THEN** the session and its Idea remain active until the second token also ends

#### Scenario: Direct child Idea receives the activity

- **WHEN** a session carries a direct child Idea UUID
- **THEN** the frontend groups the session under that child Idea rather than a lineage ancestor

#### Scenario: Available connection preserves CWD and exact session

- **WHEN** a user activates an active session whose origin connection is available
- **THEN** the daemon chat opens with that session's UUID, agent, host, and CWD and mobile displays its transcript drill-down

#### Scenario: Missing connection details preserve exact session

- **WHEN** owned activity arrives before its origin connection is present in frontend state
- **THEN** the activity remains visible and activation opens that session using its UUID and agent without a fabricated host or CWD

#### Scenario: Other-user session remains status-only

- **WHEN** an active session has `canOpen: false`
- **THEN** Tracker and Graph disclose its running state and agent identity but provide no action that opens chat

### Requirement: Idea Tracker SHALL display active daemon sessions

Every Idea row in flat and lineage Tracker views, and the open Idea detail sidebar, SHALL render a distinct running indicator based on the shared animated Agent avatar while frontend state contains at least one active session for that Idea. Hovering or focusing the indicator SHALL disclose each active session with its Agent avatar, identity, CWD, and ownership-safe status. One session SHALL navigate directly to its exact conversation; several sessions SHALL display a count and chooser. Activating the indicator SHALL NOT also trigger Idea-detail navigation. The indicator SHALL disappear immediately after the final `session_ended` event and SHALL NOT retain recent/history state.

#### Scenario: One active session opens its exact conversation

- **WHEN** an Idea row has exactly one active session and the user activates its indicator
- **THEN** daemon chat opens that session's transcript on desktop and mobile and the Idea detail panel does not open

#### Scenario: Multiple sessions are selectable

- **WHEN** an Idea row has multiple active sessions
- **THEN** the indicator shows their count, hover or focus lists every Agent avatar and location, and the chooser opens the selected conversation

#### Scenario: Idea detail sidebar mirrors the running state

- **WHEN** an active Idea is open in the Tracker detail sidebar
- **THEN** its header displays the same active-session indicator and choices as the corresponding Tracker row

#### Scenario: Flat and lineage views agree

- **WHEN** the same Idea is rendered in flat and lineage Tracker views
- **THEN** both show the same active-session count and navigation choices

#### Scenario: Final end removes the indicator

- **WHEN** the final running activity token for an Idea receives `session_ended`
- **THEN** its Tracker indicator disappears without a page refresh or replacement history marker
