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

### Requirement: The conversation surface SHALL be fullscreen on mobile with the reply input pinned to the bottom

On a mobile-width viewport (below the `sm` breakpoint), the "View all" daemon conversation modal SHALL fill the viewport edge-to-edge — occupying the full dynamic viewport height and width with no rounded corners, border, or floating margin — so it reads like a native chat screen. The selected conversation's transcript SHALL fill the middle region and scroll within itself, and the reply/send input SHALL be pinned to the bottom edge of the viewport (not floated mid-screen with dead space below it). The modal height SHALL be measured against the dynamic viewport height so the mobile browser's collapsing/expanding URL bar cannot push the pinned input off-screen. On desktop-width viewports (`sm` and above) the modal SHALL remain the floating, height-capped card, and on `lg` and above the two-pane (conversation list + transcript) layout SHALL be unchanged.

#### Scenario: Modal is fullscreen on a mobile viewport

- **WHEN** a user opens the daemon conversation modal on a mobile-width viewport and drills into a conversation
- **THEN** the modal fills the viewport edge-to-edge with no rounded card, border, or surrounding margin
- **AND** the transcript fills the middle region and scrolls within itself
- **AND** the reply/send input is pinned to the bottom edge of the viewport with no dead space below it

#### Scenario: Desktop layout is preserved

- **WHEN** the same modal is opened on a desktop-width viewport
- **THEN** it renders as the floating, height-capped card
- **AND** at the `lg`-and-above width the two-pane conversation-list + transcript layout and behavior are unchanged

### Requirement: Wide markdown blocks in a transcript message SHALL be constrained to the available content width

When a transcript message renders Markdown that contains a wide block — a table, a code block, a long word or URL, or a wide image — the block SHALL be constrained to the message's available content width rather than overflowing it. A table or code block SHALL scroll horizontally within its own region while preserving its layout; long words and URLs SHALL wrap; a wide image SHALL be scaled down to the available width. The message bubble, the transcript column, and the overall modal SHALL NOT be widened by such a block — no horizontal overflow of the conversation container SHALL occur, on mobile or desktop. This constraint applies to the daemon transcript message renderer; the change SHALL NOT alter the shared application-wide Markdown rendering behavior for Ideas, Comments, or Documents unless that behavior is verified to be unchanged.

#### Scenario: A markdown table does not overflow the conversation

- **WHEN** a transcript message contains a Markdown table wider than the available content width, rendered on a mobile-width viewport
- **THEN** the conversation container does not overflow horizontally (the overall layout width is not blown out)
- **AND** the table scrolls horizontally within its own region with its column layout preserved

#### Scenario: Long words, URLs, and wide images are contained

- **WHEN** a transcript message contains a very long unbroken word or URL, or an image wider than the content width
- **THEN** the long word or URL wraps within the available width
- **AND** the image is scaled down to fit the available width
- **AND** the message bubble width is not widened past the conversation container

#### Scenario: Shared markdown surfaces are not regressed

- **WHEN** the transcript content-width constraint is implemented
- **THEN** the rendering of Ideas, Comments, and Document markdown content is unchanged
- **AND** any constraint applied at the shared renderer level is only retained if those surfaces are verified visually unchanged

#### Scenario: The scrolling-ancestor content wrapper does not defeat the width constraint

- **WHEN** the transcript is rendered inside a scroll container (e.g. Radix `ScrollArea`) whose viewport injects a content wrapper sized to its content's max-content width (such as an inline `display:table; min-width:100%` wrapper)
- **THEN** that injected wrapper SHALL be constrained to the viewport width (e.g. forced to `display:block`) so a wide block cannot grow it past the viewport
- **AND** the `min-width:0` shrink chain on the transcript markup SHALL be effective rather than defeated by an unbounded ancestor
- **AND** the override SHALL be scoped to the daemon transcript scroll container, leaving other scroll areas unaffected

