# reference-association-guidance Specification

## Purpose
TBD - created by archiving change strengthen-reference-association. Update Purpose after archive.
## Requirements
### Requirement: Idea skill teaches the reference-attachment reflex
The idea skill SHALL, in all four skill roots (`public/skill/idea-chorus`, `public/chorus-plugin/skills/idea`, `plugins/chorus/skills/idea`, `packages/openclaw-plugin/skills/idea`), instruct the agent to attach external references as evidence when working an idea, preferring the inline `references[]` param at creation time over a post-hoc `chorus_add_reference`, and SHALL document how to choose among the four reference types (`docs`, `repo`, `issue_pr`, `paper_blog`) with one concrete inline example.

#### Scenario: Idea skill contains reference guidance in every root
- **WHEN** any of the four idea `SKILL.md` files is read
- **THEN** it contains a reference-attachment guidance section that names the inline `references[]` param, states the preference for attaching at creation time, and lists the four types with a selection criterion for each

#### Scenario: Guidance includes a public-safe example
- **WHEN** the idea skill's reference guidance is read
- **THEN** it shows one inline `references[]` usage example built from a generic scenario (e.g. a locale PR / official docs), not bound to any internal idea, and the docs remain in English

#### Scenario: Root-specific conventions are preserved
- **WHEN** the guidance is added to the OpenClaw idea skill root
- **THEN** tool names follow that root's `chorus__`-prefix convention and cross-links follow each root's existing link style, rather than a verbatim copy of another root

### Requirement: Chorus overview skill states the reference reflex
The chorus overview skill SHALL, in all four roots (`public/skill/chorus`, `public/chorus-plugin/skills/chorus`, `plugins/chorus/skills/chorus`, `packages/openclaw-plugin/skills/chorus`), carry an explicit behavioral note that agents attach external evidence on sight — inline at create — beyond the passing mention of the reference tools already present in its tool table.

#### Scenario: Overview skill reinforces the reflex
- **WHEN** any of the four chorus `SKILL.md` files is read
- **THEN** it contains a short behavior note directing the agent to attach external references as evidence (inline at create), in addition to the existing `chorus_add_reference` tool-table row

### Requirement: Daemon wake prompts nudge reference attachment
Both daemon wake-prompt surfaces SHALL carry a one-line reflex nudge to attach external references when working an idea/proposal/task, preferring inline `references[]` at create. The `HEADLESS_PREAMBLE` in `cli/prompts.mjs` and the `composeConversationalIdeaInstruction` template in `src/services/daemon-instruction.service.ts` SHALL each include such a line, and their wording tests SHALL assert the new nudge substring. The nudge SHALL NOT introduce the literal `chorus_pm_start_elaboration` / `chorus_pm_validate_elaboration` tool names into the shared preamble.

#### Scenario: Headless preamble carries the nudge
- **WHEN** a wake prompt is built via the daemon prompt builder
- **THEN** the prepended headless preamble includes a single sentence instructing the agent to attach external references (naming `references[]` and/or `chorus_add_reference`), and does not contain the elaboration-start/validate tool names

#### Scenario: Conversational idea entry carries the nudge
- **WHEN** the conversational-idea wake instruction is composed in either `elaborate` or `decompose` mode
- **THEN** the composed text includes the one-line reference-attachment nudge

#### Scenario: Wake-prompt wording tests are updated
- **WHEN** the wake-orchestration and conversational-instruction test suites run
- **THEN** they assert the presence of the new reference-nudge substring in the respective prompt, keeping the wording an enforced, review-visible diff

#### Scenario: OpenClaw router is intentionally excluded
- **WHEN** the CLI↔OpenClaw wake-parity guard runs
- **THEN** it continues to pass on action-coverage only, and the OpenClaw event-router remains without a headless preamble (no reference nudge is added there)

### Requirement: MCP notes parameter docs nudge concise summaries
The MCP tool documentation for a reference's `notes` parameter SHALL instruct agents to keep the summary to a single concise sentence (about 200 characters, at most two lines), noting that the UI clamps the displayed text to two lines. This wording SHALL appear in every place the `notes` parameter is described: the shared inline `referenceInlineItemSchema` (reused by `chorus_pm_create_idea`, `chorus_pm_create_proposal`, and — via `public.ts` — `chorus_create_tasks`), the `chorus_add_reference` tool, and the `chorus_update_reference` tool. The nudge SHALL be documentation-only: `notes` remains an unconstrained string with no server-side length cap or validation. The `docs/MCP_TOOLS.md` reference rows for `notes` SHALL be updated to match.

#### Scenario: Inline references[] notes describe carries the concise nudge
- **WHEN** the `notes` field of the shared inline reference schema is inspected (`.describe(...)`)
- **THEN** its text asks for one concise sentence and states a ~200-character / two-line target

#### Scenario: add_reference and update_reference notes describe carry the nudge
- **WHEN** the `notes` parameter description of `chorus_add_reference` and of `chorus_update_reference` is inspected
- **THEN** each asks for a concise one-sentence summary with the ~200-character / two-line target, and `chorus_update_reference` still documents that `null` clears and omission leaves it unchanged

#### Scenario: No length validation is introduced
- **WHEN** an over-long `notes` value is submitted to any reference create/update tool
- **THEN** it is accepted and stored verbatim (no `.max()` rejection); the length guidance is advisory only

#### Scenario: MCP tool reference doc matches
- **WHEN** `docs/MCP_TOOLS.md` `notes` rows are read
- **THEN** they carry the same concise-summary guidance as the tool `.describe()` strings

