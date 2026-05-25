# mcp-tool-surface delta — add `chorus_create_report`

## ADDED Requirements

### Requirement: The Chorus MCP server SHALL expose `chorus_create_report`

The MCP tool `chorus_create_report` MUST be registered in the public-namespaced tool surface (no `pm_` prefix) and gated on the `document:write` permission bit. Its input schema MUST accept `proposalUuid` (string, UUID), `title` (string, 1-200 chars), and `content` (string, non-empty); it MUST NOT accept a `type` parameter, since the type label `"report"` is encoded by the tool name and written unconditionally by the service. On success the tool MUST return `documentUuid`, `projectUuid`, and `version`.

#### Scenario: Listing tools surfaces `chorus_create_report` for an agent with `document:write`

- **GIVEN** an agent whose effective permission set contains `document:write`
- **WHEN** the agent calls `tools/list` against `/api/mcp`
- **THEN** the response MUST include a tool whose `name` field equals `chorus_create_report`
- **AND** the tool's input schema MUST require `proposalUuid`, `title`, and `content`
- **AND** the tool's input schema MUST NOT include a `type` parameter

#### Scenario: Listing tools omits `chorus_create_report` when permission is absent

- **GIVEN** an agent whose effective permission set does not contain `document:write`
- **WHEN** the agent calls `tools/list` against `/api/mcp`
- **THEN** the response MUST NOT include any tool whose `name` field equals `chorus_create_report`

#### Scenario: Successful call writes a report Document

- **GIVEN** an authenticated agent with `document:write`
- **AND** an existing Proposal `P` in the agent's company
- **WHEN** the agent calls `tools/call` with `name: "chorus_create_report"` and `arguments: { proposalUuid: "<P-uuid>", title: "Idea X — completion report", content: "## Background\n..." }`
- **THEN** the call MUST succeed
- **AND** a new `Document` row MUST exist with `type = "report"`, `proposalUuid = <P-uuid>`, `projectUuid = P.projectUuid`, `version = 1`, and the supplied `title` and `content`
- **AND** the response MUST include `documentUuid`, `projectUuid`, and `version`

#### Scenario: Calling for a non-existent Proposal errors

- **GIVEN** an authenticated agent with `document:write`
- **WHEN** the agent calls `chorus_create_report` with a `proposalUuid` that does not exist in the agent's company
- **THEN** the server MUST return an error indicating the Proposal was not found
- **AND** MUST NOT create a Document

#### Scenario: The permission map gates `chorus_create_report` on `document:write`

- **GIVEN** the permission gate file `src/mcp/tools/permission-map.ts`
- **WHEN** the file is read
- **THEN** it MUST contain an entry mapping `chorus_create_report` to a permission of `{ resource: "document", action: "write" }`
- **AND** the tool MUST NOT be exposed by any code path that bypasses the permission gate
