## ADDED Requirements

### Requirement: The system SHALL provide a human-callable `yolo_requested` stage-advance event

The system SHALL provide a `yolo_requested` stage-advance definition exposed as a Next.js server action (NOT an MCP tool), built on the shared stage-advance framework. Its precondition SHALL require only that the Idea's assignee is an agent (type `agent` or `agent_instance`, with `agent_instance` resolved to its owning agent) — it SHALL NOT require an approved Proposal or any task state. Its offline policy SHALL be `require_online`: the action SHALL fail with a distinguishable agent-offline error when the assignee agent has no daemon connection that is effectively online. The event SHALL perform NO Idea state transition — on success it SHALL only emit the `yolo_requested` activity with `targetType = "idea"`. The caller SHALL be able to distinguish the assignee-not-an-agent failure from the agent-offline failure.

#### Scenario: Yolo request succeeds and emits only a wake

- **GIVEN** an Idea assigned to an agent with an effectively-online daemon connection
- **WHEN** a user invokes the yolo-request action
- **THEN** an activity with action `yolo_requested` and `targetType = "idea"` MUST be emitted
- **AND** the Idea's stored `status` and `elaborationStatus` MUST be unchanged

#### Scenario: Yolo request succeeds regardless of proposal or task state

- **GIVEN** an Idea assigned to an online agent that has no approved Proposal
- **WHEN** a user invokes the yolo-request action
- **THEN** the precondition MUST pass and the `yolo_requested` activity MUST be emitted

#### Scenario: Yolo request is refused when the agent is offline

- **GIVEN** the Idea's assignee agent has no daemon connection that is effectively online
- **WHEN** a user invokes the yolo-request action
- **THEN** the action MUST fail with an agent-offline error distinguishable from the assignee-not-an-agent failure
- **AND** no activity MUST be emitted

#### Scenario: Yolo request is refused for a human assignee

- **GIVEN** an Idea whose assignee is a user (not an agent)
- **WHEN** a user invokes the yolo-request action
- **THEN** the action MUST fail indicating the assignee is not an agent
- **AND** no activity MUST be emitted

#### Scenario: An agent caller is rejected from the yolo-request action

- **WHEN** a caller whose auth type is `agent` invokes the yolo-request server action
- **THEN** the action MUST reject the call
- **AND** no activity MUST be emitted

### Requirement: The `yolo_requested` wake SHALL target the Idea's assigned agent with session-origin pinning

A `yolo_requested` activity SHALL produce a notification whose only recipient is the Idea's assigned agent (resolving an `agent_instance` assignee to its owning agent); no human SHALL receive it. The notification action SHALL map to a dedicated turn trigger `yolo_requested` — it SHALL NOT be collapsed into `task_assigned`. The trigger SHALL be included in the idea-session-origin upgrade set so that when target selection would otherwise fall back to an arbitrary online connection, the wake is upgraded to the Idea's originating daemon session's connection when that session exists and its connection is effectively online. The notification mapping SHALL NOT be gated by notification preferences.

#### Scenario: The wake goes only to the assigned agent

- **WHEN** a `yolo_requested` activity is emitted for an Idea assigned to agent A
- **THEN** a notification with action `yolo_requested` MUST be created for agent A
- **AND** no human recipient MUST receive a `yolo_requested` notification

#### Scenario: The wake lands on the idea's session origin

- **GIVEN** the Idea has an existing daemon session whose origin connection is effectively online, and no instance pin directed the wake elsewhere
- **WHEN** the `yolo_requested` notification is processed at the wake chokepoint
- **THEN** the created turn MUST be directed to the Idea session's origin connection rather than an arbitrary online connection

#### Scenario: The turn records the dedicated trigger

- **WHEN** a `yolo_requested` notification produces a wake turn
- **THEN** the `DaemonSessionTurn.trigger` MUST be `yolo_requested`
- **AND** it MUST NOT be recorded as `task_assigned`

### Requirement: The daemon SHALL drive the idea via the yolo skill on a `yolo_requested` wake

The daemon client SHALL treat `yolo_requested` as a wake action with server/daemon parity: the daemon's action-to-trigger map, wake-action set, directed re-dispatch trigger list, and wake prompt SHALL all recognize `yolo_requested`. The wake prompt SHALL instruct the woken agent to drive the Idea to completion following the yolo skill (the full-auto AI-DLC pipeline), self-selecting the entry phase from the Idea's current state rather than assuming a fixed stage. The wake prompt SHALL NOT hard-code a single stage, and it SHALL NOT instruct the agent to merge or push a pull request without explicit human approval.

