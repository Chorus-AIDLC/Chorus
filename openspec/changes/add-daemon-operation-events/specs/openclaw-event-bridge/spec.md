## MODIFIED Requirements

### Requirement: The plugin's handled wake actions SHALL stay in lockstep with the daemon's wake actions

A repository-level test SHALL enforce that the set of notification actions the OpenClaw plugin's event router handles is a superset of the daemon's wake-action set (`WAKE_ACTIONS` exported from `cli/prompts.mjs`), excluding only the actions that are delivered off the notification `switch` by design — the reverse-control-channel resume (`resource_resumed`) and the turn-delivered instruction and dedicated operations (`human_instruction`, `idea_creation_requested`, `research_requested`). The test SHALL live where the repository's main test runner collects it (a location the root Vitest `include` covers and its `packages` exclude does not), so it runs in the main CI and can read both the daemon and plugin sources. When a wake action exists in the daemon set (outside the excluded set) but is not handled by the plugin router, the test SHALL fail and SHALL name the missing action(s).

#### Scenario: A new daemon wake action not ported to the plugin fails the guard

- **GIVEN** the daemon's `WAKE_ACTIONS` gains a new action that is not in the control/turn-delivered exclusion set
- **WHEN** that action is not added to the plugin router's handled cases
- **THEN** the lockstep test MUST fail
- **AND** the failure MUST identify the missing action by name

#### Scenario: The current stage-advance actions satisfy the guard

- **GIVEN** the plugin router handles `elaboration_verified`, `start_development`, and `yolo_requested`
- **WHEN** the lockstep test runs
- **THEN** it MUST pass
- **AND** it MUST NOT require the plugin to handle `resource_resumed`, `human_instruction`, `idea_creation_requested` or `research_requested` (which are delivered off the notification switch)

#### Scenario: Dedicated operations have one delivery path
- **WHEN** dedicated operation actions appear in notification broadcasts
- **THEN** both daemon and plugin notification routers defer their execution to the authorized turn-delivery mechanism, and the lockstep guard excludes exactly those named operations without weakening its checks for other actions
