# openclaw-event-bridge Specification

## ADDED Requirements

### Requirement: The plugin SHALL route the daemon's stage-advance wake actions to an embedded-agent wake

The OpenClaw plugin's event router SHALL handle the three human-initiated stage-advance notification actions — `elaboration_verified`, `start_development`, and `yolo_requested` — by waking the embedded agent with an action-appropriate prompt, rather than letting them fall through to the unhandled-action default. Each wake SHALL be idea-anchored (the notification entity is the idea), SHALL carry a `contextKey` derived from the action and the entity UUID so duplicate deliveries collapse to one wake, and SHALL include `@mention` guidance addressing the actor. The prompt wording MAY differ from the CLI daemon's (`cli/prompts.mjs`) wording, but SHALL preserve each action's instructional contract:

- `elaboration_verified` SHALL instruct the agent that the idea is now elaborated, that it MUST NOT answer elaboration questions, and that it SHALL write the proposal via the existing proposal flow.
- `start_development` SHALL instruct the agent to claim and execute ALL remaining tasks of the idea's approved proposal in dependency order, looping until no claimable task remains, and SHALL NOT instruct it to stop after a single task.
- `yolo_requested` SHALL instruct the agent to drive the whole idea to done via the yolo skill, resuming from the idea's current phase, and SHALL instruct it NOT to merge or push a pull request without explicit human approval.

#### Scenario: elaboration_verified wakes the agent to write the proposal

- **GIVEN** the plugin receives a `new_notification` SSE event whose notification action is `elaboration_verified` for an idea
- **WHEN** the router dispatches it
- **THEN** it MUST wake the embedded agent with a message instructing it to write the proposal (not to answer elaboration questions)
- **AND** the wake's `contextKey` MUST be derived from the `elaboration_verified` action and the idea UUID

#### Scenario: start_development wakes the agent to execute all remaining tasks

- **GIVEN** the plugin receives a `new_notification` SSE event whose notification action is `start_development` for an idea
- **WHEN** the router dispatches it
- **THEN** it MUST wake the embedded agent with a message instructing it to claim and execute all remaining tasks in dependency order, looping until none are claimable
- **AND** the wake's `contextKey` MUST be derived from the `start_development` action and the idea UUID

#### Scenario: yolo_requested wakes the agent to drive the idea to done

- **GIVEN** the plugin receives a `new_notification` SSE event whose notification action is `yolo_requested` for an idea
- **WHEN** the router dispatches it
- **THEN** it MUST wake the embedded agent with a message instructing it to drive the idea to done via the yolo skill, resuming from the idea's current phase
- **AND** the message MUST instruct the agent not to merge or push a pull request without explicit human approval
- **AND** the wake's `contextKey` MUST be derived from the `yolo_requested` action and the idea UUID

#### Scenario: A stage-advance action is no longer treated as unhandled

- **WHEN** the router dispatches any of `elaboration_verified`, `start_development`, or `yolo_requested`
- **THEN** it MUST NOT log the action as an unhandled notification action
- **AND** it MUST produce exactly one wake for that notification

### Requirement: The plugin's handled wake actions SHALL stay in lockstep with the daemon's wake actions

A repository-level test SHALL enforce that the set of notification actions the OpenClaw plugin's event router handles is a superset of the daemon's wake-action set (`WAKE_ACTIONS` exported from `cli/prompts.mjs`), excluding only the actions that are delivered off the notification `switch` by design — the reverse-control-channel resume (`resource_resumed`) and the turn-delivered instruction (`human_instruction`). The test SHALL live where the repository's main test runner collects it (a location the root Vitest `include` covers and its `packages` exclude does not), so it runs in the main CI and can read both the daemon and plugin sources. When a wake action exists in the daemon set (outside the excluded set) but is not handled by the plugin router, the test SHALL fail and SHALL name the missing action(s).

#### Scenario: A new daemon wake action not ported to the plugin fails the guard

- **GIVEN** the daemon's `WAKE_ACTIONS` gains a new action that is not in the control/turn-delivered exclusion set
- **WHEN** that action is not added to the plugin router's handled cases
- **THEN** the lockstep test MUST fail
- **AND** the failure MUST identify the missing action by name

#### Scenario: The current stage-advance actions satisfy the guard

- **GIVEN** the plugin router handles `elaboration_verified`, `start_development`, and `yolo_requested`
- **WHEN** the lockstep test runs
- **THEN** it MUST pass
- **AND** it MUST NOT require the plugin to handle `resource_resumed` or `human_instruction` (which are delivered off the notification switch)
