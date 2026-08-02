## MODIFIED Requirements

### Requirement: Project settings is the management surface
Project settings SHALL include an Agent working-directory section that shows
each Agent's fixed path, host, and validity state and supports selecting,
explicitly saving, replacing, and clearing the preference. Selection SHALL
choose an online Agent instance or host before requesting that daemon's
effective browse roots. A single root SHALL be prefilled; when multiple roots
exist, the first daemon-provided root SHALL be selected by default and the user
MUST be able to switch roots.

#### Scenario: User saves a discovered cwd
- **WHEN** the user chooses an online host, completes an allowed directory path, and confirms Save
- **THEN** Chorus MUST freshly validate the directory on that daemon and persist the preference only after validation succeeds

#### Scenario: Host exposes one browse root
- **WHEN** the selected daemon returns exactly one effective browse root
- **THEN** project settings MUST prefill that root without requiring the user to guess or type it

#### Scenario: Host exposes multiple browse roots
- **WHEN** the selected daemon returns multiple effective browse roots
- **THEN** project settings MUST select the first returned root by default
- **AND** it MUST provide an explicit control for switching to another returned root

#### Scenario: Fixed cwd becomes unavailable
- **WHEN** the stored host is offline or the directory no longer validates
- **THEN** project settings MUST show a distinguishable invalid or offline state and offer replace or clear actions

## ADDED Requirements

### Requirement: Shared cwd path autocomplete
Project fixed-cwd settings and one-operation temporary cwd selection SHALL use
one shared root-aware path autocomplete behavior. After the user types the first
basename character, the client MUST debounce list requests by 250 ms, cancel
obsolete client work where supported, and discard any response whose
connection, root, prefix, or request generation is no longer current. Loading,
empty, offline, timeout, invalid, outside-root, access-denied, stale-target,
limit, and internal states MUST remain distinguishable.

#### Scenario: User types and deletes quickly
- **WHEN** multiple prefixes are produced before earlier requests finish
- **THEN** only the newest prefix result or error MUST be rendered
- **AND** obsolete results MUST NOT flash back into the candidate list

#### Scenario: Candidates become available
- **WHEN** a bounded candidate page is returned for the current prefix
- **THEN** the first candidate MUST be highlighted by default
- **AND** arrow keys MUST move the highlight, `Tab` MUST accept the highlighted candidate, `Enter` MUST select it, and `Escape` MUST close the list

#### Scenario: No candidate is highlighted
- **WHEN** the candidate list is closed or empty
- **THEN** `Tab` MUST preserve normal focus navigation

#### Scenario: User selects a candidate
- **WHEN** a user selects the highlighted or tapped candidate
- **THEN** the full path MUST update to that directory
- **AND** the user MUST be able to type the next basename character or navigate back to the parent without leaving the selected root

#### Scenario: User composes text with an IME
- **WHEN** a keyboard event occurs during active IME composition
- **THEN** the event MUST NOT accidentally accept or validate a directory

#### Scenario: Temporary cwd picker consumes autocomplete
- **WHEN** a user browses another directory for one operation
- **THEN** the temporary picker MUST expose the same root, candidate, keyboard, mobile, loading, empty, error, and race behavior as project settings
- **AND** only the final action MUST differ by using the validation for one operation instead of saving a preference
