## ADDED Requirements

### Requirement: Comment actions adapt to the active input context

The unified comment component SHALL expose a localized three-dot action trigger on every comment. It SHALL present actions in a keyboard-operable dropdown for desktop contexts and in a bottom sheet with touch-sized rows and safe-area padding for mobile contexts.

#### Scenario: Desktop comment actions

- **WHEN** a user opens a comment action trigger on a viewport wider than the mobile breakpoint
- **THEN** Reply and any authorized Delete action MUST appear in a dropdown aligned to that comment
- **AND** Escape MUST close the dropdown and return focus to its trigger

#### Scenario: Mobile comment actions

- **WHEN** a user opens a comment action trigger at the mobile breakpoint
- **THEN** the same available actions MUST appear in a bottom-anchored sheet
- **AND** each action MUST have a touch target of at least 44 CSS pixels with bottom safe-area padding

### Requirement: Comment deletion is ownership-safe and confirmed

The system SHALL allow an authenticated user to delete a comment only when the comment was authored by that user or by an Agent owned by that user. Delete SHALL be hidden for every other comment, SHALL require explicit confirmation, and SHALL be enforced by a company-scoped server-side authorization check.

#### Scenario: User deletes own comment

- **GIVEN** a comment authored by the authenticated user
- **WHEN** the user confirms Delete
- **THEN** the server MUST delete the comment
- **AND** the loaded list and total count MUST remove it without leaving a tombstone

#### Scenario: User deletes owned Agent comment

- **GIVEN** a comment authored by an Agent whose owner is the authenticated user
- **WHEN** the user confirms Delete
- **THEN** the server MUST delete the comment

#### Scenario: Unauthorized deletion is unavailable and rejected

- **GIVEN** a comment authored by another user or by an Agent owned by another user
- **THEN** the client MUST NOT show Delete
- **AND WHEN** a caller invokes the deletion action directly
- **THEN** the server MUST reject the request without mutating the comment

#### Scenario: User cancels deletion

- **WHEN** the user opens Delete and cancels the confirmation
- **THEN** no comment or count MUST change
- **AND** focus MUST return to the originating action trigger

### Requirement: Reply preserves the draft and inserts a structured mention

Reply SHALL preserve any existing comment draft, append one structured mention of the selected comment's author at a valid text boundary, and focus the editor. Human authors SHALL be inserted as user mentions. Agent authors SHALL be inserted using the existing entity-aware mention routing and pin-selection behavior.

#### Scenario: Reply to a human while a draft exists

- **GIVEN** the editor contains an unsent draft
- **WHEN** the user selects Reply on a human-authored comment
- **THEN** the draft MUST remain intact
- **AND** a structured mention of that user MUST be appended
- **AND** the editor MUST receive focus

#### Scenario: Reply inherits the current Agent route

- **GIVEN** an Agent-authored comment whose Agent resolves to a project-fixed cwd or current direct-Idea pin
- **WHEN** the user selects Reply
- **THEN** the appended Agent mention MUST carry that resolved pin
- **AND** an unavailable hard-pinned destination MUST remain notify-only rather than rerouting to another instance

#### Scenario: Reply to an Agent with one online instance

- **GIVEN** an Agent-authored comment with no fixed or inherited pin and exactly one online instance
- **WHEN** the user selects Reply
- **THEN** the Agent mention MUST be appended with that instance pin without prompting

#### Scenario: Reply to an Agent with multiple online instances

- **GIVEN** an Agent-authored comment with no fixed or inherited pin and multiple online instances
- **WHEN** the user selects Reply
- **THEN** the existing instance picker MUST open
- **AND WHEN** the user selects an instance
- **THEN** the Agent mention MUST be appended with the selected host and cwd and the editor MUST receive focus

#### Scenario: Reply does not duplicate an adjacent mention

- **GIVEN** the editor already ends with the same structured mention that Reply would insert
- **WHEN** the user selects Reply on that author's comment again
- **THEN** the existing mention MUST be preserved without appending an adjacent duplicate

### Requirement: Comment actions are delivered

After implementation verification, the change SHALL be deployed through the existing repository deployment workflow and smoke-tested before a pull request is opened against `develop`. The automated workflow MUST NOT merge that pull request.

#### Scenario: Deployment precedes pull request

- **WHEN** all implementation checks pass
- **THEN** the change MUST be deployed and smoke-tested on the configured live Chorus environment
- **AND** only after the smoke test succeeds MUST a pull request be opened against `develop`
- **AND** the pull request MUST remain unmerged for human review
