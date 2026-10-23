# agent-team-templates Specification

## Purpose
Allow users to manage private reusable agent responsibility templates while preserving tenant, ownership and effective-permission boundaries.

## Requirements

### Requirement: Private template ownership
The system SHALL expose template CRUD only to authenticated human creators within their company. It MUST NOT grant Workspace Admin or agent-key callers access to another user's templates. Only agents owned by the same creator in the same company SHALL be eligible candidates.

#### Scenario: Private reads and writes
- **WHEN** another user or tenant requests an existing template UUID
- **THEN** reads, updates and deletes return not found and lists omit that template

#### Scenario: Foreign candidate and machine callers
- **WHEN** a creator submits a foreign agent UUID or an agent API key calls template APIs
- **THEN** the foreign binding is rejected without foreign metadata and the agent-key request is forbidden

### Requirement: Fixed roles and persistent CRUD
The system SHALL persist named templates with four roles (product, development, review, lead), zero or more members per role, and agents reusable across roles. Names MUST be trimmed and nonempty with maximum 100 characters, descriptions at most 1000 characters, and writes at most 200 memberships. Invalid/duplicate tuples, unknown roles/fields and malformed inputs MUST be rejected without partial writes.

#### Scenario: Empty and multi-role templates
- **WHEN** the creator saves an empty template or assigns several agents and reuses one agent in another role
- **THEN** reload preserves the template and its exact memberships, with all four role groups displayed

#### Scenario: Atomic replacement and deletion
- **WHEN** the creator edits memberships, submits an invalid member, or deletes a template
- **THEN** valid replacements are atomic, invalid writes preserve prior data, and deletion removes memberships without deleting agents

### Requirement: Minimum permissions without grants
Each role SHALL require all five resource read bits. Product additionally requires idea:write, proposal:write and document:write; development requires task:write; review has no additional bits; lead requires idea:write, idea:admin, proposal:write, proposal:admin, task:write, task:admin and document:write. The system MUST compute effective permissions from presets plus custom bits, reject newly added ineligible role bindings with missing-bit details, and never grant permissions or project access.

#### Scenario: Missing role authority
- **WHEN** an own agent lacks required permission bits for a newly selected role
- **THEN** the UI explains the missing bits and the server rejects a forged binding with the same missing bits

#### Scenario: Eligibility does not grant authority
- **WHEN** an eligible reviewer is added to a template
- **THEN** its permissions and project grants are unchanged and UI explains that eligibility does not grant project access

### Requirement: Permission drift and lifecycle
The system SHALL retain downgraded members and recompute eligibility on every template read. Unchanged invalid bindings MUST remain saveable, but removed invalid bindings MUST NOT be newly re-added. Agent deletion SHALL remove its role bindings without removing templates.

#### Scenario: Downgrade and repair
- **WHEN** a bound agent loses a required bit and the creator reloads or edits the template
- **THEN** the member remains flagged with missing bits; renaming and removing members succeed, and adding a new invalid tuple fails

#### Scenario: Deleted agent
- **WHEN** an agent is deleted through the existing service
- **THEN** its memberships disappear and the template remains usable, including empty roles

### Requirement: Accessible localized Settings management
Settings SHALL provide a discoverable Teams page with create/edit/delete, confirmations, four role groups, multi-selection and eligibility explanations. It MUST support English/Chinese and light/dark themes with accessible controls, loading/empty/error states, and preserve input on failed saves. The design file SHALL include both theme frames.

#### Scenario: End-to-end management
- **WHEN** the creator navigates from Settings, creates/edits a template and reloads
- **THEN** persisted values and role memberships render correctly in both themes, and deleting requires confirmation

#### Scenario: Failure recovery
- **WHEN** loading or saving fails, or no own agents exist
- **THEN** the UI shows a clear localized state, retains unsaved input on save failure, and offers retry or relevant navigation

#### Scenario: Shared assignment selection and compact roles
- **WHEN** the creator configures role memberships
- **THEN** Teams and task/idea assignment use the same avatar-based AgentSelect component with keyboard navigation and name typeahead; each role displays selected-member chips with labeled removal controls and an add-agent dropdown, not an expanded list of all candidates
- **AND** permission requirements are collapsed until requested, ineligible options explain missing permissions, existing invalid members remain visible, and role cards stack on narrow screens with a reachable pinned save footer
