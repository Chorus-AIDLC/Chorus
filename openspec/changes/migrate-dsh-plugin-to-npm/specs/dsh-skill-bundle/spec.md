## MODIFIED Requirements

### Requirement: Distribution SHALL contain the complete dsh Chorus skill set

The public `@chorus-aidlc/chorus-dsh` package SHALL contain a `skills/` tree with English dsh-adapted copies of `chorus`, idea, proposal, develop, yolo, review, quick-dev, brainstorm, openspec-aware, orchestrate, docs, proposal-reviewer, task-reviewer, and code-reviewer workflows. Every entry MUST use a one-level `<skill-name>/SKILL.md` layout, valid YAML frontmatter, a kebab-case name matching its directory, and a non-empty description. The bundle patch MUST register the package-local directory through `@deepseek-ai/dsh-skill-filesystem.customSkillDirs` resolved from Loader `baseUrl`.

#### Scenario: dsh discovers the packaged catalog

- **WHEN** the npm bundle is active in a dsh composition and the `skill` tool is available
- **THEN** the `<available_skills>` catalog MUST contain all fourteen expected Chorus skills
- **AND** discovery MUST read from the installed package rather than `$DSH_HOME/skills`

#### Scenario: a catalog entry loads its instructions

- **WHEN** the dsh agent calls the `skill` tool with `chorus` or any expected stage skill name
- **THEN** the tool MUST return that packaged skill's current English instruction body
- **AND** its resource guidance MUST resolve relative references from the installed package directory

### Requirement: Verification SHALL exercise dsh discovery and prompt assembly

The implementation MUST include deterministic package validation and a real dsh smoke test using a packed local npm artifact. Verification SHALL cover catalog discovery, skill loading, inline persona/instruction assembly, and absence of Chorus writes beneath an isolated `$DSH_HOME`.

#### Scenario: package validation passes

- **WHEN** the package validation is run
- **THEN** it MUST verify tarball membership, frontmatter names and descriptions, bundle patch rows, package-local skill resolution, and absence of copied preset/instruction destinations
- **AND** it MUST fail on known harness-incompatible interactive or hook assumptions

#### Scenario: local runtime smoke passes

- **WHEN** the packed bundle is installed into an isolated dsh profile and a local dsh `0.1.0-rc.7` session starts
- **THEN** captured model-visible state MUST show the expected skill catalog and successful skill loading
- **AND** it MUST show both the Chorus persona and operating instructions
- **AND** no Chorus-managed file MUST be created beneath `$DSH_HOME`

## ADDED Requirements

### Requirement: Chorus prompt behavior SHALL be supplied by bundle composition

The npm bundle SHALL apply the external `@deepseek-ai/dsh-persona` peer through a package controller on each agent's scoped context with a Chorus PM/developer identity and SHALL provide Chorus operating instructions as inline package configuration. It MUST NOT mount that peer at the root where it collides with the deployment persona. It MUST NOT install or register a named Chorus agent preset, configure `AgentPresets.Config.roots`, or require a Chorus-specific instruction file under `$DSH_HOME`.

#### Scenario: Bundle composition starts

- **WHEN** an interactive profile or daemon config activates `@chorus-aidlc/chorus-dsh`
- **THEN** the assembled system prompt MUST contain the Chorus identity and operating rules
- **AND** direct skill and MCP tool presentation MUST remain available

#### Scenario: Stock presets remain untouched

- **WHEN** the package is added to one dsh profile
- **THEN** the package MUST NOT create a named preset or modify any shipped preset
- **AND** another profile that does not include the bundle MUST remain Chorus-unaware

### Requirement: npm package SHALL be the deterministic skill handoff

The packed npm artifact SHALL be the only source-to-runtime handoff for Chorus dsh skills and prompt configuration. Package build and publication checks MUST prove that every required source is present without copying files into dsh-owned directories.

#### Scenario: Release consumes the skill bundle

- **WHEN** the package is built and packed
- **THEN** every skill and prompt artifact required by the bundle patch MUST resolve within the package
- **AND** no installer mapping to `$DSH_HOME/skills`, `$DSH_HOME/.agent-presets`, or `$DSH_HOME/chorus` MUST exist

## REMOVED Requirements

### Requirement: Chorus prompt behavior SHALL be opt-in through a dedicated dsh preset

**Reason**: npm bundle activation now supplies Chorus prompt behavior directly and dsh has no programmatic named-preset registration requirement for this integration.

**Migration**: Add `@chorus-aidlc/chorus-dsh` to the desired dsh profile or daemon composition.

### Requirement: Bundle SHALL define a deterministic installer handoff

**Reason**: The npm tarball replaces the copied-file installer contract.

**Migration**: Package skills and inline prompt configuration under `packages/chorus-dsh` and validate them through packed-package tests.
