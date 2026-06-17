## ADDED Requirements

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
