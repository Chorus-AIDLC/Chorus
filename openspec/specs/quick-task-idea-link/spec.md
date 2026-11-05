# quick-task-idea-link Specification

## Purpose
TBD - created by archiving change link-quick-task-to-idea. Update Purpose after archive.

## Requirements

### Requirement: Quick Task direct Idea link

A Task SHALL carry an optional `ideaUuid` that links it directly to exactly one Idea without a Proposal. The link SHALL only be stored on tasks without a `proposalUuid`; a task SHALL NOT have both. The linked Idea SHALL exist in the caller's company and in the same project as the task, and SHALL NOT be a theme (container) Idea. Any native Idea status (open, elaborating, elaborated) SHALL be accepted, and creating, changing or clearing a link SHALL NOT change the Idea's stored status. Task responses (MCP and REST) SHALL expose `ideaUuid` (or `null`).

#### Scenario: Create a Quick Task linked to an Idea

- **WHEN** an agent with `task:write` calls `chorus_create_tasks` without `proposalUuid` and with `ideaUuid` of an Idea in the same project
- **THEN** every created task stores that `ideaUuid`, `chorus_get_task` returns it, and the Idea's stored status is unchanged

#### Scenario: Link rejected for a proposal task

- **WHEN** `chorus_create_tasks` is called with both `proposalUuid` and `ideaUuid`, or `chorus_update_task` sets `ideaUuid` on a task that has a `proposalUuid`
- **THEN** the call fails with an error and nothing is written

#### Scenario: Cross-project, cross-company or theme Idea rejected

- **WHEN** the `ideaUuid` belongs to another project, another company, or a theme (container) Idea
- **THEN** the create or update fails and no link is stored

#### Scenario: Change and clear a link later

- **WHEN** `chorus_update_task` (or `PATCH /api/tasks/{uuid}`) is called on a Quick Task with a different valid `ideaUuid`, or with `ideaUuid: null`
- **THEN** the link is replaced or cleared and an activity is recorded

#### Scenario: Filter tasks by Idea

- **WHEN** `chorus_list_tasks` is called with `ideaUuid`
- **THEN** only tasks directly linked to that Idea are returned

### Requirement: Linked Quick Tasks are full members of the Idea lineage

A linked Quick Task SHALL resolve to its Idea exactly as a proposal task does. `resolveDirectIdeaUuid("task")` SHALL return the linked Idea, and root-idea resolution SHALL walk from that Idea to its root with `resolvedVia: "via_task_idea"`. Consequently the daemon session anchor, instance pin inheritance, @mention routing, Team orchestrator lookup and Team development/review recommendation SHALL treat the task as belonging to the Idea.

#### Scenario: Root idea of a linked Quick Task

- **WHEN** `GET /api/entities/task/{uuid}/root-idea` is called for a Quick Task linked to a child Idea whose parent is P
- **THEN** it returns `rootIdeaUuid: P`, a lineage `[task, child idea, P]` and `resolvedVia: "via_task_idea"`

#### Scenario: Team review routing accepts a linked task

- **WHEN** `chorus_recommend_team_agent` is called with `ideaUuid` I and a `taskUuid` of a Quick Task linked to I
- **THEN** the task is accepted as belonging to I (no "Task does not belong to this Idea" error)

#### Scenario: Unlinked Quick Task unchanged

- **WHEN** a Quick Task has neither `proposalUuid` nor `ideaUuid`
- **THEN** root-idea resolution still returns `rootIdeaUuid: null` with `resolvedVia: "no_proposal"`

### Requirement: Linked tasks follow the Idea lifecycle

Last-task detection, the whole-Idea code-review gateway, the Idea `execution_started` activity, cross-project Idea move and Idea deletion SHALL include directly linked Quick Tasks.

#### Scenario: Last linked task triggers whole-Idea handoff

- **WHEN** the last non-terminal task of an Idea (over proposal tasks ∪ linked Quick Tasks) is submitted or verified
- **THEN** the server-side last-task handoff fires for that Idea, and the plugin post-verify hook emits the code-review gateway reminder for that Idea even when it has no proposal

#### Scenario: Moving an Idea moves its linked tasks

- **WHEN** an Idea with linked Quick Tasks is moved to another project
- **THEN** those tasks move to the target project together with the Idea and are counted in the move preview

#### Scenario: Deleting an Idea keeps its tasks

- **WHEN** an Idea with linked Quick Tasks is deleted
- **THEN** the tasks remain as unlinked Quick Tasks (`ideaUuid: null`)

### Requirement: UI supports linking Quick Tasks to Ideas

The web UI SHALL let a user choose an Idea when creating a Quick Task, SHALL show the linked Idea in task detail with the ability to change or clear it (not offered for proposal tasks), and SHALL list linked Quick Tasks in the Idea panel's overview timeline and tasks tab. All new strings SHALL exist in en and zh and render correctly in light and dark themes.

#### Scenario: Idea panel shows linked Quick Tasks

- **WHEN** a user opens an Idea that has no proposal but has two linked Quick Tasks
- **THEN** the panel's tasks tab lists both tasks and the overview timeline shows the execution phase instead of elaboration
