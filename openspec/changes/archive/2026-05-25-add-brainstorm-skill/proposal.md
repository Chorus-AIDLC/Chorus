# Proposal: Idea-stage brainstorm skill

## Why

Chorus's existing `elaboration` flow is structured Q&A — every question must be a multi-choice `ElaborationQuestion` with 2-5 options. This works well when requirements are concrete enough to enumerate options, but it breaks down when an Idea arrives in "still rephrasing" shape: the PM agent ends up fabricating options just to satisfy the schema, and the audit trail captures forced choices instead of the actual exploration.

Anthropic's `superpowers/brainstorming` skill solved this with a simple cadence — one question at a time, propose 2-3 directions with a recommendation, get user approval before locking in. We want that cadence available inside Chorus's idea workflow without:

- adopting `superpowers/brainstorming`'s terminal contract (write a `docs/superpowers/specs/<topic>-design.md` and hand off to `writing-plans`),
- adding any backend / schema / UI changes,
- mandating it for every Idea — it's only useful when the Idea is genuinely fuzzy.

## What Changes

Add a new opt-in `brainstorm` skill, distributed to **all four** Chorus skill packages so all supported agents can invoke it:

- `public/chorus-plugin/skills/brainstorm/` (Claude Code plugin)
- `plugins/chorus/skills/brainstorm/` (Codex plugin)
- `public/skill/brainstorm-chorus/` (static `/skill/` distribution)
- `packages/openclaw-plugin/skills/brainstorm/` (OpenClaw plugin)

The four `SKILL.md` bodies are byte-identical; only frontmatter (license, version, mcp_server, naming convention per platform) differs.

The skill is invoked from the `idea` skill (also in all four packages) at a new **Step 4.5: Brainstorm Mode (optional prelude)** between context gathering and structured elaboration. After `chorus_claim_idea` succeeds, the idea skill asks the user via `AskUserQuestion` whether to brainstorm. On yes, it invokes the `brainstorm` skill; on no, the existing structured flow continues unchanged.

The `brainstorm` skill:

1. Reads idea content and project context (same gather-context pattern as the idea skill itself).
2. Runs a one-question-at-a-time exploration via `AskUserQuestion`.
3. Once the direction is clear, presents 2-3 approaches with a recommendation and waits for user approval.
4. Compresses the conversation into "decision-point" Q&A: each material decision becomes one `ElaborationQuestion` whose `options` are the directions that were considered, `selectedOptionId` is the chosen one, and `customText` is a 1-3 sentence rationale.
5. Calls `chorus_pm_start_elaboration` (depth: `"standard"`) and `chorus_answer_elaboration` to persist the round.
6. **Does not** call `chorus_pm_validate_elaboration`. The validate / follow-up decision belongs to the calling idea skill.

Returning to the idea skill, the agent decides:

- Brainstorm answers cover everything → call `validate_elaboration` with `issues: []` to resolve.
- New gaps surfaced during brainstorm → call `validate_elaboration` with `issues + followUpQuestions` to start a structured Round 2 (depth chosen by the agent without asking the user again).

## Capabilities

This change adds one new capability:

- **`idea-elaboration-brainstorm`** — opt-in idea-stage brainstorm prelude that synthesizes free-form exploration into ElaborationRound Q&A, with no backend/schema/UI impact.

## Impact

- **Affected code**: 8 files (4 new `brainstorm/SKILL.md`, 4 modified `idea/SKILL.md`); zero TypeScript / Prisma / React.
- **Affected workflows**: PM agents claiming fuzzy ideas; existing elaboration flows are not touched.
- **Affected runtime**: none. No migrations, no new dependencies, no MCP tool changes, no config flags.
- **Risk**: low. The branch is opt-in (user has to say yes to brainstorm). If the brainstorm cadence misbehaves, fallback is "answer no, run structured elaboration" — identical to today.
- **Out of scope (deferred)**: backend `ElaborationRound.kind` field; UI rendering changes for brainstorm rounds; mid-conversation recovery if user abandons brainstorm; design doc / writing-plans handoff.
