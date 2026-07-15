# stage-advance-wake Specification

## Purpose
TBD - created by archiving change add-stage-advance-start-development. Update Purpose after archive.
## Requirements
### Requirement: The system SHALL provide a generic human stage-advance execution path

The system SHALL provide one shared server-side stage-advance helper that executes any human one-click stage-advance event from a static per-stage definition. The definition SHALL declare: the activity action string, a per-stage precondition check, an optional per-stage state transition, and an offline policy (`queue` or `require_online`). The shared helper SHALL (in order): reject callers whose auth type is not `user` or `super_admin`, resolve the target Idea scoped by the caller's `companyUuid`, run the per-stage precondition, enforce the offline policy, run the optional transition, and emit an activity with `targetType = "idea"` and the definition's action string. Adding a new stage-advance event SHALL NOT require duplicating the actor gate, company scoping, or activity emission.

#### Scenario: An agent caller is rejected from any stage-advance action

- **WHEN** a caller whose auth type is `agent` invokes a stage-advance server action
- **THEN** the action MUST reject the call
- **AND** no activity MUST be emitted

#### Scenario: Stage-advance does not cross company boundaries

- **GIVEN** an Idea belonging to company C2
- **WHEN** a user authenticated in company C1 invokes a stage-advance action for that Idea
- **THEN** the action MUST fail without emitting an activity
- **AND** the response MUST NOT confirm the Idea exists in another company

#### Scenario: A failed precondition emits nothing

- **GIVEN** a stage-advance definition whose precondition rejects the Idea's current state
- **WHEN** a user invokes that stage-advance action
- **THEN** the action MUST fail with the precondition's reason
- **AND** no state transition MUST occur
- **AND** no activity MUST be emitted

### Requirement: The elaboration-verify path SHALL run on the stage-advance framework with unchanged behavior

The existing human verify-elaboration path SHALL be migrated onto the shared stage-advance helper as its first definition. The migration SHALL be behavior-preserving: the same preconditions (at least one round, none `pending_answers`), the same state transition (Idea `status → elaborated`, `elaborationStatus → resolved`), the same `elaboration_verified` activity action, and the same queue-when-offline policy (resolution succeeds even when the assigned agent is offline; the wake is recovered by the existing reconnect backfill). The exported `verifyElaboration` service signature and the `verifyElaborationAction` server action SHALL remain callable unchanged.

#### Scenario: Verify elaboration still succeeds when the agent is offline

- **GIVEN** an Idea whose elaboration is fully answered and whose assigned agent has no online daemon connection
- **WHEN** a user invokes the verify-elaboration action
- **THEN** the Idea MUST still transition to `elaborated` / `resolved`
- **AND** the `elaboration_verified` activity MUST be emitted

#### Scenario: Existing elaboration-verify behavior is regression-free after migration

- **WHEN** the elaboration-verify path is migrated onto the stage-advance framework
- **THEN** all pre-existing verify-elaboration service and server-action tests MUST pass without behavioral modification

### Requirement: The system SHALL provide a human-callable `start_development` stage-advance event

The system SHALL provide a `start_development` stage-advance definition exposed as a Next.js server action (NOT an MCP tool). Its precondition SHALL require ALL of: the Idea's assignee is an agent (type `agent` or `agent_instance`, with `agent_instance` resolved to its owning agent); an approved Proposal exists whose `inputUuids` contains the Idea; and that Proposal has at least one materialized Task whose status is neither `done` nor `closed` (statuses `open`, `assigned`, `in_progress`, `to_verify` all count as unfinished). Its offline policy SHALL be `require_online`: the action SHALL fail with a distinguishable agent-offline error when the assignee agent has no daemon connection that is effectively online (`status === "online"` and `lastSeenAt` within the staleness threshold). The event SHALL perform NO Idea state transition — on success it SHALL only emit the `start_development` activity. Each failed precondition SHALL be distinguishable by the caller (no approved proposal / no unfinished tasks / assignee not an agent / agent offline).

#### Scenario: Start development succeeds and emits only a wake

