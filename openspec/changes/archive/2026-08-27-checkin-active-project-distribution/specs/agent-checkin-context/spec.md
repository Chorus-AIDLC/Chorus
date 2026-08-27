# agent-checkin-context

## ADDED Requirements

### Requirement: Checkin surfaces an active-project distribution, not an idea list

The `chorus_checkin` response SHALL surface the agent's in-flight work as a
per-project distribution keyed by project UUID, where each entry carries the
project `name` and an `activeIdeaCount`, and SHALL NOT include per-idea titles
or UUIDs. An "active" idea is one assigned to the agent (or its instance or
owner), not `closed`, and whose derived status is not `done` — the same set
`chorus_get_my_assignments` reports. The count SHALL match that full-list set
exactly (it is derived from the same computation, with no maximum-ideas cap).

#### Scenario: Multiple projects with active ideas

- **WHEN** an agent with active ideas in two projects calls `chorus_checkin`
- **THEN** the response contains an `activeProjects` map keyed by project UUID
- **AND** each entry has `name` and `activeIdeaCount` equal to the number of that
  project's active ideas
- **AND** no per-idea title or UUID appears anywhere in `activeProjects`

#### Scenario: Completed and closed ideas are excluded from the count

- **WHEN** a project holds one active idea and one idea whose derived status is
  `done` (or `closed`)
- **THEN** that project's `activeIdeaCount` counts only the active idea

#### Scenario: Count is not truncated by a cap

- **WHEN** an agent has more than ten active ideas spread across projects
- **THEN** every active idea is reflected in the `activeProjects` counts (no
  ten-idea cap truncates the distribution)

#### Scenario: No active work

- **WHEN** an agent has no active ideas
- **THEN** `activeProjects` is an empty map

### Requirement: Checkin includes an always-present working-style reminder

The `chorus_checkin` response SHALL include a non-empty `guidance` list that is
present on every checkin regardless of whether the agent has active work. The
guidance SHALL direct the agent to (1) follow the AI-DLC workflow via the Chorus
skill for long-horizon work, and (2) use `chorus_search` to locate the specific
work the user refers to across resources rather than treating the injected
distribution as a fixed to-do list.

#### Scenario: Guidance present with active work

- **WHEN** an agent with active ideas calls `chorus_checkin`
- **THEN** the response includes a non-empty `guidance` list
- **AND** the guidance references both the Chorus skill / AI-DLC workflow and
  `chorus_search`

#### Scenario: Guidance present with no active work

- **WHEN** an agent with no active ideas calls `chorus_checkin`
- **THEN** the response still includes the non-empty `guidance` list

### Requirement: Full assignment list stays available on demand

`chorus_get_my_assignments` SHALL continue to return the full, uncapped
`ideaTracker` (per-idea entries grouped by project) and `taskTracker`, unchanged
by this feature. The shared idea-tracker computation used by both surfaces SHALL
retain its per-idea output shape.

#### Scenario: My-assignments still returns per-idea entries

- **WHEN** an agent calls `chorus_get_my_assignments`
- **THEN** each project entry still lists individual ideas with title, UUID,
  derived status, and proposal/task counts
- **AND** the result is not reduced to a project→count distribution

### Requirement: Session-start copy describes the distribution, not a ten-idea list

Plugin session-start context and the MCP tool reference SHALL describe the
checkin idea surface as an active-project distribution and point to
`chorus_search` and `chorus_get_my_assignments` for locating and listing work.
No session-start copy or tool documentation SHALL claim the checkin surface
"shows up to 10 most recently updated ideas."

#### Scenario: No stale ten-idea copy remains

- **WHEN** the Claude Code and Kiro session-start context is generated
- **THEN** its quick-reference describes the active-project distribution and
  references `chorus_search` / `chorus_get_my_assignments`
- **AND** it does not state that up to ten most-recently-updated ideas are shown
