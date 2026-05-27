# create-report-force Specification

## Purpose
TBD - created by archiving change create-report-force-flag. Update Purpose after archive.
## Requirements
### Requirement: `chorus_create_report` SHALL reject duplicate calls per proposal by default

The `chorus_create_report` MCP tool MUST accept an optional `force` boolean input field defaulting to `false`. When `force` is `false` (or omitted) and the target Proposal already has at least one `Document` with `type="report"` linked to it, the tool MUST return an MCP error result and MUST NOT create a new Document. The error result MUST set `isError: true` and the first text content MUST clearly indicate two things: (a) a report already exists for this proposal, and (b) `force=true` is the way to bypass the rejection. The exact wording is left to the implementation; the contract is on the two pieces of information being conveyed. When `force` is `true`, the tool MUST behave as it does today — create a new `type="report"` Document under the Proposal regardless of any pre-existing report Documents — preserving the current "multiple reports per proposal allowed" semantics for the explicit-opt-in case. The two pre-existing failure branches (`Proposal not found`, `Proposal status must be 'approved'`) MUST run before any duplicate check; they short-circuit independently of `force`.

#### Scenario: First report on an approved proposal succeeds with default force

- **GIVEN** an approved Proposal `P` with no `type="report"` Documents linked to it
- **WHEN** an authenticated agent with `document:write` calls `chorus_create_report` with `proposalUuid = P.uuid`, a non-empty `title`, a non-empty Markdown `content`, and `force` omitted
- **THEN** the tool MUST persist exactly one new `Document` with `type = "report"` and `proposalUuid = P.uuid`
- **AND** the tool MUST return a success response carrying the new `documentUuid`, `projectUuid = P.projectUuid`, and `version`
- **AND** `isError` MUST NOT be set on the response

#### Scenario: Second report on the same proposal is rejected with a duplicate-report error when force is omitted

- **GIVEN** an approved Proposal `P` that already has exactly one `Document` with `type = "report"` and `proposalUuid = P.uuid`
- **WHEN** an authenticated agent with `document:write` calls `chorus_create_report` with `proposalUuid = P.uuid`, a non-empty `title`, a non-empty Markdown `content`, and `force` omitted
- **THEN** the tool MUST NOT create any new `Document` row
- **AND** the tool MUST return a response with `isError = true` whose first text content mentions both that a report already exists and that `force` is the parameter to bypass the rejection
- **AND** no SSE event and no `report_created` Notification MUST be emitted by this rejected call

#### Scenario: Second report on the same proposal is rejected when force is explicitly false

- **GIVEN** an approved Proposal `P` that already has at least one `Document` with `type = "report"` and `proposalUuid = P.uuid`
- **WHEN** an authenticated agent calls `chorus_create_report` with `proposalUuid = P.uuid`, valid `title` and `content`, and `force = false`
- **THEN** the tool MUST behave identically to the omitted-force case — no Document is created and the response carries the same kind of duplicate-rejection error under `isError = true`

#### Scenario: Second report succeeds when force is explicitly true

- **GIVEN** an approved Proposal `P` that already has at least one `Document` with `type = "report"` and `proposalUuid = P.uuid`
- **WHEN** an authenticated agent with `document:write` calls `chorus_create_report` with `proposalUuid = P.uuid`, valid `title` and `content`, and `force = true`
- **THEN** the tool MUST persist a new `Document` with `type = "report"` and `proposalUuid = P.uuid` whose `documentUuid` differs from any existing report under `P`
- **AND** the tool MUST return a success response carrying the new `documentUuid`, `projectUuid = P.projectUuid`, and `version`
- **AND** the existing report-realtime fan-out (document/created event, idea/updated event when idea-rooted, and `report_created` Activity / Notification) MUST fire for this newly-created Document, identical to a first-report call

#### Scenario: Force flag does not relax the proposal-status precondition

- **GIVEN** a Proposal `P` whose `status` is one of `draft`, `pending`, `rejected`, or `closed`
- **WHEN** an authenticated agent calls `chorus_create_report` with `proposalUuid = P.uuid`, valid `title` and `content`, and `force = true`
- **THEN** the tool MUST return an error response containing the existing status-rejection message (mentioning the actual status) and MUST NOT create any Document
- **AND** the duplicate-report check MUST NOT run (the status check short-circuits first)

#### Scenario: Force flag does not relax the proposal-not-found precondition

- **GIVEN** a `proposalUuid` that does not resolve to a Proposal in the calling agent's company
- **WHEN** an authenticated agent calls `chorus_create_report` with that `proposalUuid`, valid `title` and `content`, and `force = true`
- **THEN** the tool MUST return an error response containing `Proposal not found` and MUST NOT create any Document
- **AND** the duplicate-report check MUST NOT run

#### Scenario: Force flag does not relax the document:write permission gate

- **GIVEN** an authenticated agent whose effective permission set does not include `document:write`
- **WHEN** that agent attempts to call `chorus_create_report` with any combination of `proposalUuid`, `title`, `content`, and `force`
- **THEN** the tool MUST NOT be registered against this agent's MCP server instance — the call surfaces as `Method not found` (the existing permission-map gating contract)
- **AND** no Document is created and no error message about duplicates is leaked

