# root-idea-resolution Specification

## ADDED Requirements

### Requirement: Server-side root-idea resolution tool

The Chorus MCP server SHALL expose a public, read-only tool
`chorus_resolve_root_idea` that accepts `entityType` (one of `task`, `document`,
`proposal`, `idea`) and `entityUuid`, and resolves the entity to the root idea of
its lineage in a single call. The tool SHALL be available without a permission gate
(consistent with `chorus_get_idea`), and all resolution SHALL be scoped to the
caller's `companyUuid` so no cross-company entity is ever traversed or returned.

The tool SHALL return an object containing `rootIdeaUuid` (a string, or `null` when
no idea ancestor exists), a `lineage` array ordered from the input entity to the root
idea where each element carries `type`, `uuid`, and `title`, and a `resolvedVia`
string explaining the outcome.

#### Scenario: Task with an idea-derived proposal resolves to the root idea

- **WHEN** `chorus_resolve_root_idea` is called with `entityType: "task"` and a task
  whose `proposalUuid` points to a proposal with `inputType: "idea"`
- **THEN** the tool walks task → proposal → idea → `parentUuid` to the topmost idea
  and returns that uuid as `rootIdeaUuid` with `resolvedVia: "via_proposal"`

#### Scenario: Idea resolves to its own lineage root

- **WHEN** the tool is called with `entityType: "idea"` for an idea that has a chain
  of `parentUuid` ancestors
- **THEN** it returns the topmost ancestor as `rootIdeaUuid` with
  `resolvedVia: "root_idea"`

#### Scenario: Resolution is scoped to the caller's company

- **WHEN** the tool is called with an `entityUuid` that exists only in another company
- **THEN** it returns `rootIdeaUuid: null` with `resolvedVia: "not_found"` and never
  reads or returns the other company's entity

### Requirement: Document attribution via proposal

The resolution tool SHALL attribute a document to a root idea by following
`document.proposalUuid → proposal → idea`, closing the gap where documents were never
attributed. A document with no `proposalUuid` SHALL resolve to `rootIdeaUuid: null`
with `resolvedVia: "standalone_document"`.

#### Scenario: Document of an idea-derived proposal resolves to the root idea

- **WHEN** the tool is called with `entityType: "document"` for a document whose
  `proposalUuid` points to a proposal with `inputType: "idea"`
- **THEN** it returns the proposal's idea walked to its root as `rootIdeaUuid` with
  `resolvedVia: "via_document_proposal"`

#### Scenario: Standalone document has no idea ancestor

- **WHEN** the tool is called for a document whose `proposalUuid` is null
- **THEN** it returns `rootIdeaUuid: null` with `resolvedVia: "standalone_document"`

### Requirement: Explicit multi-idea ambiguity

When a proposal's `inputUuids` contains more than one idea, the resolution tool SHALL
return the root of the first input idea as `rootIdeaUuid` (keeping the result
single-valued so a consumer's session anchoring stays deterministic), and SHALL set
`ambiguous: true` with a `candidates` array listing the resolved root idea uuid of
each input idea.

#### Scenario: Merged proposal flags ambiguity but stays single-valued

- **WHEN** the tool resolves a task whose proposal has `inputType: "idea"` and two or
  more entries in `inputUuids`
- **THEN** `rootIdeaUuid` is the root of `inputUuids[0]`, `ambiguous` is `true`, and
  `candidates` lists the root idea of each input idea

#### Scenario: Single-idea proposal is not ambiguous

- **WHEN** the tool resolves an entity whose proposal has exactly one entry in
  `inputUuids`
- **THEN** `ambiguous` is absent or `false` and no `candidates` array is required

### Requirement: No idea ancestor is a successful null, not an error

The resolution tool SHALL treat the absence of an idea ancestor as a successful
result with `rootIdeaUuid: null` and a `resolvedVia` value that names the reason
(`no_proposal`, `proposal_input_not_idea`, `standalone_document`, or `not_found`).
It SHALL NOT return a tool error for these cases, so a caller can distinguish "no
ancestor" from a genuine failure without parsing error text.

#### Scenario: Quick task with no proposal returns null

- **WHEN** the tool is called for a task whose `proposalUuid` is null
- **THEN** it returns `rootIdeaUuid: null` with `resolvedVia: "no_proposal"` and the
  call is not an error

#### Scenario: Document-derived proposal returns null

- **WHEN** the tool resolves an entity whose proposal has `inputType` other than
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
