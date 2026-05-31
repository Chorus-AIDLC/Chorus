## ADDED Requirements

### Requirement: `chorus_get_proposal` SHALL accept a `section` parameter selecting one view

The `chorus_get_proposal` MCP tool SHALL accept an optional `section` parameter whose
value is one of `basic`, `documents`, `tasks`, or `full`. The parameter selects which
slice of the proposal is returned. No new MCP tool SHALL be added to provide these views —
all four are served by `chorus_get_proposal`. Every response SHALL carry a `section` field
echoing the effective view so the caller can tell which slice it received.

#### Scenario: `section: "documents"` returns full document drafts only

- **GIVEN** a proposal with at least one document draft and at least one task draft
- **WHEN** an agent calls `chorus_get_proposal({ proposalUuid, section: "documents" })`
- **THEN** the response MUST include the full `documentDrafts` array, each entry carrying
  its complete `content`
- **AND** the response MUST NOT include a populated `taskDrafts` array of full task drafts
- **AND** the response MUST include `section: "documents"`
- **AND** the response MUST include the proposal metadata (uuid, title, status)

#### Scenario: `section: "tasks"` returns full task drafts only

- **WHEN** an agent calls `chorus_get_proposal({ proposalUuid, section: "tasks" })`
- **THEN** the response MUST include the full `taskDrafts` array, each entry carrying its
  `description` and acceptance criteria
- **AND** the response MUST NOT include a populated `documentDrafts` array of full drafts
- **AND** the response MUST include `section: "tasks"`

#### Scenario: `section: "full"` returns the original complete payload

- **WHEN** an agent calls `chorus_get_proposal({ proposalUuid, section: "full" })`
- **THEN** the response MUST contain both the full `documentDrafts` and the full
  `taskDrafts` arrays, identical in shape to the payload the tool returned before this
  change (plus the `section: "full"` discriminator)

#### Scenario: An unknown `section` value is rejected

- **WHEN** an agent calls `chorus_get_proposal` with a `section` value outside the
  enumerated set (e.g. `section: "everything"`)
- **THEN** the tool MUST reject the call via input-schema validation rather than returning
  an arbitrary slice

#### Scenario: A missing proposal is reported the same way for every section

- **GIVEN** a `proposalUuid` that does not exist in the caller's company
- **WHEN** an agent calls `chorus_get_proposal` with any `section` value (or none)
- **THEN** the tool MUST return its standard not-found error result
- **AND** the tool MUST NOT return a partial or empty slice as if the proposal existed

### Requirement: `chorus_get_proposal` SHALL default to a lightweight basic index

When `section` is omitted, `chorus_get_proposal` SHALL behave as if `section: "basic"`
were passed. The `basic` view SHALL return proposal metadata plus a lightweight index of
the document and task drafts, and SHALL NOT return the heavy `content` of document drafts
or the full `description` / acceptance-criteria text of task drafts. This default is the
payload-reduction behavior the tool exists to provide.

#### Scenario: Omitting `section` returns the basic index, not full content

- **GIVEN** a proposal whose document drafts contain multi-thousand-character `content`
- **WHEN** an agent calls `chorus_get_proposal({ proposalUuid })` with no `section`
- **THEN** the response MUST include `section: "basic"`
- **AND** the response MUST include a document-draft index where each entry carries
  `uuid`, `type`, `title`, and `contentLength`, but NOT the document `content`
- **AND** the response MUST include a task-draft index where each entry carries `uuid`,
  `title`, `priority`, `storyPoints`, `acceptanceCriteriaCount`, and
  `dependsOnDraftUuids`, but NOT the full task `description` or criteria text
- **AND** the serialized basic response MUST be smaller than the `section: "full"`
  response for the same proposal

#### Scenario: The basic index preserves UUIDs and the dependency structure

- **GIVEN** a proposal whose task drafts form a dependency chain (task B depends on task A)
- **WHEN** an agent calls `chorus_get_proposal({ proposalUuid })` with no `section`
- **THEN** each task-draft index entry MUST expose its draft `uuid`
- **AND** task B's index entry MUST list task A's draft uuid in `dependsOnDraftUuids`
- **AND** each document-draft index entry MUST expose its draft `uuid`
- **AND** an agent MUST be able to use those uuids to drill into `section: "documents"`
  or `section: "tasks"` on the same `proposalUuid`

### Requirement: The section parameter SHALL NOT alter the proposal REST contract

Adding the `section` parameter to the MCP tool SHALL NOT change the response shape of the
REST route `GET /api/proposals/[uuid]`. The frontend proposal-detail view SHALL continue
to receive the complete proposal, including full document and task drafts.

#### Scenario: REST proposal detail still returns the full proposal

- **WHEN** the frontend requests `GET /api/proposals/<uuid>`
- **THEN** the response MUST contain the full `documentDrafts` (with `content`) and full
  `taskDrafts`, exactly as before this change
- **AND** the REST response MUST NOT be reduced to the basic index
