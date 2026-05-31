# Refactor `chorus_get_proposal` into section-scoped views

## Why

The `chorus_get_proposal` MCP tool currently returns the **entire** proposal in one
payload: full proposal metadata, every document draft with its complete Markdown
`content`, and every task draft with its full description and acceptance criteria.

For a real proposal this is large. A single proposal can carry a PRD, a tech-design
doc, and one spec doc per capability — each several thousand characters — plus a dozen
task drafts. An agent that only needs the proposal title and status, or only needs the
task DAG, is forced to pull (and pay tokens for) the whole thing. This wastes context
budget and can blow past context limits on large proposals.

The constraint for this change is explicit: **do not add any new MCP tool.** The fix
must live inside the existing `chorus_get_proposal` surface, driven by a parameter.

## What Changes

- Add a single optional `section` parameter to `chorus_get_proposal` with four values:
  - `basic` — proposal metadata + a **lightweight index** of document drafts
    (`uuid`, `type`, `title`, `contentLength`) and task drafts
    (`uuid`, `title`, `priority`, `storyPoints`, `acceptanceCriteriaCount`,
    `dependsOnDraftUuids`). No heavy `content` / `description` / criteria text.
  - `documents` — proposal metadata + **full** document drafts (with `content`).
  - `tasks` — proposal metadata + **full** task drafts (with descriptions + criteria).
  - `full` — the original complete payload, unchanged. Backward-compatible escape hatch.
- **Default when `section` is omitted = `basic`.** This is the actual payload-bloat fix:
  the cheap index becomes the default response, and callers opt in to the heavy slices.
- Add a service-layer slicing function used **only** by the MCP tool. The existing
  `getProposal()` (which returns the full `ProposalResponse`) is left untouched so the
  REST route `GET /api/proposals/[uuid]` and the frontend keep their current behavior.
- Update the downstream consumers that relied on the old "always full" default:
  the proposal-reviewer agent and the proposal / review skills (in `public/skill/`,
  `public/chorus-plugin/`, and the Codex `plugins/chorus/` port), plus `docs/MCP_TOOLS.md`.

## Capabilities

- **mcp-tool-surface** — the `chorus_get_proposal` tool gains a `section` parameter and a
  lightweight default response shape.

## Impact

- **Affected MCP tool:** `chorus_get_proposal` (in `src/mcp/tools/public.ts`).
- **Affected service:** `src/services/proposal.service.ts` (new slicing function +
  index/section response types). `getProposal()` signature and behavior unchanged.
- **Not affected:** REST route `GET /api/proposals/[uuid]`, the frontend, and all other
  proposal MCP tools (`chorus_get_proposals`, `chorus_pm_*`).
- **Behavior change (intentional, breaking for callers that assumed full default):**
  agents calling `chorus_get_proposal` with no `section` now receive the index, not the
  full content. Consumers updated in this change: proposal-reviewer agent + proposal /
  review skills across all three skill trees + `docs/MCP_TOOLS.md`.
- **Tests:** new service unit tests for each `section` value and the default, holding the
  existing 95% line / 85% branch coverage gates.
