# idea-elaboration-brainstorm Specification

## Purpose

The `brainstorm` skill provides an opt-in divergent-then-convergent dialogue cadence for Idea-stage elaboration when the Idea is too fuzzy for the existing structured multi-choice Q&A flow. The skill runs one question at a time, proposes 2-3 directions with a recommendation, gets explicit user approval, and synthesizes the conversation into one `ElaborationRound` of decision-point Q&A. It is a producer of audit-trail data, not a scheduler — the calling idea skill owns the validate / follow-up decision. The skill ships in all four Chorus skill distribution packages (Claude Code plugin, Codex plugin, public/skill/, OpenClaw plugin).
## Requirements
### Requirement: Brainstorm skill SHALL be distributed to all four Chorus skill packages

The brainstorm skill MUST be present in each of the four skill distribution paths so that any supported agent can invoke it without per-platform divergence in behavior:

- `public/chorus-plugin/skills/brainstorm/SKILL.md` (Claude Code plugin)
- `plugins/chorus/skills/brainstorm/SKILL.md` (Codex plugin)
- `public/skill/brainstorm-chorus/SKILL.md` (static skill distribution served at `/skill/`)
- `packages/openclaw-plugin/skills/brainstorm/SKILL.md` (OpenClaw plugin)

The body content of `brainstorm/SKILL.md` MUST be byte-identical across the three Chorus-native packages (Claude Code plugin, Codex plugin, public/skill/), modulo trailing newline. The OpenClaw distribution (`packages/openclaw-plugin/skills/brainstorm/SKILL.md`) MAY diverge in two narrow cases — and ONLY these two:

