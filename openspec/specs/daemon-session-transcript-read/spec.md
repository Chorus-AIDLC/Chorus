# daemon-session-transcript-read Specification

## Purpose
TBD - created by archiving change chat-style-daemon-ui. Update Purpose after archive.
## Requirements
### Requirement: Single-session transcript read API

The system SHALL expose `GET /api/daemon-sessions/{sessionUuid}` returning the
session together with its ordered turns, each turn carrying its retained
`user`/`assistant` transcript messages. The endpoint SHALL apply the same
owner/self + company visibility fence as the session list: an AGENT-KEY caller
sees only its own sessions; a USER / super_admin caller sees only sessions of
agents they own. A session that does not exist, lives in another company, or
belongs to an agent the caller does not own SHALL all yield the SAME 404
(non-disclosure) — the response MUST NOT reveal that another caller's session
exists.

#### Scenario: Owner reads a visible session's transcript

- **WHEN** a caller requests `GET /api/daemon-sessions/{sessionUuid}` for a
  session whose agent they own (or, for an agent key, their own session)
- **THEN** the response is `200` with `{ session, turns }` where each turn
  includes its messages ordered by `seq`, and the turns are ordered by `seq`

#### Scenario: Non-visible session is indistinguishable from missing

- **WHEN** a caller requests a session that does not exist, OR belongs to another
  company, OR belongs to an agent they do not own
- **THEN** the response is `404` in every case, with no field that distinguishes
  "exists but forbidden" from "does not exist"

#### Scenario: Turns and messages reflect the rolling window

- **WHEN** a visible session has had transcript messages trimmed by the
  rolling-window cap
- **THEN** the read returns only the retained messages (the trimmed-away oldest
  messages are absent), and a turn whose messages were all trimmed still appears
  as a turn with an empty message list

#### Scenario: Read failure is surfaced, not swallowed

- **WHEN** the underlying query fails
- **THEN** the endpoint returns a `500` (the read does not degrade a failure to an
  empty transcript)

### Requirement: Live transcript subscription for the open conversation

The frontend SHALL render the open conversation's turns and messages incrementally
from the `transcript:{sessionUuid}` SSE channel rather than polling. The SSE
endpoint SHALL forward `transcript` events for a session ONLY to a caller to whom
that session is visible, dropping events for other companies or non-owned agents
(consistent with the existing change / presence / execution multi-tenancy drops).
The three triggers — `turn_created`, `turn_status_changed`, `transcript_appended`
— SHALL each update the open conversation without a full refetch.

#### Scenario: A new turn appears live

- **WHEN** the open conversation receives a `turn_created` event
- **THEN** a new turn band is appended to the transcript without a page refresh

#### Scenario: A turn's status changes live

- **WHEN** the open conversation receives a `turn_status_changed` event
  (e.g. `pending → running → ended`)
- **THEN** the corresponding turn band's status indicator updates in place

#### Scenario: Appended transcript text renders live

- **WHEN** the open conversation receives a `transcript_appended` event
- **THEN** the affected turn's message list grows by the appended messages,
  without re-fetching the whole session

#### Scenario: Events for a non-visible session are not delivered

- **WHEN** a `transcript` event is published for a session the caller cannot see
- **THEN** the caller's SSE stream does not receive it

### Requirement: Chat-style conversation surface

The "View all" daemon modal SHALL present a chat-style two-pane layout: a left
pane with a small agent selector and that agent's conversation list (all of the
selected agent's sessions, active and ended, ordered newest-first by
`lastTurnAt`, paginated), and a right pane showing the selected conversation's
turn-by-turn transcript. Each turn band SHALL display its wake trigger
(task_assigned / mentioned / elaboration / human_instruction / resume) and its
live status, and an entity-bearing turn SHALL link to its related task/idea.
Connection metadata (host, client version, uptime, started) SHALL be demoted from
the headline to a secondary/collapsible position. The right pane SHALL offer
inline send-instruction and interrupt controls, each gated on the session's origin
being online.

#### Scenario: Selecting an agent then a conversation

- **WHEN** a user opens the modal, picks an agent in the selector, and selects a
  conversation from the left list
- **THEN** the right pane renders that conversation's turns with their messages,
  with the most recent turn visible

#### Scenario: Trigger provenance is visible per turn

- **WHEN** a conversation contains turns of different triggers (e.g. a
  task_assigned turn and a human_instruction turn)
- **THEN** each turn band shows a label/glyph identifying its trigger, and the
  entity-bearing turn shows a link to its related task or idea

#### Scenario: Read-only when origin offline

- **WHEN** the selected conversation's origin connection is offline
- **THEN** the transcript history still renders, the send composer's direct-send
  is disabled with a visible reason, and the interrupt control is not offered

#### Scenario: Running turn is visually distinguished

- **WHEN** a turn in the open conversation is in the `running` status
- **THEN** the turn band is visually marked as running (with motion only under
  `motion-safe`; reduced-motion shows a static marker)

#### Scenario: Empty state is an invitation, not an error

- **WHEN** the selected agent has no conversations
- **THEN** the surface shows a calm empty state that invites starting a
  conversation, never an error treatment

