# dsh-skill-bundle Specification

## Purpose
Define the installer-ready dsh Chorus skill, preset, instruction, and verification bundle for headless AI-DLC workflows.
## Requirements
### Requirement: Distribution SHALL contain the complete dsh Chorus skill set

The repository SHALL provide an installer-ready `public/dsh-plugin/skills/` tree containing English dsh-adapted copies of `chorus`, idea, proposal, develop, yolo, review, quick-dev, brainstorm, openspec-aware, orchestrate, docs, proposal-reviewer, task-reviewer, and code-reviewer workflows. Every entry MUST use a one-level `<skill-name>/SKILL.md` layout, valid YAML frontmatter, a kebab-case name matching its directory, and a non-empty description so dsh's filesystem provider can discover it.

#### Scenario: dsh discovers the expected catalog

- **WHEN** the bundle's `skills/*` directories are installed into `$DSH_HOME/skills/` and a dsh session exposes the `skill` tool
- **THEN** the `<available_skills>` catalog MUST contain all fourteen expected Chorus skills
- **AND** no expected skill MUST be dropped because of invalid layout or frontmatter

#### Scenario: a catalog entry loads its instructions

- **WHEN** the dsh agent calls the `skill` tool with `chorus` or any expected stage skill name
- **THEN** the tool MUST return that skill's current English instruction body
- **AND** its resource guidance MUST resolve relative references from the installed skill directory

### Requirement: Skill semantics SHALL be adapted to dsh and headless Chorus operation

The dsh skill copies SHALL preserve the corresponding Chorus workflow semantics while using dsh's skill catalog and MCP naming. They MUST NOT require unavailable Claude Code or Codex hook behavior. In a headless daemon session they MUST prohibit interactive human prompts, route human decisions through Chorus elaboration or comments, and end the turn after posting a decision request. Reviewer workflows MUST define a dsh-compatible delegated review path and an inline read-only fallback.

#### Scenario: headless workflow reaches a human decision

- **WHEN** a loaded skill requires human clarification or approval and `CHORUS_DAEMON_HEADLESS=1`
- **THEN** the instructions MUST direct the agent to persist the question through Chorus elaboration and/or an @mention comment
- **AND** the instructions MUST direct the agent to end the turn without polling or blocking for a response

#### Scenario: workflow references Chorus MCP tools

- **WHEN** a dsh skill names a Chorus operation
- **THEN** it MUST account for the MCP namespace exposed by dsh rather than assuming a Claude Code-only bare tool binding
- **AND** it MUST preserve the underlying `chorus_*` operation and argument semantics

#### Scenario: independent review is requested

- **WHEN** proposal, task, or aggregate code review is required
- **THEN** the instructions MUST load the matching reviewer skill in an available read-only dsh sub-agent context
- **AND** they MUST define an inline read-only review fallback when sub-agent delegation is unavailable
- **AND** the resulting review MUST post the reviewer's required `VERDICT:` comment to Chorus

#### Scenario: OpenSpec mode is evaluated

- **WHEN** the dsh OpenSpec-aware skill reaches an OpenSpec authoring step
- **THEN** it MUST evaluate mode, repository, and CLI availability without relying on a Chorus SessionStart hook
- **AND** it MUST preserve byte-exact wrapper-based document mirroring and visible halt-on-error behavior
- **AND** it MUST require the installer-provided `$DSH_HOME/chorus/bin/chorus-mcp-call.sh` contract rather than reproducing the transport ad hoc

### Requirement: Chorus prompt behavior SHALL be opt-in through a dedicated dsh preset

The bundle SHALL provide a loadable `chorus` user preset for dsh `0.1.0-rc.7` that is based on the standard direct-tool composition. The preset MUST mount `@deepseek-ai/dsh-persona` with a Chorus PM/developer identity and `@deepseek-ai/dsh-agent-instructions` with a Chorus-specific instruction root. It MUST NOT modify dsh's shipped `standard`, `code`, `cordis`, or `minimal` presets, and MUST NOT require Chorus rules in the global `$DSH_HOME/AGENTS.md`.

#### Scenario: Chorus preset starts

- **WHEN** the preset directory is installed at `$DSH_HOME/.agent-presets/chorus/` and a new dsh session selects `chorus`
- **THEN** dsh MUST parse and mount the composition successfully
- **AND** the assembled system prompt MUST contain the Chorus PM/developer persona
- **AND** direct `skill` and MCP tool presentation from the standard-derived composition MUST remain available

#### Scenario: Chorus instructions are loaded

- **WHEN** the installer places the bundled instruction file at `$DSH_HOME/chorus/AGENTS.md` and a new session selects the `chorus` preset
- **THEN** the initial agent-instructions context MUST contain the Chorus operating rules
- **AND** normal project-level AGENTS instruction discovery MUST continue to apply

#### Scenario: stock preset remains unchanged

- **WHEN** a new dsh session selects a shipped non-Chorus preset
- **THEN** the bundle MUST NOT replace that preset's persona
- **AND** the session MUST NOT receive the Chorus-specific AGENTS file as its user-global instruction source

### Requirement: Bundle SHALL define a deterministic installer handoff

The bundle SHALL document a deterministic source-to-destination contract: skills to `$DSH_HOME/skills/`, the Chorus preset to `$DSH_HOME/.agent-presets/chorus/`, and Chorus instructions to `$DSH_HOME/chorus/AGENTS.md`. This change MUST NOT implement installation, credential storage, MCP connection configuration, or user-home mutation.

#### Scenario: sibling installer consumes the bundle

- **WHEN** `install-dsh.sh` needs to install the skill-layer artifacts
- **THEN** it MUST be able to derive every source and destination from the bundle README without copying files from another Chorus harness surface
- **AND** it MUST be able to install MCP wiring separately from these artifacts

#### Scenario: repository change is reviewed for scope

- **WHEN** the implementation diff is inspected
- **THEN** runtime deliverables for this capability MUST be confined to `public/dsh-plugin/` plus focused validation tests and the OpenSpec change
- **AND** it MUST contain no dsh event-hook TypeScript, daemon bridge behavior, credential handling, or installer writes

### Requirement: Verification SHALL exercise dsh discovery and prompt assembly

The implementation MUST include deterministic static validation and MUST run a local dsh smoke test using an isolated temporary dsh home. The smoke test SHALL verify catalog discovery, skill loading, persona assembly, and AGENTS instruction injection without requiring a live Chorus MCP operation.

#### Scenario: static validation passes

- **WHEN** the bundle validation is run
- **THEN** it MUST verify the expected files, frontmatter names and descriptions, preset identity rows, and dsh-loadable configuration
- **AND** it MUST fail on known harness-incompatible interactive or hook assumptions

#### Scenario: local runtime smoke passes

- **WHEN** the bundle is installed into an isolated temporary dsh home and a local dsh `0.1.0-rc.7` session starts with the `chorus` preset
- **THEN** captured model-visible state MUST show the expected skill catalog and successful skill loading
- **AND** it MUST show both the Chorus persona and Chorus AGENTS rules
- **AND** the test MUST NOT fail solely because Chorus MCP wiring or the Chorus server is unavailable
