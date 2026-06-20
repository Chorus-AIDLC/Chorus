# elaboration-verify-wake Specification

## ADDED Requirements

### Requirement: A human SHALL be able to verify (resolve) an Idea's elaboration from the UI

The system SHALL provide a user-callable path that lets an authenticated human resolve an Idea's elaboration without requiring agent permissions or being the Idea's assignee. The path SHALL be exposed as a Next.js server action (NOT an MCP tool) that rejects callers whose auth type is not `user` (or `super_admin`), and SHALL scope the target Idea by the caller's `companyUuid`. On success it SHALL set the Idea `status` to `elaborated` and `elaborationStatus` to `resolved`, identical to the agent-side resolution's state transition. The human's click SHALL itself constitute the human confirmation that resolution requires — no separate confirmation step is needed.

#### Scenario: A user verifies elaboration when all rounds are answered

- **GIVEN** an Idea in `elaborating` status with at least one elaboration round and no round in `pending_answers`
- **WHEN** an authenticated user invokes the verify-elaboration server action for that Idea in their company
- **THEN** the Idea `status` MUST become `elaborated`
- **AND** the Idea `elaborationStatus` MUST become `resolved`
- **AND** the caller MUST NOT be required to be the Idea's assignee
- **AND** the caller MUST NOT be required to hold any agent permission bit

#### Scenario: An agent caller is rejected from the human verify path

- **WHEN** a caller whose auth type is `agent` invokes the verify-elaboration server action
- **THEN** the action MUST reject the call
- **AND** the Idea status MUST be unchanged

#### Scenario: Verify is refused when a round is still unanswered

- **GIVEN** an Idea with at least one elaboration round in `pending_answers`
- **WHEN** an authenticated user invokes the verify-elaboration server action
- **THEN** the action MUST fail without changing the Idea status
- **AND** the failure MUST indicate that some round(s) still have unanswered questions

#### Scenario: Verify is refused when the Idea has no rounds

- **GIVEN** an Idea in `elaborating` status with zero elaboration rounds
- **WHEN** an authenticated user invokes the verify-elaboration server action
- **THEN** the action MUST fail without changing the Idea status

#### Scenario: Verify does not cross company boundaries

- **GIVEN** an Idea belonging to company C2
- **WHEN** a user authenticated in company C1 invokes the verify-elaboration server action for that Idea
- **THEN** the action MUST NOT resolve the Idea
- **AND** the response MUST NOT confirm the Idea exists in another company

### Requirement: Human verification SHALL emit a distinct `elaboration_verified` signal

Resolving an Idea's elaboration through the human verify path SHALL log an activity with action `elaboration_verified`, distinct from the agent path's `elaboration_resolved`. This distinct action SHALL be the basis for waking the Idea's assigned daemon agent to write the proposal, so that "the human verified — write the proposal" is distinguishable from "answer the elaboration questions" (`elaboration_requested` / `elaboration_answered`).

#### Scenario: Verify logs the elaboration_verified activity

- **WHEN** a user successfully resolves an Idea through the human verify path
- **THEN** an activity with action `elaboration_verified` MUST be recorded for that Idea
- **AND** it MUST be distinct from the `elaboration_resolved` activity emitted by the agent-only resolution tool

### Requirement: The `elaboration_verified` event SHALL wake the Idea's assigned daemon agent to write the proposal

The `elaboration_verified` activity SHALL produce a notification whose recipient is the Idea's **assigned agent** (the daemon), routed through the existing notification → daemon-wake pipeline. The notification MUST NOT surface in a human recipient's notification bell. When the assigned agent has an online daemon connection, a daemon wake SHALL be produced for the Idea's session telling the agent to write the proposal. The wake action SHALL be carried as `elaboration_verified` and distinguished from `elaboration_requested` / `elaboration_answered`.

#### Scenario: Verified elaboration wakes the assigned agent

- **GIVEN** an Idea assigned to a daemon agent that has an online daemon connection
- **WHEN** a human verifies that Idea's elaboration
- **THEN** a wake-triggering notification with action `elaboration_verified` MUST be created with the assigned agent as recipient
- **AND** a daemon turn MUST be produced for the Idea's session

#### Scenario: The verify wake notification does not reach humans

- **WHEN** the `elaboration_verified` notification is created
- **THEN** its recipient MUST be the Idea's assigned agent
- **AND** it MUST NOT appear in any human recipient's notification list

### Requirement: The woken daemon agent SHALL be instructed to write the proposal

The daemon client SHALL treat `elaboration_verified` as a wake action and SHALL build a prompt directing the woken agent to author the proposal for the now-`elaborated` Idea using the existing proposal flow — NOT to answer elaboration questions. The wake SHALL be anchored to the Idea's existing daemon session so the proposal is written in the same conversation that ran the elaboration.

#### Scenario: The daemon prompt directs proposal authoring on verify

- **GIVEN** a daemon receives a wake whose action is `elaboration_verified` for an Idea
- **WHEN** the daemon builds the prompt for the woken agent
- **THEN** the prompt MUST instruct the agent that the Idea is elaborated and to write the proposal
- **AND** the prompt MUST NOT instruct the agent to answer elaboration questions

#### Scenario: elaboration_verified is recognized as a wake action

