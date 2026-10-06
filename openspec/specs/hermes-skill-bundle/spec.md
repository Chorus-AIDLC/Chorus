# hermes-skill-bundle Specification

## Purpose
TBD - created by archiving change add-hermes-plugin. Update Purpose after archive.

## Requirements

### Requirement: The plugin SHALL package its own copy of the Chorus stage skills

`packages/chorus-hermes/chorus/skills/` MUST contain an independently maintained copy of the Chorus skills (at minimum: `chorus`, `idea`, `brainstorm`, `research`, `proposal`, `develop`, `review`, `quick-dev`, `yolo`, `orchestrate`, `openspec-aware`, `spec-lite`, `chorus-cli`, `docs`). Each skill MUST be registered with `ctx.register_skill` and therefore resolve as `chorus:<name>`. Skill text MUST NOT reference tools Hermes does not have (`AskUserQuestion`, Claude `Agent` / Codex `spawn_agent`, `${CLAUDE_PLUGIN_ROOT}`); human questions MUST route through Chorus elaboration rounds or comments, and sub-agents MUST use `delegate_task`.

#### Scenario: Skills resolve under the plugin namespace

- **WHEN** the model calls `skill_view("chorus:develop")`
- **THEN** Hermes MUST return the packaged develop skill

#### Scenario: No foreign tool references

- **WHEN** `packages/chorus-hermes/chorus/skills/` is grepped for `AskUserQuestion`, `spawn_agent`, `CLAUDE_PLUGIN_ROOT`
- **THEN** there MUST be zero matches

### Requirement: The plugin SHALL provide three read-only reviewer workflows executed via delegate_task

The plugin MUST ship `chorus-proposal-reviewer`, `chorus-task-reviewer`, and `chorus-code-reviewer` skills. The post-tool reminders MUST instruct the parent agent to run the matching reviewer with `delegate_task`, passing the reviewer skill name and entity UUID in `context`. While a reviewer child runs, a `pre_tool_call` guard MUST block Chorus write tools other than `chorus_add_comment`, and MUST block file-write and terminal tools, so reviewers are read-only. Each reviewer MUST post exactly one `VERDICT: PASS | PASS WITH NOTES | FAIL` comment on the reviewed entity.

#### Scenario: Reviewer cannot mutate

- **GIVEN** a reviewer child started via `delegate_task` with the reviewer marker in its context
- **WHEN** it attempts `chorus_admin_approve_proposal`, `write_file`, or `terminal`
- **THEN** the call MUST be blocked with a message stating reviewers are read-only

#### Scenario: Reviewer posts a verdict

- **WHEN** the proposal reviewer finishes
- **THEN** the proposal MUST have a new comment whose first line starts with `VERDICT:`
