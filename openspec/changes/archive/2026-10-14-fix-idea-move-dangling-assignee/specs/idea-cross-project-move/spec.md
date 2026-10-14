## ADDED Requirements

### Requirement: Move SHALL access-check only live assignees and skip dangling ones

Before migrating anything, `moveIdea` MUST collect every distinct assignee in the cascade: the moved root Idea, its descendant Ideas, and every Task under the moved Proposals. For each one, it MUST resolve whether the assignee still exists in the company:
- `user`: a `User` row exists.
- `agent`: an `Agent` row exists.
- `agent_instance`: an `AgentInstance` row and its `Agent` row both exist.

An assignee that does not resolve (a dangling assignee, e.g. a deleted agent) MUST be treated as unassigned for the access check and MUST NOT block the move. The move MUST NOT modify the row's assignee fields.

A live agent or agent-instance assignee MUST be evaluated with its owner's effective project access (local, group, or implicit Admin), unchanged from the existing inheritance rule. Assignment paths outside the move (claim, assign) MUST keep rejecting a non-existent assignee.

#### Scenario: Tasks assigned to a deleted agent do not block the move

- **GIVEN** an Idea whose approved Proposal has tasks still assigned (`assigneeType="agent"`) to an agent that has since been deleted
- **AND** the target project is public
- **WHEN** a user with Editor access on both projects moves the Idea
- **THEN** the move MUST succeed and cascade the tasks
- **AND** the tasks' `assigneeType`/`assigneeUuid` MUST be unchanged

#### Scenario: The moved Idea itself assigned to a deleted agent does not block the move

- **GIVEN** the root Idea being moved is itself assigned (`assigneeType="agent"`) to a deleted agent
- **WHEN** a user with Editor access on both projects moves it
- **THEN** the move MUST succeed and the root Idea's assignee fields MUST be unchanged

#### Scenario: An Idea pinned to a deleted agent instance does not block the move

- **GIVEN** a descendant Idea assigned to an `agent_instance` whose `AgentInstance` row no longer exists
- **WHEN** the root Idea is moved
- **THEN** the move MUST succeed

#### Scenario: An agent inherits its owner's access

- **GIVEN** a private target project where user U is an Editor, and a task assigned to agent A owned by U
- **WHEN** the Idea is moved to that target
- **THEN** A MUST pass the assignee access check

### Requirement: A move blocked by assignees SHALL report every blocked assignee and their entities

When one or more live assignees lack Editor access to the target project, `moveIdea` MUST reject the whole move (no partial migration) with `AssigneeAccessError` (HTTP 403). The message MUST begin with `Assignee does not have access to this project`. The error's `details.blockedAssignees` MUST list every blocked assignee once, as `{ assigneeType, assigneeUuid, name, entities: [{ type: "idea"|"task", uuid, title }] }`. REST MUST return this under `error.details`, the UI server action MUST return it to the dialog, and the MCP tool MUST include the assignee names in its error text.

#### Scenario: Two blocked assignees are both reported

- **GIVEN** a cascade where agent B (owner has no access to private target T) holds 2 tasks, and user L (not a member of T) holds 1 descendant Idea
- **WHEN** the Idea is moved to T
- **THEN** the response MUST be 403 with `details.blockedAssignees` containing B (2 task entities) and L (1 idea entity)
- **AND** no Idea, Proposal, Document, Task or Activity row MUST have changed project

### Requirement: The move preview SHALL report blocked assignees

The preview (`moveIdeaPreview`, `GET /api/ideas/[uuid]/move/preview`, and `moveIdeaPreviewAction`) MUST return `blockedAssignees` with the same shape and the same skip-dangling rule as the move, without mutating anything. The Move dialog MUST list the blocked assignees and their entities with localized (en/zh) text, and MUST disable Confirm while the list is non-empty.

#### Scenario: Preview warns before confirm

- **GIVEN** a cascade with one blocked assignee
- **WHEN** the user opens the Move dialog and selects the target
- **THEN** the preview MUST return that assignee in `blockedAssignees`
- **AND** the dialog MUST show it and disable Confirm

#### Scenario: Preview ignores dangling assignees

- **GIVEN** a cascade whose only assignees are deleted agents
- **WHEN** the preview runs
- **THEN** `blockedAssignees` MUST be empty

## MODIFIED Requirements

### Requirement: Authorization for moveIdea SHALL be `idea:write` on the MCP path; REST and UI inherit existing idea-edit gating

The MCP tool `chorus_move_idea` MUST be gated by exactly the `idea:write` permission in `src/mcp/tools/permission-map.ts`. The handler MUST NOT additionally require any `project:*` permission bit.

The REST endpoint, the UI server action and the MCP tool MUST all require the caller to have project access level Editor or higher on the Idea's current project and on the target project. An agent caller's level is its owner's effective level. A target the caller cannot see MUST be reported as "Target project not found", indistinguishable from a missing project.

#### Scenario: Agent with only idea:write can move an idea between projects it has no project:write on

- **GIVEN** an Agent with permissions `idea:[read,write]` only (no `project:*`), whose owner is an Editor on both the source and target projects
- **WHEN** the agent calls `chorus_move_idea`
- **THEN** the call MUST succeed and perform the cascade migration

#### Scenario: MCP move into a private project the caller cannot see is rejected as not found

- **GIVEN** an Agent whose owner has no access to private project P
- **WHEN** the agent calls `chorus_move_idea` with `targetProjectUuid = P`
- **THEN** the tool MUST return an error stating the target project was not found
- **AND** nothing MUST be migrated

#### Scenario: MCP move of an Idea the caller can only view is rejected

- **GIVEN** an Agent whose owner is only a Viewer on the Idea's private project
- **WHEN** the agent calls `chorus_move_idea`
- **THEN** the tool MUST return an access error and nothing MUST be migrated