- **WHEN** the daemon's wake-action set is inspected
- **THEN** it MUST include `elaboration_verified`

### Requirement: Verification SHALL succeed even when the assigned agent is offline, with the wake deferred

When a human verifies an Idea whose assigned agent has no online daemon connection, the resolution SHALL still complete synchronously (Idea → `elaborated` / `resolved`). No live daemon turn is created at that moment; the wake SHALL be recovered through the existing reconnect notification-backfill when the agent's daemon next connects. The UI SHALL communicate that the agent will pick the work up when it comes online. No human "write the proposal yourself" fallback SHALL be added to the idea-detail panel.

#### Scenario: Verify succeeds while the agent is offline

- **GIVEN** an Idea assigned to a daemon agent with no online daemon connection
- **WHEN** a human verifies the Idea's elaboration
- **THEN** the Idea `status` MUST become `elaborated` and `elaborationStatus` `resolved`
- **AND** the verify action MUST NOT fail due to the agent being offline

#### Scenario: The deferred wake is recovered on reconnect

- **GIVEN** a verify performed while the assigned agent was offline
- **WHEN** the agent's daemon reconnects
- **THEN** the agent MUST be able to recover the verify wake through the existing reconnect notification-backfill

#### Scenario: No manual proposal fallback on the idea panel

- **WHEN** the idea-detail panel renders for an Idea whose assigned agent is offline after verify
- **THEN** the panel MUST NOT offer a human "create the proposal manually" affordance for that Idea

### Requirement: The "Verify Elaborate" button SHALL replace the idea-panel "Create Proposal" button and be gated on full answering

The idea-detail panels SHALL render a single idea-level "Verify Elaborate" button in place of the existing human-facing "Create Proposal" button. The button SHALL be enabled only when the Idea is in `elaborating` status, has at least one elaboration round, has no round in `pending_answers`, and is not already `resolved`. The button SHALL appear on BOTH the `/ideas` route idea-detail panel (replacing the existing "Create Proposal" button) AND the dashboard idea-tracker idea-detail panel. The label SHALL be sourced from i18n in both `en` and `zh` locales. The generic "Create Proposal" entry on the proposals-list page SHALL NOT be removed.

#### Scenario: Button is enabled when every round is answered

- **GIVEN** an Idea in `elaborating` status with one or more rounds, none in `pending_answers`, not yet `resolved`
- **WHEN** the idea-detail panel renders
- **THEN** a "Verify Elaborate" button MUST be rendered and enabled
- **AND** the prior human-facing "Create Proposal" button MUST NOT be rendered on that panel

#### Scenario: Button is disabled or absent while a round is unanswered

- **GIVEN** an Idea with at least one round in `pending_answers`
- **WHEN** the idea-detail panel renders
- **THEN** the "Verify Elaborate" button MUST NOT be in an enabled, clickable state

#### Scenario: Button appears on both idea-detail panels

- **WHEN** the Idea is viewed on the `/ideas` route idea-detail panel and on the dashboard idea-tracker idea-detail panel
- **THEN** both panels MUST render the "Verify Elaborate" button subject to the same gating

#### Scenario: The button label is localized

- **WHEN** the button renders under the `en` locale and under the `zh` locale
- **THEN** its label MUST come from an i18n key present in both `messages/en.json` and `messages/zh.json`
- **AND** the label MUST NOT be hardcoded in the component

#### Scenario: The generic proposals-list Create Proposal entry is preserved

- **WHEN** the proposals-list page renders
- **THEN** its generic "Create Proposal" entry MUST still be present

### Requirement: Post-verify status feedback SHALL reuse the derived `planning` state

The feature SHALL NOT introduce a new stored Idea status. After verification, an `elaborated` Idea with no Proposal already derives the display status `planning`; the UI SHALL reuse that derived status to indicate the agent is drafting the proposal. The stored 3-state Idea model (`open` / `elaborating` / `elaborated`) SHALL be unchanged.

#### Scenario: A verified Idea with no proposal shows planning

- **GIVEN** an Idea that has just been verified (now `elaborated`) with no linked Proposal
- **WHEN** its derived display status is computed
- **THEN** the derived status MUST be `planning`
- **AND** no new stored Idea status value MUST be introduced by this change

### Requirement: Ideas reaching `elaborated` without a human verify click SHALL be out of scope

This change SHALL NOT add any new mechanism to wake the agent to write a proposal for an Idea that became `elaborated` through a path other than the human verify click — specifically `skip_elaboration` or an agent calling the existing `chorus_pm_validate_elaboration` tool itself. Those paths SHALL retain their current behavior unchanged.

#### Scenario: Skipped elaboration does not gain a new verify wake

- **GIVEN** an Idea whose elaboration was resolved via `skip_elaboration`
- **WHEN** that resolution completes
- **THEN** this change MUST NOT introduce a new `elaboration_verified` wake for it
- **AND** the skip behavior MUST be unchanged from before this change

#### Scenario: Agent self-validation does not gain a new verify wake

- **GIVEN** an Idea resolved by the assigned agent calling `chorus_pm_validate_elaboration`
- **WHEN** that resolution completes
- **THEN** this change MUST NOT introduce a new `elaboration_verified` wake for it
