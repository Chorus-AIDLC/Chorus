## ADDED Requirements

### Requirement: Mention search SHALL resolve the comment's root-idea assignee and pin when given entity context

The mention search (`searchMentionables`, surfaced by `GET /api/mentionables`) SHALL accept an optional entity context — an `entityType` (`idea` / `task` / `proposal` / `document`) and `entityUuid`. When both are provided, the search SHALL resolve the comment's **root Idea** via the shared root-idea resolver and SHALL annotate each candidate of type `agent` with: (a) `isRootIdeaAssignee`, a boolean that is true iff the candidate agent is the owning agent of the root Idea's assignee (resolving an `agent_instance` assignee to its owning agent); and (b) when the root Idea is instance-pinned (`assigneeType = "agent_instance"`), the root Idea's pinned place `(host, cwd)` and its durable `AgentInstance` reference, so the client can inherit that pin. When there is no root Idea (the entity has no idea ancestor), or no entity context is supplied, no candidate SHALL be marked `isRootIdeaAssignee` and no idea pin SHALL be returned — the search SHALL behave exactly as before. The enrichment SHALL be `companyUuid`-scoped and SHALL NOT require a new permission bit or widen candidate visibility. Candidates of type `user` SHALL NOT carry these fields.

#### Scenario: Root-idea assignee agent is annotated with the idea pin

- **GIVEN** a mention search with entity context for a Task whose root Idea is pinned to instance A of agent G
- **WHEN** the candidate list is resolved
- **THEN** agent G's candidate MUST carry `isRootIdeaAssignee: true` and the root Idea's pinned `(host, cwd)` place with its `AgentInstance` reference

#### Scenario: A non-assignee agent is not annotated as assignee

- **GIVEN** a mention search with entity context whose root Idea is assigned to agent G
- **WHEN** a different agent H appears in the candidate list
- **THEN** agent H's candidate MUST carry `isRootIdeaAssignee: false` and MUST NOT carry a root-idea pin

#### Scenario: No entity context leaves the search unchanged

- **WHEN** the mention search is called without `entityType`/`entityUuid`
- **THEN** no candidate MUST carry `isRootIdeaAssignee` or a root-idea pin
- **AND** the result MUST be identical to the pre-change search

#### Scenario: An entity with no root idea yields no assignee annotation

- **GIVEN** a mention search with entity context for a standalone entity that has no idea ancestor
- **WHEN** the candidate list is resolved
- **THEN** no candidate MUST be marked `isRootIdeaAssignee` and no root-idea pin MUST be returned