- **GIVEN** an Idea assigned to an agent with an effectively-online daemon connection, an approved Proposal containing the Idea, and at least one task in `open` status
- **WHEN** a user invokes the start-development action
- **THEN** an activity with action `start_development` and `targetType = "idea"` MUST be emitted
- **AND** the Idea's stored `status` and `elaborationStatus` MUST be unchanged

#### Scenario: Start development is refused when the agent is offline

- **GIVEN** the Idea's assignee agent has no daemon connection that is effectively online
- **WHEN** a user invokes the start-development action
- **THEN** the action MUST fail with an agent-offline error distinguishable from other precondition failures
- **AND** no activity MUST be emitted

#### Scenario: Start development is refused without an approved proposal

- **GIVEN** an Idea with no approved Proposal (none exists, or only pending/rejected ones)
- **WHEN** a user invokes the start-development action
- **THEN** the action MUST fail indicating no approved proposal

#### Scenario: Start development is refused when all tasks are finished

- **GIVEN** an approved Proposal whose materialized tasks are all in `done` or `closed` status
- **WHEN** a user invokes the start-development action
- **THEN** the action MUST fail indicating no unfinished tasks

#### Scenario: Tasks awaiting verification still count as unfinished

- **GIVEN** an approved Proposal whose only non-done task is in `to_verify` status
- **WHEN** a user invokes the start-development action with the assignee agent online
- **THEN** the precondition MUST pass and the `start_development` activity MUST be emitted

#### Scenario: Start development is refused for a human assignee

- **GIVEN** an Idea whose assignee is a user (not an agent)
- **WHEN** a user invokes the start-development action
- **THEN** the action MUST fail indicating the assignee is not an agent

### Requirement: The `start_development` wake SHALL target the Idea's assigned agent with session-origin pinning

A `start_development` activity SHALL produce a notification whose only recipient is the Idea's assigned agent (resolving an `agent_instance` assignee to its owning agent); no human SHALL receive it. The notification action SHALL map to a dedicated turn trigger `start_development` — it SHALL NOT be collapsed into `task_assigned`. The trigger SHALL be included in the idea-session-origin upgrade set so that when target selection would otherwise fall back to an arbitrary online connection, the wake is upgraded to the Idea's originating daemon session's connection when that session exists and its connection is effectively online. The notification mapping SHALL NOT be gated by notification preferences.

#### Scenario: The wake goes only to the assigned agent

- **WHEN** a `start_development` activity is emitted for an Idea assigned to agent A
- **THEN** a notification with action `start_development` MUST be created for agent A
- **AND** no human recipient MUST receive a `start_development` notification

#### Scenario: The wake lands on the idea's session origin

- **GIVEN** the Idea has an existing daemon session whose origin connection is effectively online, and no instance pin directed the wake elsewhere
- **WHEN** the `start_development` notification is processed at the wake chokepoint
- **THEN** the created turn MUST be directed to the Idea session's origin connection rather than an arbitrary online connection

#### Scenario: The turn records the dedicated trigger

- **WHEN** a `start_development` notification produces a wake turn
- **THEN** the `DaemonSessionTurn.trigger` MUST be `start_development`
- **AND** it MUST NOT be recorded as `task_assigned`

### Requirement: The daemon SHALL execute all remaining tasks on a `start_development` wake

The daemon client SHALL treat `start_development` as a wake action with server/daemon parity: the daemon's action-to-trigger map, wake-action set, autonomous re-dispatch trigger list, and wake prompt SHALL all recognize `start_development`. The wake prompt SHALL instruct the woken agent to claim and execute ALL remaining claimable tasks of the Idea's approved proposal in dependency order — repeatedly claiming unblocked tasks, implementing, and submitting each for verification per the develop workflow — not stopping after a single task, and leaving tasks already in `to_verify` (or claimed by others) untouched. The wake SHALL end benignly when no claimable task remains.

#### Scenario: The wake prompt demands the full execute stage