#### Scenario: The wake prompt points at the yolo skill and is stage-adaptive

- **WHEN** the daemon builds the prompt for a `yolo_requested` wake
- **THEN** the prompt MUST instruct the agent to follow the yolo skill / full AI-DLC pipeline
- **AND** it MUST NOT hard-code a single fixed stage as the only action

#### Scenario: Server and daemon trigger surfaces stay in parity

- **WHEN** `yolo_requested` is registered as a wake
- **THEN** the server's notification-action-to-trigger map, the server's turn-trigger enumeration, the daemon's action-to-trigger map, the daemon's wake-action set, and the daemon's re-dispatch trigger list MUST all contain `yolo_requested`

### Requirement: The Idea detail panels SHALL show a Yolo button gated on assignee and agent presence with a confirmation step

Both idea-detail panels (the `/ideas` route panel and the dashboard idea-tracker panel) SHALL render a Yolo button in the header action area (the same action slot as Start Development), gated by ONE shared predicate: the Idea's assignee is an agent (or agent instance), the Idea is not already in a done state, and the assignee agent is online according to the client-side agent-presence data. The button SHALL NOT be gated on the existence of an approved Proposal or on task state, so it MAY appear alongside the Start Development button. Clicking the button SHALL open a confirmation dialog explaining that Yolo drives the whole Idea automatically; the wake SHALL be triggered only after the user confirms. When the presence data says the agent is offline the confirm control SHALL be disabled with an explanatory hint; when the server rejects the click, the UI SHALL surface the specific error (including the agent-offline case) rather than a generic failure. The button SHALL be user-facing-localized in both locales, and both panels SHALL evaluate the same shared predicate so the two surfaces cannot drift.

#### Scenario: The button appears at any incomplete stage for an online agent

- **GIVEN** an Idea assigned to an online agent that is not yet done, with no approved proposal
- **WHEN** either idea-detail panel renders
- **THEN** the Yolo button MUST be visible and enabled in the header action area

#### Scenario: The button and Start Development can coexist

- **GIVEN** an Idea assigned to an online agent with an approved proposal and at least one unfinished task
- **WHEN** either idea-detail panel renders
- **THEN** both the Yolo button and the Start Development button MUST be visible

#### Scenario: Clicking requires confirmation before waking

- **GIVEN** the Yolo button is enabled
- **WHEN** a user clicks it
- **THEN** a confirmation dialog MUST be shown
- **AND** the `yolo_requested` server action MUST NOT be invoked until the user confirms

#### Scenario: Offline agent disables the confirm control client-side

- **GIVEN** the presence data reports the assignee agent as offline
- **WHEN** the panel renders the Yolo affordance
- **THEN** the confirm control MUST be disabled with an offline hint

#### Scenario: A server-side offline rejection is surfaced specifically

- **GIVEN** the button was enabled from stale presence data but the agent is offline at click time
- **WHEN** the server action rejects with the agent-offline error
- **THEN** the UI MUST show the agent-offline message, not a generic error

#### Scenario: Both panels share one gating predicate

- **WHEN** the gating logic is implemented
- **THEN** both panels MUST evaluate the same shared predicate function so the two surfaces cannot drift

### Requirement: The Idea detail panels SHALL NOT show the teaching-style elaboration workflow hint

The Idea detail panels SHALL NOT render the teaching-style workflow hint that instructs the user to complete or skip elaboration before a proposal can be created. Both idea-detail panels SHALL remove that hint, and the corresponding localization key SHALL be removed from both locale files. Real-time status-feedback strings — the agent-offline hint, the development-started hint, and the elaboration-verified queued hint — SHALL remain unchanged.

#### Scenario: The teaching hint is gone from both panels

- **GIVEN** an Idea in the `elaborating` state whose elaboration is not yet resolvable
- **WHEN** either idea-detail panel renders
- **THEN** the "complete or skip elaboration to create a proposal" teaching hint MUST NOT be shown

#### Scenario: Status-feedback hints are preserved

- **WHEN** the teaching hint is removed
- **THEN** the agent-offline, development-started, and elaboration-verified queued hints MUST still render under their existing conditions
