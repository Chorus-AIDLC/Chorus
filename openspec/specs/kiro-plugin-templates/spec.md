# kiro-plugin-templates Specification

## Purpose
TBD - created by archiving change add-kiro-cli-plugin. Update Purpose after archive.
## Requirements
### Requirement: Kiro `.kiro/` template tree ships all Chorus artifacts
Chorus SHALL provide a source-of-truth template tree at `public/kiro-plugin/.kiro/` containing the Chorus MCP config (`settings/mcp.json`), the ported AI-DLC skills (`skills/chorus-*/SKILL.md`), a `chorus` main agent plus three read-only reviewer subagents (`agents/*.json` — Kiro CLI agent format), and a Chorus project-context steering doc (`steering/chorus.md`). This template is the single source of truth for the Kiro `.kiro/` artifacts; the daemon `--agent kiro` child reuses it rather than authoring its own copy.

#### Scenario: Template tree contains every declared artifact
- **WHEN** `public/kiro-plugin/.kiro/` is inspected
- **THEN** it contains `settings/mcp.json`, one `skills/chorus-<name>/SKILL.md` per ported skill, `agents/chorus.json` plus `agents/chorus-code-reviewer.json` / `agents/chorus-proposal-reviewer.json` / `agents/chorus-task-reviewer.json` (Kiro CLI agents are JSON, not Markdown), and `steering/chorus.md`

#### Scenario: MCP config uses a static bearer header, not OAuth
- **WHEN** `settings/mcp.json` is read
- **THEN** it defines a `chorus` remote server with `type:"http"`, `url` pointing at the Chorus `/api/mcp` endpoint, and a `headers.Authorization` value of `Bearer ${env:CHORUS_API_KEY}` (Kiro-CLI `${env:VAR}` interpolation form), and contains no OAuth block

### Requirement: All Kiro skills and agents carry the `chorus` prefix
Because the plugin installs into a global `~/.kiro/` by default, every shipped skill and agent name SHALL carry a `chorus` prefix for distinctiveness against a user's own global skills. Skills SHALL be named `chorus-idea`, `chorus-proposal`, `chorus-develop`, `chorus-yolo`, `chorus-review`, `chorus-quick-dev`, `chorus-brainstorm`, and `chorus-openspec-aware` (`.md`); agents SHALL be named `chorus` (main), `chorus-code-reviewer`, `chorus-proposal-reviewer`, and `chorus-task-reviewer` (`.json` — Kiro CLI format). Intra-skill cross-references to other Chorus skills SHALL use the prefixed slash-command form.

#### Scenario: Skill and agent filenames are prefixed
- **WHEN** the `skills/` and `agents/` directories are listed
- **THEN** every skill directory is named `chorus-<stage>` and every agent file is `chorus.json` or `chorus-<role>.json`, with no bare `idea`/`proposal`/`develop` names

#### Scenario: Skill frontmatter name matches the prefixed directory
- **WHEN** any `skills/chorus-<name>/SKILL.md` frontmatter is read
- **THEN** its `name:` field equals `chorus-<name>` (lowercase, hyphenated, ≤64 chars) and its `description:` is a non-empty activation matcher (≤1024 chars)

#### Scenario: Cross-references are rewritten to the prefixed form
- **WHEN** a ported skill body references another Chorus skill (e.g. the idea skill pointing to the proposal skill)
- **THEN** it uses the `/chorus-<stage>` slash-command form, not a bare `/proposal`

### Requirement: The `chorus` main agent wires skills, steering, MCP, and subagent spawning
The `agents/chorus.json` main agent SHALL list every shipped `chorus-*` skill via `skill://` URIs and the steering doc via a `file://` URI in its `resources`, SHALL pull in the shared MCP server via `includeMcpJson: true`, and SHALL include `subagent` in its `tools` so it can spawn the reviewer subagents. Because custom Kiro agents do not auto-load skills or steering, omitting these `resources` entries would leave the skills unavailable. The repo copy of `chorus.json` SHALL carry the `__CHORUS_BIN__` placeholder in every hook `command` (concretized by the installer — see the installer capability).

#### Scenario: Main agent resources list all skills and steering
- **WHEN** `agents/chorus.json` is read
- **THEN** its `resources` include a `skill://` entry resolving to every `chorus-*` skill and a `file://` entry resolving to `steering/chorus.md`

#### Scenario: Main agent can reach MCP and spawn subagents
- **WHEN** `agents/chorus.json` is read
- **THEN** it sets `includeMcpJson: true` and its `tools` include both the `@chorus` MCP sigil and `subagent`

#### Scenario: Hook command paths use the install-time placeholder
- **WHEN** the repo `agents/chorus.json` hook `command` strings are read
- **THEN** each references the hook script via the `__CHORUS_BIN__` placeholder rather than a hard-coded machine path, so the installer can substitute the resolved absolute path per scope

### Requirement: Reviewer agents are read-only subagents
Each of the three reviewer agents (`chorus-code-reviewer`, `chorus-proposal-reviewer`, `chorus-task-reviewer`) SHALL be scoped read-only by declaring `tools` of only `read` and `@chorus` (no `write`, no `shell`), SHALL carry a `description` that lets Kiro auto-select it for the matching review task, and SHALL preserve the VERDICT protocol (PASS / PASS WITH NOTES / FAIL) ported from the Claude Code reviewer agents.

#### Scenario: Reviewer tool scope excludes write and shell
- **WHEN** any `agents/chorus-*-reviewer.json` is read
- **THEN** its `tools` contain `read` and `@chorus` only, with no `write` or `shell` entry

#### Scenario: Reviewer carries the VERDICT protocol
- **WHEN** a reviewer agent's prompt (inline or `file://` sidecar) is read
- **THEN** it instructs the reviewer to post a comment ending in `VERDICT: PASS`, `VERDICT: PASS WITH NOTES`, or `VERDICT: FAIL`, matching the Claude Code reviewer contract

### Requirement: Steering doc carries the platform overview instead of a `chorus` skill
The overview content that other surfaces ship as a `chorus` skill SHALL instead live in `steering/chorus.md`, so that the `/chorus` slash command unambiguously activates the `chorus` main agent with no skill/agent collision. No `chorus` (unprefixed, non-stage) skill directory SHALL be shipped.

#### Scenario: No overview skill is shipped
- **WHEN** the `skills/` directory is listed
- **THEN** there is no `skills/chorus/SKILL.md` overview skill, and `steering/chorus.md` contains the platform overview, AI-DLC workflow, and role/permission context

