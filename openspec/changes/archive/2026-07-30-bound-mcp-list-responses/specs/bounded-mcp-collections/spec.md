## ADDED Requirements

### Requirement: Bounded collection pagination
Every MCP tool that returns a resource collection SHALL apply an explicit bounded collection policy. Page-number collection tools MUST default to page 1 and page size 20 when pagination inputs are omitted, MUST enforce a documented maximum page size, and MUST return the collection together with `returned`, `page`, `pageSize`, and `total` metadata.

#### Scenario: Caller omits pagination
- **WHEN** an agent invokes a page-number MCP collection tool without `page` or `pageSize`
- **THEN** the tool returns the first page with no more than 20 rows and reports `returned`, `page`, `pageSize`, and `total`

#### Scenario: Caller requests a later page
- **WHEN** an agent supplies a valid page and page size
- **THEN** the tool returns the corresponding bounded slice and metadata matching the applied values

#### Scenario: Caller exceeds the maximum
- **WHEN** an agent requests a page size above the documented maximum
- **THEN** the tool rejects or caps the request according to the shared policy and cannot emit more than the maximum number of rows

### Requirement: Serialized collection byte ceiling
The UTF-8 byte length of the inner JSON payload emitted by any MCP collection or search tool MUST NOT exceed 65,536 bytes. Collection helpers MUST measure the final serialized payload and remove trailing rows until it fits; `returned` MUST equal the number of emitted rows. If metadata plus one fully truncated row cannot fit, the tool MUST return a structured error instead of an oversized payload.

#### Scenario: Long multibyte fields overflow a nominal page
- **WHEN** a requested page would serialize above 65,536 UTF-8 bytes after summary projection and field truncation
- **THEN** the tool removes rows from the end, emits a payload no larger than 65,536 bytes, and reports the reduced actual `returned` count

#### Scenario: Irreducible row exceeds the ceiling
- **WHEN** metadata plus one fully truncated summary row cannot fit within 65,536 UTF-8 bytes
- **THEN** the tool emits a structured error and does not emit the oversized collection payload

### Requirement: Compact list summaries
MCP collection rows SHALL include the resource UUID and its title or name when those fields exist, MAY include compact status and routing fields needed to choose a resource, and MUST omit long-form content and nested detail available through a single-resource tool.

#### Scenario: Agent lists resources
- **WHEN** an agent invokes an MCP collection tool for entities with detailed content
- **THEN** each row is a compact summary without descriptions, document bodies, comments, acceptance criteria, reports, or nested entity graphs

#### Scenario: Agent needs full detail
- **WHEN** an agent selects a UUID from a compact collection row
- **THEN** the corresponding single-resource `get` tool returns the entity's detailed representation

### Requirement: Bounded summary strings
Collection summary titles, names, labels, and display-status strings MUST be limited to 256 Unicode code points. Search snippets and retained preview strings MUST be limited to 512 Unicode code points. Truncated values MUST end with `...` within the applicable limit, and truncation MUST NOT alter persisted data or detailed `get` responses.

#### Scenario: Summary title exceeds its limit
- **WHEN** a resource title contains more than 256 Unicode code points
- **THEN** its collection summary ends with `...`, contains no more than 256 code points, and the detailed `get` response retains the full title

#### Scenario: Search snippet exceeds its limit
- **WHEN** a generated search snippet contains more than 512 Unicode code points
- **THEN** the emitted snippet ends with `...` and contains no more than 512 code points

### Requirement: Backward-compatible collection envelopes
Migrated MCP collection tools MUST preserve their existing input filters and top-level collection key while adding or normalizing pagination metadata.

#### Scenario: Existing filtered caller migrates implicitly
- **WHEN** an existing caller supplies a supported status, priority, project, proposal, type, or other list filter
- **THEN** the filter retains its prior meaning and the bounded response uses the tool's existing collection key

### Requirement: Exact UUID discovery
`chorus_search` SHALL support tenant-scoped exact lookup of canonical UUID queries for every entity type supported by search, while respecting requested entity-type and project filters and preserving bounded text-search behavior.

#### Scenario: UUID identifies a permitted entity
- **WHEN** an agent searches for a canonical UUID within matching entity-type and project filters
- **THEN** `chorus_search` returns the compact matching entity without requiring a collection scan

#### Scenario: UUID is outside tenant or filters
- **WHEN** a UUID belongs to another tenant or does not satisfy the requested entity-type or project filters
- **THEN** the entity is not returned

#### Scenario: Query is not a matching UUID
- **WHEN** a query is not a canonical UUID or has no exact match
- **THEN** the existing bounded text-search behavior runs

### Requirement: Collection contract inventory
The MCP test suite MUST maintain an executable inventory of every registered tool that can return a resource collection and MUST require each entry to adopt the shared bounded contract or declare a justified, tested bounded-aggregate exemption.

#### Scenario: New collection tool lacks a policy
- **WHEN** a newly registered MCP tool returns a resource collection but is absent from the contract inventory
- **THEN** the collection contract test fails

#### Scenario: Bounded aggregate is exempted
- **WHEN** a collection-bearing aggregate cannot use page-number pagination
- **THEN** its inventory entry documents the stricter bound and a test verifies that bound

### Requirement: Agent-facing discovery guidance
MCP tool descriptions, MCP documentation, and maintained Chorus skill copies SHALL describe list results as summaries, direct agents to single-resource tools for detail, and recommend exact UUID search or filtered search before page traversal.

#### Scenario: Agent reads tool guidance
- **WHEN** an agent inspects collection or search tool descriptions and Chorus workflow guidance
- **THEN** it can determine how to discover a resource without requesting an unbounded or detail-heavy collection
