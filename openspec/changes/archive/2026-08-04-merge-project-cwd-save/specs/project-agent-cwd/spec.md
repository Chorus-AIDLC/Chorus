## ADDED Requirements

### Requirement: Project form commits cwd preferences
Chorus SHALL persist Project metadata and the current user's Agent cwd changes
from one Project create or save action. Selecting, replacing, or clearing a cwd
inside the Project form MUST remain a draft until that action succeeds, and the
form MUST NOT expose a separate persistence action for cwd preferences.

#### Scenario: Create Project with a selected cwd
- **WHEN** a user selects a valid Agent cwd and submits Create Project
- **THEN** Chorus MUST create the Project and fixed cwd preference together
- **AND** neither record MUST be committed if the cwd validation is invalid

#### Scenario: Save Project with cwd replacements and clears
- **WHEN** a user edits Project metadata, replaces one Agent cwd, clears another, and submits Save Changes
- **THEN** Chorus MUST apply the metadata, replacement, and clear in one transaction
- **AND** unchanged Agent cwd preferences MUST remain unchanged

#### Scenario: User confirms a directory inside the form
- **WHEN** daemon validation succeeds for a selected directory
- **THEN** Chorus MUST show the normalized cwd as a local draft
- **AND** Chorus MUST NOT persist that preference until the Project create or save action succeeds

### Requirement: Project form reports cwd validation inline
Chorus MUST validate every non-empty cwd draft before committing the Project
form. A validation failure MUST block the complete Project mutation, preserve
all form values, and render an actionable error beside the affected Agent cwd
control.

#### Scenario: Selected cwd becomes stale before save
- **WHEN** a validation request expires or its target is stale before the user submits the Project form
- **THEN** Chorus MUST leave Project metadata and cwd preferences unchanged
- **AND** the form MUST remain open with its drafts intact
- **AND** the affected Agent cwd editor MUST display the validation error

#### Scenario: Project form has no cwd value
- **WHEN** an Agent has neither a saved preference nor a selected cwd draft
- **THEN** the Project form MUST allow submission without cwd validation for that Agent
