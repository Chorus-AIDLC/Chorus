# elaboration-round-generation

## ADDED Requirements

### Requirement: Unified round generation across elaboration states

The system SHALL provide a single round-generation operation (`chorus_pm_start_elaboration`) that creates an elaboration round when the source Idea is in either the `elaborating` or the `elaborated` state. Creating a round MUST NOT require the caller to manage the previous round's UUID.

#### Scenario: Generate the first round on a newly claimed Idea

- **WHEN** an agent with `idea:write` calls `chorus_pm_start_elaboration` on an Idea in status `elaborating`
- **THEN** a new round is created with status `pending_answers` and `isAppended = false`
- **AND** the Idea's `elaborationStatus` becomes `pending_answers`

#### Scenario: Generate a follow-up round while still elaborating

- **WHEN** an agent calls `chorus_pm_start_elaboration` again on an Idea still in status `elaborating` whose prior round is already `answered`
- **THEN** a new `pending_answers` round is created with `isAppended = false`
- **AND** no per-question issue tagging and no `validate` call is required to open the new round

### Requirement: Appended rounds after resolution

The system SHALL allow `chorus_pm_start_elaboration` to be called on an Idea whose elaboration has already been resolved (Idea status `elaborated`). Such a round SHALL be marked as appended and MUST be a pure supplement that does not regress the Idea's lifecycle.

#### Scenario: Append a round to a resolved Idea

- **WHEN** an agent calls `chorus_pm_start_elaboration` on an Idea in status `elaborated` (`elaborationStatus = resolved`)
- **THEN** a new `pending_answers` round is created with `isAppended = true`
- **AND** the Idea's status remains `elaborated`
- **AND** the Idea's `elaborationStatus` remains `resolved`

#### Scenario: Appended round never blocks proposal submission

- **WHEN** an Idea with `elaborationStatus = resolved` is an input to an in-flight proposal and an appended round is created
- **THEN** `chorus_pm_submit_proposal` for that proposal still succeeds because the Idea's `elaborationStatus` is unchanged at `resolved`

### Requirement: Appended marker is surfaced everywhere

The system SHALL expose the appended marker (`isAppended`) on every round in MCP responses and SHALL display a distinct visual badge for appended rounds in the elaboration UI.

#### Scenario: MCP elaboration payload includes the marker

- **WHEN** a client calls `chorus_get_elaboration` for an Idea that has at least one appended round
- **THEN** each round object in the response includes an `isAppended` boolean
- **AND** the appended round reports `isAppended = true`

#### Scenario: UI shows an appended badge

- **WHEN** the elaboration panel renders a round whose `isAppended` is true
- **THEN** the round card displays a localized "appended / follow-up" badge distinct from the normal round-number badge
- **AND** the badge label is available in both `en` and `zh` locales
