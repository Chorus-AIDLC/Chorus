# idea-completion-report Specification

## ADDED Requirements

### Requirement: Idea-completion reports SHALL be stored as Documents with `type="report"`

A `report` is a Markdown summary of a finished Idea, stored as a `Document` row whose `type` field equals the literal string `report`. The Document's `proposalUuid` MUST point to the Proposal whose tasks have all reached a terminal state (`done` or `closed`). Reports MUST NOT introduce a new Prisma model, a new Document column, or a schema migration. Multiple reports per Proposal are permitted.

#### Scenario: A report is created with the correct type label

- **GIVEN** an Idea whose all linked Tasks (across all approved Proposals) are in `done` or `closed` status
- **WHEN** an agent calls `chorus_create_report` with a valid `proposalUuid`, `title`, and `content`
- **THEN** the server MUST persist a new `Document` row with `type = "report"` and `proposalUuid` set to the provided value
- **AND** the row's `version` MUST be `1`
- **AND** the row's `projectUuid` MUST equal the Proposal's `projectUuid`
- **AND** the response MUST include the new `documentUuid`

#### Scenario: Multiple reports may exist for the same Proposal

- **GIVEN** a Proposal that already has one Document with `type = "report"`
- **WHEN** an agent calls `chorus_create_report` again for the same `proposalUuid` with a different `title`
- **THEN** the call MUST succeed
- **AND** the Proposal MUST now be reachable to two distinct `report`-typed Documents via existing list endpoints

#### Scenario: Reports use existing Document update / read paths

- **GIVEN** a `report` Document created via `chorus_create_report`
- **WHEN** the author calls `chorus_pm_update_document` with the new `documentUuid` and updated `content`
- **THEN** the call MUST behave identically to update on any other Document type (version increments, content replaces)
- **AND** the row's `type` MUST remain `report`

### Requirement: The yolo skill SHALL author a report at end-step when an Idea finishes

When the `yolo` skill verifies the last task of an Idea (i.e. all Tasks linked to the Idea are now in a terminal state), it MUST compose a Markdown report covering Summary, Decisions, and Follow-ups, then call `chorus_create_report`. Skipping this step is a yolo protocol violation.

#### Scenario: yolo emits a report after the last task verifies

- **GIVEN** a yolo-driven Idea pipeline whose final task has just been admin-verified
- **WHEN** the `yolo` skill reaches its end-step
- **THEN** the skill MUST call `chorus_create_report` exactly once with `proposalUuid` set to the Proposal whose final task just verified
- **AND** the `content` MUST contain at minimum the three section headers `## Summary`, `## Decisions`, `## Follow-ups`
- **AND** the call MUST succeed before yolo claims the Idea is done

#### Scenario: yolo does not author a report when the Idea is not yet finished

- **GIVEN** a yolo-driven Idea pipeline where some tasks remain in non-terminal status
- **WHEN** the `yolo` skill is mid-pipeline
- **THEN** the skill MUST NOT call `chorus_create_report`

### Requirement: The develop skill SHALL prompt for a report when an Idea finishes

When a `develop`-driven agent verifies a task that turns out to be the last one of its Idea, the skill MUST emit guidance that prompts the agent to call `chorus_create_report`. Unlike `yolo`'s mandatory end-step, the develop guidance is advisory — the skill MUST present the option but MUST NOT block on it.

#### Scenario: develop surfaces the report prompt at last-task verification

- **GIVEN** a `develop`-driven session where the agent has just successfully called `chorus_admin_verify_task` and the verified task is the last one of its Idea
- **WHEN** the develop skill reaches its post-verify branch
- **THEN** the skill instructions MUST include language directing the agent to consider calling `chorus_create_report`
- **AND** the skill MUST NOT exit-error if the agent declines

### Requirement: The PostToolUse hook SHALL inject a report-creation reminder

After `chorus_admin_verify_task` succeeds, the Chorus plugin's PostToolUse hook (`bin/on-post-verify-task.sh` for the Claude Code plugin and the Codex equivalent) MUST check whether the verified task's Proposal is idea-rooted, has all its Tasks in a terminal state, AND has no `type="report"` Document yet. If all three hold, the hook MUST inject an `additionalContext` reminder containing the literal substring `create idea-completion report`. The hook MUST be read-only and MUST NOT call `chorus_create_report` itself. The hook intentionally checks only the verified task's own Proposal — multi-proposal-per-Idea aggregation is `/yolo`'s mandatory end-step's responsibility, not the hook's.

#### Scenario: Hook injects a reminder when the proposal is finished and has no report

