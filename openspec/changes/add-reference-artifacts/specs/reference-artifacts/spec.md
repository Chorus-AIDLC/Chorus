## ADDED Requirements

### Requirement: The system SHALL store reference artifacts as a first-class company-scoped entity

The system SHALL persist a `ReferenceArtifact` as a first-class entity identified by a public `uuid`, scoped to a `companyUuid`, carrying a reference `type`, a `url`, a `title`, optional `notes`, and creator attribution (`createdByType`, `createdByUuid`). Reference artifacts MUST NOT expose a database serial id. All queries MUST be scoped by `companyUuid` so no artifact is ever returned across a company boundary.

#### Scenario: A reference artifact is created with a public UUID

- **WHEN** a reference artifact is created with a valid type, url, title, and target
- **THEN** the stored record MUST have a unique public `uuid`, MUST record `companyUuid`, and the returned representation MUST NOT contain the internal serial id

#### Scenario: Reference artifacts are isolated per company

- **GIVEN** a reference artifact belonging to company A
- **WHEN** a caller authenticated to company B lists or fetches references
- **THEN** company A's artifact MUST NOT be returned

### Requirement: A reference artifact SHALL link to exactly one proposal or task

The system SHALL attach each reference artifact to exactly one target identified by `targetType` and `targetUuid`, where `targetType` MUST be either `proposal` or `task`. The system SHALL NOT permit linking a reference artifact to an acceptance criterion or any other entity type in this version. On creation the system SHALL verify the target exists within the same company and MUST reject the creation when it does not.

#### Scenario: Reference is attached to a proposal

- **WHEN** a reference artifact is created with `targetType` `proposal` and a `targetUuid` of an existing proposal in the same company
- **THEN** the artifact MUST be persisted linked to that proposal and appear when references for that proposal are listed

#### Scenario: Reference is attached to a task

- **WHEN** a reference artifact is created with `targetType` `task` and a `targetUuid` of an existing task in the same company
- **THEN** the artifact MUST be persisted linked to that task and appear when references for that task are listed

#### Scenario: Linking to a non-existent target is rejected

- **WHEN** a reference artifact is created with a `targetUuid` that does not resolve to a proposal or task in the caller's company
- **THEN** the creation MUST be rejected with a not-found error and no artifact MUST be persisted

#### Scenario: Unsupported target type is rejected

- **WHEN** a reference artifact is created with a `targetType` other than `proposal` or `task` (for example `acceptance_criterion`)
- **THEN** the creation MUST be rejected and no artifact MUST be persisted

### Requirement: A reference artifact SHALL be one of four supported web-link types

The system SHALL constrain a reference artifact's `type` to one of `docs` (official documentation), `repo` (GitHub reference implementation), `issue_pr` (issue or pull-request thread), or `paper_blog` (paper or blog post). The system SHALL reject any other type value. The system SHALL require the `url` to be a non-blank web URL beginning with `http://` or `https://`, and SHALL NOT accept local-file references in this version.

#### Scenario: A supported type and web URL are accepted

- **WHEN** a reference artifact is created with type `repo` and an `https://` url
- **THEN** the artifact MUST be persisted with that type and url

#### Scenario: An unsupported type is rejected

- **WHEN** a reference artifact is created with a type outside the four supported values
- **THEN** the creation MUST be rejected and no artifact MUST be persisted

#### Scenario: A non-web url is rejected

- **WHEN** a reference artifact is created with a `file://` url or a blank url
- **THEN** the creation MUST be rejected and no artifact MUST be persisted

### Requirement: The system SHALL capture only the URL and notes, without fetching content

The system SHALL store the reference `url` together with an optional human- or agent-authored `notes` summary, and SHALL NOT fetch, download, or snapshot the referenced content at capture time or on read. The stored artifact represents a pointer plus a summary, not a copy of the external material.

#### Scenario: Notes are stored verbatim and no fetch occurs

- **WHEN** a reference artifact is created with `notes`
- **THEN** the `notes` MUST be stored and returned as written, and the system MUST NOT perform any network fetch of the `url`

### Requirement: The system SHALL expose create, read, update, and delete over REST and MCP

The system SHALL provide a REST surface — `GET`/`POST /api/references` and `GET`/`PATCH`/`DELETE /api/references/{uuid}` — and the mutation MCP tools `chorus_add_reference`, `chorus_update_reference`, and `chorus_remove_reference`. Read operations SHALL be gated for agents by `document:read` and mutations by `document:write`, reusing the existing `document` permission resource without introducing a new permission bit. The system SHALL NOT provide a standalone reference-listing MCP tool; agent read access is served inline through the `references` array on the `chorus_get_proposal` and `chorus_get_task` payloads (see the inline-retrieval requirement). Both human sessions and agent API keys SHALL be able to create and link reference artifacts.

#### Scenario: An agent without document:write cannot mutate references

- **GIVEN** an agent API key whose effective permissions do not include `document:write`
- **WHEN** it attempts to create, update, or delete a reference artifact
- **THEN** the mutation MUST be denied and the write MCP tools MUST NOT be exposed to that agent

#### Scenario: A human session creates a reference via the UI

- **WHEN** an authenticated human user submits the add-reference form on a proposal or task
- **THEN** a reference artifact MUST be created with `createdByType` `user` and linked to that entity

#### Scenario: An agent creates a reference via MCP

- **WHEN** an agent with `document:write` calls `chorus_add_reference` for an existing proposal or task
- **THEN** a reference artifact MUST be created with `createdByType` `agent` and linked to that entity

#### Scenario: A reference is updated and deleted

- **GIVEN** an existing reference artifact
- **WHEN** an authorized caller updates its title or notes, then deletes it
- **THEN** the update MUST be reflected on subsequent reads, and after deletion the artifact MUST NOT be returned by list or fetch

### Requirement: Linked reference artifacts SHALL be surfaced inline for review

The system SHALL surface a proposal's or task's linked reference artifacts inline: the `chorus_get_proposal` and `chorus_get_task` MCP responses SHALL include a `references` array for the entity, and the proposal detail and task detail views SHALL render the linked references read-only alongside the entity's content so a reviewer can check claims against evidence without a separate lookup. This version SHALL NOT provide per-claim groundedness marks nor automatic flagging of unsupported claims.

#### Scenario: References appear in the proposal payload

- **GIVEN** a proposal with two linked reference artifacts
- **WHEN** `chorus_get_proposal` is called for it
- **THEN** the response MUST include both artifacts in a `references` array

#### Scenario: References render read-only on the task detail view

- **GIVEN** a task with linked reference artifacts
- **WHEN** a reviewer opens the task detail view
- **THEN** the linked references MUST be displayed with their type, title, link, and notes, and the view MUST NOT present groundedness marking or auto-flagging controls
