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
Project settings SHALL include an Agent working-directory section that shows each Agent's fixed path, host, and validity state and supports selecting, explicitly saving, replacing, and clearing the preference. Selection SHALL choose an online Agent instance/host before browsing that daemon's allowed directories.

#### Scenario: User saves a discovered cwd
- **WHEN** the user chooses an online host, browses to an allowed directory, and confirms Save
- **THEN** Chorus MUST freshly validate the directory on that daemon and persist the preference only after validation succeeds

#### Scenario: Fixed cwd becomes unavailable
- **WHEN** the stored host is offline or the directory no longer validates
- **THEN** project settings MUST show a distinguishable invalid/offline state and offer replace or clear actions

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