- **GIVEN** an idea-rooted Proposal whose Tasks are all now `done` or `closed` after a `chorus_admin_verify_task` call
- **AND** the Proposal has zero Documents with `type = "report"`
- **WHEN** the PostToolUse hook fires
- **THEN** the hook MUST emit `additionalContext` containing the literal substring `create idea-completion report`
- **AND** the hook MUST NOT call any Chorus mutation tool

#### Scenario: Hook stays silent when a report already exists

- **GIVEN** an idea-rooted Proposal whose Tasks are all `done` and which already has at least one `type = "report"` Document
- **WHEN** the PostToolUse hook fires
- **THEN** the hook MUST exit 0 silently
- **AND** MUST NOT inject any reminder

#### Scenario: Hook stays silent when not all tasks are done

- **GIVEN** an idea-rooted Proposal where the just-verified task was not the last (other Tasks still in non-terminal status)
- **WHEN** the PostToolUse hook fires
- **THEN** the hook MUST exit 0 silently

#### Scenario: Hook stays silent when the Proposal is not idea-rooted

- **GIVEN** a Proposal whose `inputType` is not `"idea"` (e.g. a manually-rooted Proposal)
- **WHEN** the PostToolUse hook fires
- **THEN** the hook MUST exit 0 silently regardless of task or Document state

### Requirement: The idea-tracker IdeaDetailPanel SHALL surface reports on the overview tab below the timeline

In the Chorus dashboard's `IdeaDetailPanel`, the `overview` tab MUST render a Reports list directly **below** `OverviewTimeline`, aggregated across all approved Proposals of the Idea (not per-proposal). When one or more `type="report"` Documents exist across the Idea's approved Proposals, the UI MUST render a Reports section header with the count and one row per report, sorted by `createdAt` descending. Each report row MUST be clickable and MUST open the existing `DocumentPanel` side panel with the report's content rendered as Markdown. The Reports list MUST NOT appear when zero reports exist across all approved Proposals of the Idea, and the `proposal` tab MUST NOT be modified by this requirement.

#### Scenario: Reports list renders below the timeline when reports exist

- **GIVEN** an Idea with two approved Proposals — Proposal A has one `type = "report"` Document, Proposal B has two `type = "report"` Documents
- **WHEN** the user opens the Idea's detail panel and the `overview` tab is active (the default for finished Ideas)
- **THEN** the overview tab body MUST render `OverviewTimeline` first, immediately followed by a Reports list section
- **AND** the Reports list MUST contain three rows in `createdAt` descending order, each labeled with its Document's `title`
- **AND** each row MUST display a doc-type badge with the localized label for `report`
- **AND** the section header count MUST be `3`

#### Scenario: Clicking a report row opens the side panel

- **GIVEN** the Reports list visible with at least one row on the overview tab
- **WHEN** the user clicks a report row
- **THEN** the existing `DocumentPanel` MUST open as a side panel (side-by-side on wide screens, overlay otherwise)
- **AND** it MUST render the report's `content` as Markdown using the existing `MarkdownContent` component
- **AND** it MUST display the report's `title` and the `report` type badge

#### Scenario: Reports list is hidden when no reports exist

- **GIVEN** an Idea whose approved Proposals collectively carry zero `type = "report"` Documents
- **WHEN** the user opens the `overview` tab
- **THEN** the panel MUST render `OverviewTimeline` as before
- **AND** the panel MUST NOT render a Reports list (no header, no empty-state copy) below the timeline

#### Scenario: The proposal tab is unchanged

- **GIVEN** an Idea whose approved Proposals carry one or more `type = "report"` Documents
- **WHEN** the user opens the `proposal` tab
- **THEN** the proposal tab MUST render exactly as it did before this change — no Reports section is added under any Proposal block on the proposal tab

### Requirement: Report content SHALL be authored by the calling skill, not the server

The `chorus_create_report` MCP tool MUST persist `content` byte-faithfully and MUST NOT modify, augment, prepend, or append to the body. Skill prose and the tool's LLM-visible description provide the section template; the server enforces no structural validation on `content` beyond the existing `Document.content` non-empty check.

#### Scenario: Server preserves report content byte-faithfully

- **GIVEN** an agent supplies a multi-section Markdown body with code fences, tables, and CJK characters
- **WHEN** the agent calls `chorus_create_report` with that body as `content`
- **THEN** the persisted Document's `content` MUST equal the input bytes (modulo a single trailing newline normalization, consistent with the server's existing `Document.content` write path)
- **AND** the server MUST NOT inject report-section headers, frontmatter, or any other structural markup
