# root-idea-resolution Specification

## Purpose
Defines the standalone REST endpoint `GET /api/entities/{type}/{uuid}/root-idea` —
the single source of truth for attributing any entity (task / document / proposal /
idea) up the Chorus lineage to its root idea. It powers the CLI daemon's per-root-idea
session anchoring, closes the document-attribution gap, and gives multi-idea proposals
explicit, deterministic semantics. It is deliberately NOT an MCP tool: it is a plain
REST endpoint callable with any valid auth (notably an agent API key).
## Requirements
### Requirement: Standalone REST root-idea resolution endpoint

The Chorus server SHALL expose a REST endpoint
`GET /api/entities/{type}/{uuid}/root-idea` where `{type}` is one of `task`,
`document`, `proposal`, `idea` and `{uuid}` is the entity uuid, that resolves the
entity to the root idea of its lineage in a single call. The endpoint SHALL be
callable with any valid authentication context — in particular an agent API key
(`Bearer cho_...`) — and SHALL NOT require any fine-grained permission gate. All
resolution SHALL be scoped to the caller's `companyUuid` so no cross-company entity
is ever traversed or returned. This capability SHALL NOT be exposed as an MCP tool.

The endpoint SHALL return the standard success envelope `{ success: true, data }`
where `data` contains `rootIdeaUuid` (a string, or `null` when no idea ancestor
exists), a `lineage` array ordered from the input entity to the root idea where each
element carries `type`, `uuid`, and `title`, and a `resolvedVia` string explaining the
outcome. An unrecognized `{type}` SHALL return HTTP 400; an unauthenticated request
SHALL return HTTP 401.

#### Scenario: Task with an idea-derived proposal resolves to the root idea

- **WHEN** `GET /api/entities/task/{uuid}/root-idea` is called for a task whose
  `proposalUuid` points to a proposal with `inputType: "idea"`
- **THEN** the endpoint walks task → proposal → idea → `parentUuid` to the topmost
  idea and returns that uuid as `rootIdeaUuid` with `resolvedVia: "via_proposal"`

#### Scenario: Idea resolves to its own lineage root

- **WHEN** the endpoint is called with `type: "idea"` for an idea that has a chain
  of `parentUuid` ancestors
- **THEN** it returns the topmost ancestor as `rootIdeaUuid` with
  `resolvedVia: "root_idea"`

#### Scenario: Callable with an agent API key and no permission gate

- **WHEN** the endpoint is called with an agent API key whose preset grants no
  special permission
- **THEN** the request succeeds and the lineage is resolved — there is no permission
  short-circuit

#### Scenario: Resolution is scoped to the caller's company

- **WHEN** the endpoint is called with a `{uuid}` that exists only in another company
- **THEN** it returns `rootIdeaUuid: null` with `resolvedVia: "not_found"` and never
  reads or returns the other company's entity

#### Scenario: Unrecognized entity type is rejected

- **WHEN** the endpoint is called with a `{type}` that is not one of `task`,
  `document`, `proposal`, `idea`
- **THEN** it returns HTTP 400 and does not attempt resolution

### Requirement: Document attribution via proposal

The endpoint SHALL attribute a document to a root idea by following
`document.proposalUuid → proposal → idea`, closing the gap where documents were never
attributed. A document with no `proposalUuid` SHALL resolve to `rootIdeaUuid: null`
with `resolvedVia: "standalone_document"`.

#### Scenario: Document of an idea-derived proposal resolves to the root idea

- **WHEN** the endpoint is called with `type: "document"` for a document whose
  `proposalUuid` points to a proposal with `inputType: "idea"`
- **THEN** it returns the proposal's idea walked to its root as `rootIdeaUuid` with
  `resolvedVia: "via_document_proposal"`

#### Scenario: Standalone document has no idea ancestor

- **WHEN** the endpoint is called for a document whose `proposalUuid` is null
- **THEN** it returns `rootIdeaUuid: null` with `resolvedVia: "standalone_document"`

### Requirement: Explicit multi-idea ambiguity

