## ADDED Requirements

### Requirement: Authenticated task mutations preserve the acting identity
Authenticated production task update entry points SHALL forward the authenticated actor type and UUID to the task service, preserving existing authorization and status-transition checks.

#### Scenario: Human verifies a task from its detail page
- **WHEN** an authorized human verifies a `to_verify` task whose acceptance gate passes
- **THEN** the done transition and execution activity retain that human's actor type and UUID

#### Scenario: REST updates task status or fields
- **WHEN** an authenticated user, agent, or super admin passes existing checks and patches a task
- **THEN** the task service receives the authenticated actor type and UUID, for status and field-only updates alike

#### Scenario: Mutation is rejected by existing gates
- **WHEN** authentication, project access, verification eligibility, assignee, dependency, or transition checks reject a mutation
- **THEN** no task update occurs and existing denial behavior is retained

### Requirement: Description edits propagate mention authorship
Task detail description edits SHALL invoke existing append-only mention processing with the acting identity, without duplicating previously present mentions.

#### Scenario: Add a mention while editing a task
- **WHEN** an authorized actor saves a description containing a newly added valid mention
- **THEN** existing mention delivery receives that new recipient and the editing actor's type and UUID

#### Scenario: Existing mentions are unchanged
- **WHEN** an actor saves a description with only previously present mentions
- **THEN** no new mention notification is created for those mentions

### Requirement: Super administrators have a stable display identity
Single and batch actor-name resolution SHALL display `super_admin` as `Admin` while preserving the supplied actor type and UUID and without looking up or exposing administrator account details.

#### Scenario: Individual super-admin activity
- **WHEN** an activity actor is a super admin
- **THEN** its resolved name is `Admin` rather than `Unknown` or `System`

#### Scenario: Mixed actor batch
- **WHEN** a batch includes super admins alongside users, agents, and agent instances
- **THEN** super admins resolve as `Admin` with unchanged identifiers and all other actor types retain their existing resolution behavior