1. **MCP tool name prefixes.** OpenClaw re-exports the Chorus elaboration tools without the `pm_` prefix (`chorus_start_elaboration` / `chorus_validate_elaboration` instead of `chorus_pm_start_elaboration` / `chorus_pm_validate_elaboration`). The OpenClaw copy MUST substitute the unprefixed names in step 6, step 7, hard rule 8, and the anti-patterns section. `chorus_answer_elaboration` keeps the same name across packages.
2. **Host-specific prompt-tool examples.** The Claude Code / Codex / public-skill copies MAY reference `AskUserQuestion` (Claude Code's native interactive prompt tool) by name; the OpenClaw copy MUST use host-neutral language ("user-facing prompt", "interactive prompt mechanism your host provides") since OpenClaw exposes a different prompt surface.

No other content divergence is permitted in any package. Frontmatter MAY differ to match each platform's manifest conventions (e.g. license, version, mcp_server, emoji, distribution-specific naming) and is NOT subject to byte-identity.

The byte-identity requirement applies ONLY to `brainstorm/SKILL.md`. The `idea/SKILL.md` files in the four packages MAY still differ in cross-skill reference syntax (e.g. `/proposal` vs `proposal-chorus` skill at a URL), as they already do today for existing references. See the separate "Idea skill SHALL offer brainstorm as an opt-in prelude" requirement for what idea/SKILL.md must contain.

#### Scenario: All four package locations contain the skill

- **WHEN** a release artifact is built from `develop`
- **THEN** each of the four `brainstorm/SKILL.md` paths above MUST exist
- **AND** the body content of the three Chorus-native packages (Claude Code plugin, Codex plugin, public/skill/) MUST be byte-identical
- **AND** the OpenClaw body MUST be byte-identical to the Chorus-native bodies EXCEPT for the two carve-outs above (MCP tool name prefixes; host-neutral prompt language)

#### Scenario: Brainstorm skill body diverges across packages

- **WHEN** a CI check or reviewer compares the four `brainstorm/SKILL.md` bodies
- **AND** any two bodies differ in non-whitespace content beyond the two carve-outs above (modulo trailing newlines)
- **THEN** the divergence MUST be flagged as a blocker for merge

#### Scenario: OpenClaw uses Chorus-native MCP tool names

- **WHEN** a CI check or reviewer reads `packages/openclaw-plugin/skills/brainstorm/SKILL.md`
- **AND** the body references `chorus_pm_start_elaboration` or `chorus_pm_validate_elaboration` (the prefixed Chorus-native names)
- **THEN** the divergence MUST be flagged as a blocker for merge — OpenClaw exposes these tools as `chorus_start_elaboration` / `chorus_validate_elaboration` and the prefixed names will fail at the tool-call layer.

### Requirement: Idea skill SHALL offer brainstorm as an opt-in prelude

The `idea` skill in each of the four packages MUST include a "Step 4.5: Brainstorm Mode" between context gathering (current Step 4) and structured elaboration (current Step 5). The step uses `AskUserQuestion` to ask the user whether to brainstorm before structured elaboration begins.

#### Scenario: User opts to brainstorm

- **WHEN** the agent has just completed `chorus_claim_idea` and gather-context for an Idea
- **AND** the agent prompts via `AskUserQuestion` with header "Brainstorm" and options "Already clear, run structured elaboration" vs "Brainstorm first to explore directions"
- **AND** the user selects "Brainstorm first to explore directions"
- **THEN** the agent SHALL invoke the `brainstorm` skill
- **AND** SHALL NOT call `chorus_pm_start_elaboration` until the brainstorm skill returns

#### Scenario: User opts to skip brainstorm

- **WHEN** the agent prompts via `AskUserQuestion` with the brainstorm choice
- **AND** the user selects "Already clear, run structured elaboration"
- **THEN** the agent SHALL proceed directly to current Step 5 (structured elaboration) with no calls to the brainstorm skill
- **AND** the existing minimal/standard/comprehensive depth flow MUST behave identically to its pre-change form

### Requirement: Brainstorm skill SHALL run divergent-then-convergent dialogue

The brainstorm skill MUST follow a one-question-at-a-time cadence: ask one `AskUserQuestion` at a time during the divergent phase, then propose 2-3 distinct directions with one explicitly recommended, and require explicit user approval before exiting the divergent phase.

#### Scenario: Divergent phase asks one question per turn

- **WHEN** the brainstorm skill is exploring requirements
- **THEN** each `AskUserQuestion` call MUST contain exactly one `question` entry
- **AND** the skill MUST wait for the user's answer before asking the next question

#### Scenario: Convergence presents 2-3 alternatives with a recommendation

- **WHEN** the brainstorm skill judges that the requirement direction is clear enough
- **THEN** the skill MUST present 2-3 distinct approaches in a single `AskUserQuestion`
- **AND** exactly one approach MUST be visibly marked as the recommended option to the user (the specific marking convention — e.g. ordering, label suffix — follows whatever the host tool's `AskUserQuestion` documentation prescribes; the spec does not dictate the marking format)

#### Scenario: Skill exits divergent phase only after explicit approval

- **WHEN** the brainstorm skill has presented 2-3 approaches
- **AND** the user selects one
- **THEN** the skill MAY proceed to synthesis
- **AND** SHALL NOT proceed to synthesis if the user has not selected an option

### Requirement: Brainstorm skill SHALL synthesize conversation as decision-point Q&A

The brainstorm skill MUST compress the conversation into one `ElaborationQuestion` per material decision point. Each synthesized question MUST be a well-formed `ElaborationQuestion` accepted by `chorus_pm_start_elaboration`.

#### Scenario: Each decision becomes one ElaborationQuestion

- **WHEN** the brainstorm skill performs synthesis
- **THEN** for each material decision the user made during the conversation, exactly one `ElaborationQuestion` MUST be produced
- **AND** that question's `options` array MUST list the directions that were considered (2-5 options; near-duplicates collapsed)
- **AND** `selectedOptionId` MUST identify the direction the user approved
- **AND** `customText` MUST contain a 1-3 sentence rationale capturing the constraint or tradeoff that drove the choice

#### Scenario: Synthesis preserves outcomes, not transcript

- **WHEN** the brainstorm skill performs synthesis
- **THEN** the skill MUST NOT post the raw conversation transcript as a comment, document draft, file, or `customText` blob
- **AND** the skill MUST NOT write any file on disk
- **AND** the skill MUST NOT invoke any `writing-plans`, `writing-skills`, or design-doc-producing skill

### Requirement: Brainstorm skill SHALL persist exactly one ElaborationRound and return control

The brainstorm skill is the *producer* of the brainstorm round; the calling `idea` skill is the *scheduler* that decides whether to validate or follow up. The brainstorm skill MUST NOT call `chorus_pm_validate_elaboration`.

#### Scenario: Skill terminates after answer_elaboration succeeds

- **WHEN** the brainstorm skill has called `chorus_pm_start_elaboration` (depth: `"standard"`) successfully
- **AND** has called `chorus_answer_elaboration` successfully
- **THEN** the skill MUST return control to the calling idea skill
- **AND** SHALL NOT call `chorus_pm_validate_elaboration` itself

#### Scenario: Calling idea skill chooses validate or follow-up

- **WHEN** the brainstorm skill has returned to the calling idea skill
- **AND** the synthesized round answers cover all open questions
- **THEN** the idea skill SHALL call `chorus_pm_validate_elaboration` with `issues: []` to resolve elaboration

- **WHEN** the brainstorm skill has returned to the calling idea skill
- **AND** the synthesized round answers leave gaps the agent can articulate as concrete follow-up questions
- **THEN** the idea skill SHALL call `chorus_pm_validate_elaboration` with `issues: [...]` and `followUpQuestions: [...]` to start a structured Round 2
- **AND** the follow-up depth (minimal / standard / comprehensive) is chosen by the agent without re-prompting the user

### Requirement: Change SHALL NOT modify backend, schema, or UI

This change MUST be documentation-only. No production TypeScript, Prisma migration, React component, MCP tool registration, REST endpoint, or runtime config flag SHALL be added or modified by this change.

#### Scenario: Change touches only skill markdown files

- **WHEN** the change diff is reviewed
- **THEN** all modified files MUST be `*.md` under one of the four skill distribution roots
- **AND** no file under `src/`, `prisma/`, `messages/`, `public/` (except `public/skill/` and `public/chorus-plugin/skills/`), `packages/chorus-cdk/`, `packages/openclaw-plugin/` (except `packages/openclaw-plugin/skills/`) may be modified
- **AND** no Prisma migration may be added under `prisma/migrations/`

#### Scenario: Brainstorm round is well-formed against current schema

- **WHEN** the brainstorm skill calls `chorus_pm_start_elaboration` and `chorus_answer_elaboration`
- **THEN** the resulting `ElaborationRound` and its `ElaborationQuestion` rows MUST validate against the current Prisma schema with no new fields
- **AND** the round MUST render correctly in the existing elaboration UI without UI changes