When a proposal's `inputUuids` contains more than one idea, the endpoint SHALL
return the root of the first input idea as `rootIdeaUuid` (keeping the result
single-valued so a consumer's session anchoring stays deterministic), and SHALL set
`ambiguous: true` with a `candidates` array listing the resolved root idea uuid of
each input idea.

#### Scenario: Merged proposal flags ambiguity but stays single-valued

- **WHEN** the endpoint resolves a task whose proposal has `inputType: "idea"` and two
  or more entries in `inputUuids`
- **THEN** `rootIdeaUuid` is the root of `inputUuids[0]`, `ambiguous` is `true`, and
  `candidates` lists the root idea of each input idea

#### Scenario: Single-idea proposal is not ambiguous

- **WHEN** the endpoint resolves an entity whose proposal has exactly one entry in
  `inputUuids`
- **THEN** `ambiguous` is absent or `false` and no `candidates` array is required

### Requirement: No idea ancestor is a successful null, not an error

The endpoint SHALL treat the absence of an idea ancestor as a successful result with
`rootIdeaUuid: null` and a `resolvedVia` value that names the reason (`no_proposal`,
`proposal_input_not_idea`, `standalone_document`, or `not_found`). It SHALL NOT return
an HTTP error status for these cases, so a caller can distinguish "no ancestor" from a
genuine failure without parsing error text.

#### Scenario: Quick task with no proposal returns null

- **WHEN** the endpoint is called for a task whose `proposalUuid` is null
- **THEN** it returns HTTP 200 with `rootIdeaUuid: null` and `resolvedVia: "no_proposal"`

#### Scenario: Document-derived proposal returns null

- **WHEN** the endpoint resolves an entity whose proposal has `inputType` other than
  `"idea"`
- **THEN** it returns `rootIdeaUuid: null` with `resolvedVia: "proposal_input_not_idea"`

### Requirement: Bounded, cycle-safe parent walk

The resolution SHALL walk the `parentUuid` chain with a visited-set cycle guard and a
bounded maximum hop count, returning the deepest reachable idea without looping
indefinitely if the lineage data contains a cycle.

#### Scenario: Cyclic lineage terminates at the entry idea

- **WHEN** the `parentUuid` chain forms a cycle
- **THEN** the walk detects the repeat via the visited set and returns without
  exceeding the hop bound

### Requirement: Direct idea exposed alongside the root idea

The `GET /api/entities/{type}/{uuid}/root-idea` endpoint SHALL include, in its
`data` object, a `directIdeaUuid` field: the uuid of the **first** idea node on the
resolved `lineage` array (ordered input-entity → root), or `null` when the lineage
contains no idea node. The direct idea is the idea the input entity attaches to
directly — for a `task`/`document` it is the idea of the entity's proposal
(`inputUuids[0]` for a multi-idea proposal); for an `idea` input it is that idea
itself. The endpoint SHALL derive `directIdeaUuid` from the lineage it already
computes, performing no additional traversal or query. This field SHALL be purely
additive: `rootIdeaUuid`, `lineage`, `resolvedVia`, `ambiguous`, and `candidates`
SHALL retain their existing semantics and values unchanged. When the lineage has
exactly one idea node, `directIdeaUuid` SHALL equal `rootIdeaUuid`.

#### Scenario: Direct idea is the first idea node, root is the last

- **WHEN** `GET /api/entities/task/{uuid}/root-idea` resolves a task whose proposal's
  input idea has a chain of `parentUuid` ancestors
- **THEN** `directIdeaUuid` is the uuid of the proposal's input idea (the first idea
  node on `lineage`) and `rootIdeaUuid` is the topmost ancestor (the last idea node),
  and the two differ

#### Scenario: Direct idea equals root for a top-level idea

- **WHEN** the endpoint resolves an entity whose direct idea has no `parentUuid`
- **THEN** `directIdeaUuid` equals `rootIdeaUuid`

#### Scenario: Idea input resolves its own uuid as the direct idea

- **WHEN** the endpoint is called with `type: "idea"` for an idea that has a parent
- **THEN** `directIdeaUuid` is that idea's own uuid (not its parent/root), while
  `rootIdeaUuid` remains the topmost ancestor

#### Scenario: No idea ancestor yields a null direct idea

- **WHEN** the endpoint resolves an entity with no idea ancestor (quick task with no
  proposal, standalone document, or a proposal whose `inputType` is not `idea`)
- **THEN** `directIdeaUuid` is `null`, matching the `null` `rootIdeaUuid` for the same
  cases, and the request still returns HTTP 200

#### Scenario: Existing response fields are unchanged

- **WHEN** any entity is resolved
- **THEN** `rootIdeaUuid`, `lineage`, `resolvedVia`, and (for multi-idea proposals)
  `ambiguous` and `candidates` carry exactly the values they did before this field was
  added — `directIdeaUuid` adds information without altering them