- **WHEN** the daemon builds the prompt for a `start_development` wake
- **THEN** the prompt MUST instruct the agent to loop over all remaining claimable tasks in dependency order until none remain
- **AND** it MUST NOT instruct the agent to stop after one task

#### Scenario: Server and daemon trigger surfaces stay in parity

- **WHEN** `start_development` is registered as a wake
- **THEN** the server's notification-action-to-trigger map, the server's turn-trigger enumeration, the daemon's action-to-trigger map, the daemon's wake-action set, and the daemon's re-dispatch trigger list MUST all contain `start_development`

#### Scenario: A wake with nothing claimable ends without error

- **GIVEN** a `start_development` wake arrives while every unfinished task is in `to_verify` or held by another session
- **WHEN** the woken agent evaluates the task set
- **THEN** the turn MUST end without claiming anything and without error

### Requirement: The Idea detail panels SHALL show a Start Development button gated on stage state and agent presence

Both idea-detail panels (the `/ideas` route panel and the dashboard idea-tracker panel) SHALL render a Start Development button in the header action area (the same action slot as Verify Elaborate), gated by ONE shared predicate: the Idea's assignee is an agent (or agent instance), an approved Proposal containing the Idea exists, at least one of its tasks is neither `done` nor `closed`, and the assignee agent is online according to the client-side agent-presence data. The button SHALL be user-facing-localized in both locales. When the presence data says the agent is offline the button SHALL be disabled with an explanatory hint; when the server rejects the click, the UI SHALL surface the specific error (including the agent-offline case) rather than a generic failure. The button display is optimistic — the server-side validation is authoritative.

#### Scenario: The button appears when all conditions hold

- **GIVEN** an Idea assigned to an online agent, with an approved proposal and at least one unfinished task
- **WHEN** either idea-detail panel renders
- **THEN** the Start Development button MUST be visible and enabled in the header action area

#### Scenario: The button is absent without an approved proposal or unfinished tasks

- **GIVEN** an Idea with no approved proposal, OR whose approved proposal's tasks are all `done`/`closed`
- **WHEN** either idea-detail panel renders
- **THEN** the Start Development button MUST NOT be enabled

#### Scenario: Offline agent disables the button client-side

- **GIVEN** the presence data reports the assignee agent as offline
- **WHEN** the panel renders
- **THEN** the button MUST be disabled with an offline hint

#### Scenario: A server-side offline rejection is surfaced specifically

- **GIVEN** the button was enabled from stale presence data but the agent is offline at click time
- **WHEN** the server action rejects with the agent-offline error
- **THEN** the UI MUST show the agent-offline message, not a generic error

#### Scenario: Both panels share one gating predicate

- **WHEN** the gating logic is implemented
- **THEN** both panels MUST evaluate the same shared predicate function so the two surfaces cannot drift

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

### Requirement: The proposal-approved wake SHALL deliver the reviewer's note inline

The daemon wake prompt for a `proposal_approved` notification SHALL surface the reviewer's decision note inline (drawn from the notification `message`, which already carries the approver's note), so the woken daemon knows the reviewer's opinion without a follow-up `chorus_get_proposal` fetch — symmetric with the existing `proposal_rejected` wake, which already embeds the reviewer's reason. This SHALL apply to every proposal-approved wake regardless of whether the proposal's idea is top-level or a derived child. No new notification field is introduced; the note is carried on the existing `message`.

#### Scenario: Approve wake surfaces the note

- **WHEN** a reviewer approves a proposal with a review note and the assigned daemon agent is woken for `proposal_approved`
- **THEN** the wake prompt includes the reviewer's note text inline, so the daemon can act on the reviewer's opinion without separately fetching the proposal.

#### Scenario: Approve wake without a note is unchanged

- **WHEN** a reviewer approves a proposal without a review note
- **THEN** the wake prompt renders without a note (no empty/placeholder note text) and still directs the daemon to find the now-unblocked tasks.

#### Scenario: Reject wake note delivery is unchanged

- **WHEN** a reviewer rejects a proposal with a reason
- **THEN** the `proposal_rejected` wake prompt continues to embed that reason inline exactly as before this change.

