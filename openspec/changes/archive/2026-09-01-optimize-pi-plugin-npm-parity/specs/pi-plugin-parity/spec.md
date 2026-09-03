## ADDED Requirements

### Requirement: pi reviewer subagents use the official pi subagent pattern
The chorus-pi package SHALL provide reviewer subagents through pi's official subagent pattern (copied from `examples/extensions/subagent/`), replacing the third-party `@narumitw/pi-subagents` dependency. The `@narumitw/pi-subagents` peer dependency SHALL be removed, and the extension's tool-name references (`extensions/chorus.ts`) SHALL be updated from the narumitw tool names to the official `subagent` tool. The 3 reviewer agents (`chorus-code-reviewer`, `chorus-task-reviewer`, `chorus-proposal-reviewer`) SHALL remain invocable and keep their read-only reviewer behavior.

#### Scenario: narumitw dependency removed
- **WHEN** `packages/chorus-pi/package.json` is read
- **THEN** `@narumitw/pi-subagents` is absent from all dependency blocks

#### Scenario: reviewer agents load and are usable
- **WHEN** the chorus-pi extension is loaded in a pi session
- **THEN** the `subagent` tool is registered and the three reviewer agents are discoverable and dispatchable

### Requirement: reviewer agents load from the package without manual copy
Agent definitions bundled in `packages/chorus-pi/agents/*.md` SHALL be discovered directly from the package directory (resolved relative to the extension module), with **no** manual copy into `~/.pi/agent/agents/`. This is achieved by extending the copied `agents.ts` discovery to also load from a package-relative `agents/` directory.

#### Scenario: bundled agents discovered with zero setup
- **WHEN** a pi session loads the installed chorus-pi extension and no files were copied into `~/.pi/agent/agents/`
- **THEN** the three chorus reviewer agents are still discovered from the package's own `agents/` directory

#### Scenario: agent frontmatter matches the official parser
- **WHEN** each reviewer agent file is parsed
- **THEN** it has string `name` and `description` frontmatter (required by the parser) and a body used as the system prompt, so none are silently skipped

### Requirement: chorus-pi ships the brainstorm skill
The chorus-pi package SHALL include a `brainstorm` skill (ported from the Claude Code plugin) so pi reaches functional parity with the CC plugin's skill set. Claude-only hooks (plan-mode Enter/Exit, TeammateIdle, TaskCompleted) are explicitly out of scope — pi has no analog.

#### Scenario: brainstorm skill present
- **WHEN** `packages/chorus-pi/skills/` is listed
- **THEN** a `brainstorm/SKILL.md` exists alongside the other skills, and `check:package` counts it in the expected skill set
