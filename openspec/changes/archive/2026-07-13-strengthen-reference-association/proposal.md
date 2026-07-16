## Why

Reference artifacts (`chorus_add_reference` + the inline `references[]` param on create, types `docs` / `repo` / `issue_pr` / `paper_blog`, shipped in #418) are the first-class field for hanging **external evidence** — a precedent issue, a reference implementation, official docs, a related PR — onto an idea / proposal / task. But in practice agents almost never reach for it. A real case: the 0.14.0 "complete Korean locale" idea was plainly related to its delivery PR #419 and the prior `ko` work in #411, yet went the whole lifecycle with **zero** references attached until a human pointed it out.

The root cause is that the agent-facing surfaces never tell the agent to do it (grep-confirmed, not a guess):

- The **idea skill** mentions references **0 times** across all four skill roots — and idea → proposal → execute is exactly the stage where hanging precedent/evidence at the source matters most.
- The **chorus overview skill** names the reference tools in passing (a tool table row) but carries no "see an external link → attach it now" behavioral guidance.
- **Both daemon wake prompts** mention references **0 times**: the headless preamble in `cli/prompts.mjs` that rides every wake, and the conversational-idea entry template in `src/services/daemon-instruction.service.ts`. A headless agent woken to work an idea/proposal/task gets no nudge to associate external references.

Separately, the reference **display** has a pre-existing UI bug: a long URL or title overflows its card because the link anchor is `inline-flex` (it shrink-wraps to its content and ignores the parent's width), so the inner `truncate` span never engages.

## What Changes

- **Idea skill (all 4 roots): add reference guidance from scratch.** A short "External references" subsection in the Gather-Context / elaboration flow: when you encounter an external link (precedent issue/PR, reference implementation, official docs, paper/blog), attach it **at creation time** via the inline `references[]` param (preferred over a post-hoc `chorus_add_reference`), and how to pick among the four types. One generic inline example (locale-PR / official-docs scenario — not bound to any internal idea, since these docs ship publicly in English).
- **Chorus overview skill (all 4 roots): strengthen the existing mention into a reflex.** Turn the passing tool-table reference into an explicit "attach external evidence on sight, inline at create" behavior note, cross-linked from the shared-tools area.
- **Both daemon wake prompts: one-line reflex nudge each.** Add a single compact sentence to the `HEADLESS_PREAMBLE` in `cli/prompts.mjs` (rides every wake) and to `composeConversationalIdeaInstruction` in `src/services/daemon-instruction.service.ts`: when working an idea/proposal/task, if you hit an external link, attach it via references, preferring inline `references[]` at create. Kept to one line — the preamble is paid on every wake.
- **Fix the long-URL/title overflow** in the reference display: constrain the link anchor so its inner `truncate` span actually engages. Both render sites — `src/components/references-section.tsx` and `src/app/(dashboard)/projects/[uuid]/dashboard/idea-references-panel.tsx` — verified in light and dark themes.

Out of scope (confirmed in elaboration): MCP tool-description changes (Q1=a); an empty-references soft-hint UI feature (Q1=a rejected it — the UI work here is only the overflow bug); the proposal / develop / quick-dev / review skills (Q2 narrowed skill scope to idea + chorus); the OpenClaw wake router, which deliberately carries no headless preamble (the CLI↔OpenClaw parity guard checks action coverage only, not prompt text).

## Capabilities

### Added Capabilities
- `reference-association-guidance`: the agent-facing surfaces (idea skill, chorus overview skill, and both daemon wake prompts) SHALL instruct agents to attach external references as evidence, preferring inline `references[]` at creation, so that hanging external evidence becomes a default reflex rather than a forgotten step.
- `reference-display`: the reference list UI SHALL keep an over-long reference URL or title within its card via truncation, so a pasted long link never breaks the card layout in either theme.

## Impact

- **Skill docs (idea, 4 roots)** — `public/skill/idea-chorus/SKILL.md`, `public/chorus-plugin/skills/idea/SKILL.md`, `plugins/chorus/skills/idea/SKILL.md`, `packages/openclaw-plugin/skills/idea/SKILL.md`.
- **Skill docs (chorus overview, 4 roots)** — `public/skill/chorus/SKILL.md`, `public/chorus-plugin/skills/chorus/SKILL.md`, `plugins/chorus/skills/chorus/SKILL.md`, `packages/openclaw-plugin/skills/chorus/SKILL.md`.
- **Wake prompts** — `cli/prompts.mjs` (`HEADLESS_PREAMBLE`) and `src/services/daemon-instruction.service.ts` (`composeConversationalIdeaInstruction`, both `elaborate` and `decompose` share the same preamble line). Their wording tests: `cli/__tests__/wake-orchestration.test.mjs` and `src/services/__tests__/daemon-instruction.conversational.test.ts`.
- **UI** — `src/components/references-section.tsx`, `src/app/(dashboard)/projects/[uuid]/dashboard/idea-references-panel.tsx`. No i18n string changes (behavior-only CSS fix). No runtime/schema/API changes.
