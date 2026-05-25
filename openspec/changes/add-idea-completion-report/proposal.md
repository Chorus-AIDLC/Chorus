# Proposal: Idea-completion summary report

## Why

When an Idea finishes its full AI-DLC pipeline (elaboration → proposal → tasks all verified), the working state lives scattered across Chorus: the original Idea body captures the framing-time intent, ElaborationRound captures decision-point Q&A, the Proposal carries the plan-time PRD/tech-design, and Tasks + AcceptanceCriteria capture what was actually built and verified. There is no single artifact that ties those four surfaces together at delivery time.

Three concrete pain points:

1. **Team retro.** Going back two weeks later to "what did we ship for Idea X?" requires opening four entities and stitching the story by hand. PMs and engineering leads do this often enough that we want a one-click recap.
2. **Internal sync (zh: 内部同步).** Cross-team handoffs and Friday updates currently re-explain the same Idea each week because the persisted record is fragmented.
3. **Agent recall.** Future agents working on related Ideas have no compact "what we decided last time and why" to read; they re-derive context from scratch and routinely re-litigate decisions.

We want a single Markdown artifact per finished Idea that covers all three readers in one document — explicitly **not** a PR description, blog post, or external launch material; those have different audiences and editorial standards.

## What Changes

- **New `Document.type = "report"`** — one new value on the existing `Document.type` free-form string. No schema migration; no other Document field changes.
- **New MCP tool `chorus_create_report`** — public-namespaced (no `pm_` prefix), gated on `document:write`. Skill (the caller) authors the full Markdown body and submits it; the service layer only stores. The tool's LLM-visible description carries the section-template constraint (Summary / Decisions / Follow-ups) — short by design, since this is a recap not a detail dump. Skills only mention the tool; they do not re-state the template.
- **No basis cardinality** — a Proposal can carry any number of `report` Documents (regenerate, supplemental angle, etc.).
- **Idea-tracker UI: Report list on the overview tab, below the timeline.** In `IdeaDetailPanel`'s `overview` tab, render a Reports list **below** `OverviewTimeline`, aggregated across all approved Proposals of the Idea (not per-proposal). Each row uses the same list-row + click-to-side-panel pattern that documents already use; clicking opens the existing `DocumentPanel` to the left of the idea panel (side-by-side on wide screens, overlay otherwise). No separate top-level tab. The `proposal` tab is **not** modified.
- **`yolo` skill end-step (mandatory).** When yolo finishes verifying the last task of an Idea, it composes the Markdown using full pipeline context and calls `chorus_create_report`. Skipping this step is a yolo protocol violation.
- **`develop` skill end-step (advisory).** When a developer agent verifies a task that turns out to be the last one for its Idea, the skill prompts the agent (via injected reminder text) to create a report.
- **PostToolUse hook injection.** Mirrors the existing `openspec-aware` archive-trigger pattern: after `chorus_admin_verify_task`, if the task was the last one of its Idea and no `report` document yet exists for that Idea, inject a reminder containing a literal substring the skill can grep for. Hook is read-only; the agent does the work.
- **No proposal cardinality cap.** A Proposal may have 0..N reports.
- **No basis change to existing flows.** Elaboration, proposal validate/submit/approve, task verify — all unchanged.

## Capabilities

### New Capabilities

- `idea-completion-report`: Idea-completion summary report concept — what a `report` Document is, when it's authored, who authors it, what it must contain, and how it surfaces in the idea-tracker UI.

### Modified Capabilities

- `mcp-tool-surface`: Add a new `chorus_create_report` tool to the public-namespaced surface gated on `document:write`. (The mcp-tool-surface spec already governs which tools are exposed, by what permission gate, and under what name; this change adds one row.)

## Impact

- **Schema**: zero migrations. `Document.type` is a free-form string in Prisma — adding one value is a doc/contract change, not a DB change.
- **Backend code**: `src/services/document.service.ts` (one new helper or none — existing `createDocument` may suffice), `src/mcp/tools/public.ts` or `pm.ts` (new tool registration), `src/mcp/tools/permission-map.ts` (new entry: `chorus_create_report` → `document:write`).
- **Frontend code**: a new `reports-list.tsx` sibling component rendered inside the `overview` tab of `IdeaDetailPanel` directly **below** `OverviewTimeline` (i.e. modify `idea-detail-panel.tsx`'s overview-tab body to include `<ReportsList>` under `<OverviewTimeline>`); the new component aggregates `type="report"` Documents across all approved Proposals of the Idea via the existing `getDocumentsByProposal` query path. Reuse `document-panel.tsx` unchanged for the side panel.
- **Plugin / skill code**: 4 plugin packages have `yolo`/`develop` skills (Claude Code, Codex, public/skill, OpenClaw if present); each gets the new end-step language. Plugin hook script under `public/chorus-plugin/bin/` (and Codex equivalent) gets the post-verify branch — same shape as `on-post-verify-task.sh`'s existing OpenSpec archive trigger.
- **Docs**: `docs/MCP_TOOLS.md` adds `chorus_create_report`. `public/skill/chorus/SKILL.md` and `public/chorus-plugin/skills/chorus/SKILL.md` get a Reports section. `docs/design.pen` gets the idea-tracker overview Report list mock.
- **Runtime**: no new dependencies, no migrations, no new MCP transport surface, no new permissions (reuses existing `document:write`).
- **Backward compat**: fully additive. Existing `Document.type` values keep working; the new tool is purely additive.
