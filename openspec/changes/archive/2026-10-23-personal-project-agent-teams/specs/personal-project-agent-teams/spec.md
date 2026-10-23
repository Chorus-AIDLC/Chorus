## ADDED Requirements

### Requirement: Private per-user project configuration
The system SHALL store independent Team configurations keyed by project and user, enforcing tenant and project visibility. Only the human owner SHALL write their configuration; only that user and their owned agents with project access SHALL read it. Administrators MUST NOT bypass personal ownership. Viewer access SHALL suffice for personal configuration, but Idea handoff SHALL require editor and applicable assignment authority.

#### Scenario: Shared project is not shared team
- **WHEN** two users or their agents access the same project
- **THEN** each sees only their own personal Team, and a guessed foreign configuration cannot be read or mutated

#### Scenario: Viewer configures without assigning
- **WHEN** a project viewer saves a personal Team and attempts handoff
- **THEN** configuration succeeds when its members qualify, and handoff is rejected without assignment changes

### Requirement: Whole-role inheritance and empty fallback
The system SHALL reuse four existing roles, support multiple own agents and multi-role membership, inherit unoverridden roles from the current template and replace overridden roles wholesale. Empty overrides SHALL differ from inheritance. All roles MAY be empty and the system MUST preserve the manual workflow without implicit assignments or authority grants.

#### Scenario: Restore inheritance
- **WHEN** an owner overrides a role to empty, the template changes, and the owner later restores inheritance
- **THEN** the override stays empty until reset, then reflects the latest template memberships

#### Scenario: Empty lead
- **WHEN** a Team without an eligible lead is applied or later gains one
- **THEN** saving is allowed but no Idea owner changes without explicit lead selection and confirmed handoff

### Requirement: Eligibility and template lifecycle
New memberships SHALL require same-company personal ownership, role minimum permissions and collaboration access to the project. Reads SHALL recompute drift and retain ineligible members with explanations without selecting them for new handoffs. Template deletion SHALL atomically freeze current effective memberships; unbinding SHALL NOT revert assignments.

#### Scenario: Permission drift
- **WHEN** a bound agent loses a required permission or project access
- **THEN** it is marked ineligible, existing Idea owners remain unchanged, and handoff cannot select it

#### Scenario: Delete latest template
- **WHEN** a template is edited then deleted before the next project read
- **THEN** the project's last effective template memberships plus role overrides are frozen, still subject to current eligibility and agent existence

#### Scenario: Previous lead removed from template
- **WHEN** a confirmed handoff recipient A is replaced by B in the inherited lead role
- **THEN** existing Ideas stay with A and tasks stay unchanged; the personal Team read and UI SHALL expose a warning identifying the previous recipient as no longer a valid lead even if B is eligible, with only permission-checked explicit repair

### Requirement: Scoped confirmed Idea handoff
The system SHALL preview and confirm handoff to one explicit eligible lead, only for unfinished project Ideas currently assigned to the user or their owned agents/instances. It MUST exclude unassigned, foreign and derived-done Ideas, ignore creator identity, reject stale/tampered confirmation without partial writes, preserve lifecycle and Task execution, honor project CWD pinning and record standard assignment provenance/notifications.

#### Scenario: Own assignment not own creation
- **WHEN** a user confirms a preview containing an unfinished Idea created by someone else but assigned to their agent
- **THEN** that Idea is handed off while foreign-assigned and unassigned Ideas remain untouched

#### Scenario: Preview races with another change
- **WHEN** a candidate is reassigned/completed, a lead loses eligibility, or effective Team membership changes after preview
- **THEN** confirmation conflicts and no candidate is reassigned until a fresh preview is confirmed

#### Scenario: Preserve ongoing work
- **WHEN** a confirmed handoff changes a building Idea's assignee
- **THEN** its stage, elaboration, proposals and task assignments/status/sessions are preserved and ordinary assignment wake occurs only for an actual logical assignee change

### Requirement: Private agent context and accessible UI
Checkin SHALL add personal Team context for active/request-scoped projects without altering active-project counts; a read-only project Team MCP tool SHALL expose current roles/members, eligibility and online/load using the calling agent's owner. UI SHALL expose personal configuration to project viewers, role overrides/reset, frozen and empty states, explicit handoff preview, localized light/dark accessible controls and retained edits on error. Documentation and skill instructions SHALL describe these boundaries.

#### Scenario: Owner-scoped agent discovery
- **WHEN** an agent calls checkin or project Team read
- **THEN** only its owner's accessible project Team and the caller's eligible roles appear, with no new permissions and no other owner's template metadata

#### Scenario: Localized recoverable configuration
- **WHEN** a user edits a Team in either theme or a save fails
- **THEN** role and privacy guidance are localized, controls remain keyboard accessible and failed-save input is retained
