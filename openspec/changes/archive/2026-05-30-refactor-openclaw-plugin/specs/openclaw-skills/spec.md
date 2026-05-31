## ADDED Requirements

### Requirement: The plugin SHALL bundle the full set of nine Chorus skills

The plugin MUST bundle, under `packages/openclaw-plugin/skills/`, all nine skills present in the Claude Code Chorus plugin: `chorus`, `idea`, `brainstorm`, `proposal`, `develop`, `quick-dev`, `review`, `yolo`, and `openspec-aware`. The manifest MUST declare the skills directory so OpenClaw loads them. Each skill MUST be a `<name>/SKILL.md` file with valid frontmatter (`name`, `description`). All skill documentation MUST be in English.

#### Scenario: All nine skill directories are present and declared

- **WHEN** `packages/openclaw-plugin/skills/` is listed
- **THEN** it MUST contain directories `chorus`, `idea`, `brainstorm`, `proposal`, `develop`, `quick-dev`, `review`, `yolo`, and `openspec-aware`, each with a `SKILL.md`
- **AND** `openclaw.plugin.json` MUST declare the skills directory (e.g. `"skills": ["./skills"]`)

#### Scenario: Each skill has valid English frontmatter

- **WHEN** any bundled `SKILL.md` is read
- **THEN** its YAML frontmatter MUST contain a `name` matching the directory name and a non-empty `description`
- **AND** the skill body MUST be written in English

### Requirement: The plugin SHALL bundle the proposal-reviewer and task-reviewer agents

The plugin MUST bundle `agents/proposal-reviewer.md` and `agents/task-reviewer.md`, ported from the Claude Code plugin. Each MUST define a read-only reviewer that posts a `VERDICT:` (PASS / PASS WITH NOTES / FAIL) and MUST NOT be granted write/edit tools.

#### Scenario: Both reviewer agents are present

- **WHEN** `packages/openclaw-plugin/agents/` is listed
- **THEN** it MUST contain `proposal-reviewer.md` and `task-reviewer.md`

#### Scenario: Reviewer agents are read-only and emit a VERDICT

- **WHEN** either reviewer agent definition is read
- **THEN** its instructions MUST require posting a comment containing a line beginning with `VERDICT:` and one of `PASS`, `PASS WITH NOTES`, or `FAIL`
- **AND** its tool configuration MUST exclude file-editing/writing tools (read-only review)

### Requirement: Claude-Code-only workflow mechanics SHALL be adapted for OpenClaw with documented fallbacks

Skills MUST NOT depend on Claude-Code-only mechanisms that OpenClaw lacks. Where a skill previously relied on PostToolUse context injection, SubagentStart session auto-injection, typed foreground sub-agents, or Agent Teams, the skill text MUST instruct the agent to perform the equivalent step inline and MUST document the fallback behavior.

#### Scenario: Reviewer spawning does not assume injected reminders

- **WHEN** the `proposal`, `develop`, and `yolo` skills are read
- **THEN** the instruction to run the reviewer MUST appear inline in the skill text (not deferred to a PostToolUse-injected reminder)
- **AND** the skill MUST describe how to obtain the VERDICT when a typed foreground sub-agent is unavailable on OpenClaw (run the review as a focused read-only pass and record the VERDICT)

#### Scenario: yolo documents sequential wave execution on OpenClaw

- **WHEN** the `yolo` skill is read
- **THEN** it MUST state that, absent an Agent Teams primitive on OpenClaw, task execution proceeds sequentially via the main agent, looping `chorus_get_unblocked_tasks`
- **AND** it MUST NOT instruct the agent to call a Claude-Code-only `TeamCreate` primitive as a hard requirement

#### Scenario: Skills reference the namespaced tool names under OpenClaw

- **WHEN** any bundled skill references Chorus tools
- **THEN** the skill MUST account for the `chorus__` namespace that OpenClaw applies to MCP-sourced tools (either by using the prefixed names or by stating the prefix rule once)

### Requirement: The openspec-aware skill SHALL self-detect OpenSpec mode without the Claude Code SessionStart hook

The ported `openspec-aware` skill MUST NOT assume a SessionStart-injected `CHORUS_OPENSPEC_ACTIVE` value (OpenClaw does not run the Claude Code SessionStart hook). It MUST run the three-check detection (mode not `off`, `openspec/` dir present, `openspec` CLI on PATH) itself. The wrapper-only document-mirror rule and the halt-on-error response check MUST be preserved.

#### Scenario: Detection runs inline in OpenClaw

- **WHEN** the ported `openspec-aware` skill is read
- **THEN** its detection section MUST instruct the agent to compute OpenSpec activeness via the three checks directly
- **AND** it MUST NOT rely solely on a value injected by a Claude Code SessionStart hook

#### Scenario: Wrapper-mirror and halt-on-error rules are retained

- **WHEN** the ported `openspec-aware` skill is read
- **THEN** it MUST retain the rule that document drafts are mirrored via the `chorus-api.sh` wrapper rather than re-typed through the model
- **AND** it MUST retain a halt-on-error response check that treats empty body / error body / non-zero exit as failure
