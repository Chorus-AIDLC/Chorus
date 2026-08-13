# project-agent-cwd Specification

## Purpose
TBD - created by archiving change add-project-agent-cwd-discovery. Update Purpose after archive.
## Requirements
### Requirement: Per-user project-Agent cwd preferences
Chorus SHALL let each user persist at most one fixed cwd for each `(project, Agent)` pair, including the target host and normalized path. One project MAY hold independent fixed cwd preferences for multiple Agents, and one user's preferences MUST NOT affect another user.

#### Scenario: User fixes cwd for two Agents
- **WHEN** a user saves different valid paths for Agent A and Agent B in one project
- **THEN** both preferences MUST coexist and resolve independently

#### Scenario: Another user opens the same project
- **WHEN** a second user has no preference for the same project and Agent
- **THEN** the second user MUST retain the unconfigured behavior

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
- **THEN** project settings MUST prefill that root with its trailing platform separator without requiring the user to guess or type it

#### Scenario: Host exposes multiple browse roots
- **WHEN** the selected daemon returns multiple effective browse roots
- **THEN** project settings MUST select the first returned root by default
- **AND** it MUST provide an explicit control for switching to another returned root
- **AND** the path input MUST include the selected root's trailing platform separator

#### Scenario: Browse roots are unavailable
- **WHEN** the roots request fails, returns no usable roots, or targets an older daemon without roots support
- **THEN** the directory picker MUST fall back to an editable manual path
- **AND** the user MUST still be able to validate and confirm that path without autocomplete

#### Scenario: Fixed cwd becomes unavailable
- **WHEN** the stored host is offline or the directory no longer validates
- **THEN** project settings MUST show a distinguishable invalid or offline state and offer replace or clear actions

### Requirement: Fixed cwd is sticky until cleared
A valid fixed project-Agent cwd SHALL be the authoritative cwd for that user's project workflows across all instances of that Agent. Those workflows MUST NOT prompt for or accept an inline temporary override while the preference exists. Clearing the preference SHALL restore temporary or existing instance selection.

#### Scenario: Fixed Agent is selected in a project workflow
- **WHEN** a project operation selects an Agent with a valid fixed cwd
- **THEN** the operation MUST use that host and cwd without asking the user to select an instance

#### Scenario: User wants another cwd
- **WHEN** a fixed preference exists and the user needs a different cwd
- **THEN** the user MUST clear or replace the preference in project settings before choosing a temporary cwd

#### Scenario: No fixed preference exists
- **WHEN** a project operation selects an Agent without a fixed cwd
- **THEN** existing temporary instance selection and auto-selection behavior MUST remain available
- **AND** the picker MUST offer browsing another allowed directory on an online host for this operation

#### Scenario: User chooses a temporary discovered cwd
- **WHEN** no fixed preference exists and the user browses to an allowed unregistered directory from an operation's temporary picker
- **THEN** Chorus MUST freshly validate and use that runtime cwd for only the current operation
- **AND** it MUST NOT persist a project preference or fabricate a registered Agent instance

### Requirement: Directed execution in a discovered cwd
Chorus SHALL execute work in a valid fixed or temporary discovered cwd through an online connection for the selected Agent and host without requiring that path to be a startup connection. The daemon MUST validate the runtime cwd immediately before spawn, and transcript probe, spawn, resume, and subsequent session turns MUST use the same persisted runtime cwd.

#### Scenario: Discovered path is not a startup cwd
- **WHEN** a valid project preference names an allowed directory with no registered startup connection
- **THEN** the selected host daemon MUST run the work in that directory without adding it to `daemon.json` or startup `cwds`

#### Scenario: Host is offline at wake time
- **WHEN** the fixed cwd's host has no online connection when work is triggered
- **THEN** the operation MUST fail with a distinguishable offline state and MUST NOT reroute to another host or cwd

#### Scenario: Session continues after initial wake
- **WHEN** a directed runtime-cwd session receives another turn or resumes
- **THEN** it MUST use the same persisted runtime cwd and origin connection as the initial execution

### Requirement: Backward-compatible cwd resolution
Projects without a fixed preference and sessions without a runtime cwd SHALL preserve existing Agent-instance assignment, wake preview, auto-pin, transcript, and spawn behavior.

#### Scenario: Existing project has no preferences
- **WHEN** the feature is deployed for an existing project
- **THEN** its wake and assignment behavior MUST remain unchanged until a user saves a preference

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
- **AND** keyboard navigation MUST scroll the highlighted candidate into the listbox viewport

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

#### Scenario: Project settings presents and reflects the combined save
- **WHEN** a user edits cwd settings in the Project settings dialog
- **THEN** the single Save Changes action MUST appear after the cwd configuration area
- **AND** a successful save MUST refresh the Project fixed-cwd summary without requiring a page reload

#### Scenario: User selects a directory inside the form
- **WHEN** a user selects or enters a cwd inside the Project form
- **THEN** Chorus MUST keep that cwd as a local draft without showing a separate cwd confirmation action
- **AND** the Project create or save action MUST validate and normalize the draft before persisting it

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

#### Scenario: User types a nonexistent cwd
- **WHEN** a user edits the Project cwd input to a non-empty path that is not an autocomplete candidate
- **THEN** Chorus MUST treat the typed value as a cwd draft and validate it during the Project create or save action
- **AND** a failed validation MUST prevent the Project request while preserving the typed value and displaying the error

#### Scenario: Project form has no cwd value
- **WHEN** an Agent has neither a saved preference nor a selected cwd draft
- **THEN** the Project form MUST allow submission without cwd validation for that Agent

### Requirement: Project overview cwd summary identifies each Agent
The project overview cwd summary SHALL make each configured Agent's cwd badge visually attributable to a specific Agent without hovering. Each badge SHALL show a colored Agent identity dot together with the visible Agent name as the primary label, and SHALL move the full cwd path into the badge's hover tooltip. The identity dot SHALL derive its color from the app's shared deterministic per-Agent color helper (a stable hash of the Agent name into a fixed palette chosen to read on both light and dark backgrounds) rather than introducing a new color scheme or reusing the status-colored presence dot, and SHALL render correctly in both themes. This change SHALL remain frontend-only over the existing `GET /api/projects/[uuid]/agent-cwds` data (which already returns the Agent name and host); it SHALL NOT change that API, its service, the database schema, add a migration, or add a new permission bit. Every user-facing string SHALL resolve from the locale catalog in both supported locales.

#### Scenario: Two Agents' badges are distinguishable at a glance
- **WHEN** a project has fixed cwd preferences for two different Agents whose cwds share a long common path prefix
- **THEN** each badge MUST display that Agent's identity color dot and visible name
- **AND** the two badges MUST be distinguishable without hovering either one

#### Scenario: The cwd path is available on hover
- **WHEN** a user hovers a cwd badge in the overview summary
- **THEN** the badge's tooltip MUST show the full cwd path for that Agent

#### Scenario: The identity dot uses the shared deterministic per-Agent color
- **WHEN** the overview summary renders an Agent's cwd badge
- **THEN** the badge's identity dot MUST take its color from the shared deterministic per-Agent color helper (same Agent → same color) rather than the status-colored presence dot
- **AND** the dot MUST render legibly in both the light and dark themes

#### Scenario: No backend change is introduced
- **WHEN** the badge change is implemented
- **THEN** it MUST read the existing `GET /api/projects/[uuid]/agent-cwds` response without modifying that API or its service
- **AND** it MUST NOT change the database schema, add a migration, or add a new permission bit

