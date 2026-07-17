# Slim MCP tool descriptions + enum-type filter params

## Why

Chorus exposes ~82 MCP tools. An admin-preset daemon identity sees nearly all of them, and **every conversation turn re-sends each tool's name + description + full zod schema** into the model's context. Long, prose-heavy descriptions and free-text enum params are two of the top drivers of long-context tool-call degradation (wrong tool picked, wrong param filled): the cost is paid on every turn and scales linearly with conversation length.

This is the **P1** child of theme "简化 MCP 工具调用表面" (`32611091`). It is deliberately the lowest-risk layer — purely "literal" changes to descriptions and schema, no tool merges (that is P0) and no signature/behavior changes (that is P2).

## What Changes

1. **Compress 7 over-long tool descriptions to 1–2 sentences** ("what it is / when to pick it"), pushing detail down to parameter-level `.describe()` and skill docs:
   - `chorus_create_report`, `chorus_get_proposal`, `chorus_pm_start_elaboration`, `chorus_create_tasks`, `chorus_update_task`, `chorus_pm_assign_task`, `chorus_add_reference`.
   - **Behavior-rule placement (per elaboration decision):** a single **global red-line** stays in the tool description (so a headless / no-skill agent still sees it); **parameter-bound red-lines** move into that parameter's `.describe()` (e.g. "no Other option" belongs to the `questions[].options` param); the remaining long procedural prose moves into the skill docs.

2. **Convert 6 filter/type params from `z.string().describe("...: a,b,c")` to strict `z.enum`** using the **real current stored value domain** (elaboration decision: `strict` — no legacy/derived values):
   - `chorus_get_ideas.status`, `chorus_list_tasks.status`, `chorus_list_tasks.priority`, `chorus_get_documents.type`, `chorus_get_proposals.status`, `chorus_pm_add_document_draft.type` + `chorus_pm_update_document_draft.type`.
   - Several current describe-strings advertise **stale** values (e.g. `get_ideas.status` lists `proposal_created/completed/closed` but the model only stores `open/elaborating/elaborated`; `get_proposals.status` lists `rejected/revised` which are **never written** — reject returns a proposal to `draft`). The enums use verified domains, not the stale strings.

## Capabilities

- `mcp-tool-surface` — adds requirements for description brevity and strict enum-typing of filter/type params.

## Impact

- **Code:** `src/mcp/tools/public.ts`, `src/mcp/tools/pm.ts` (schema + description edits only; no service/handler logic change).
- **Tests:** `src/mcp/__tests__/server.test.ts` (or sibling) — assert enum rejection of unknown values and acceptance of valid ones; assert description length bounds.
- **Docs:** `docs/MCP_TOOLS.md` + both skill roots (`public/skill/`, `public/chorus-plugin/skills/chorus/`) — relocate the behavior-rule prose that leaves the descriptions.
- **Backward-compat risk (bounded):** a client passing a now-illegal filter value (a stale/derived status) will get a schema-layer rejection instead of an empty result set. This is the intended `strict` behavior; verified that no first-party caller relies on the removed values.
- **Not in scope:** merging `create_report` into `create_document` (P0 owns that; per elaboration P1 only compresses its description and accepts minor rework if P0 later deletes it).

## Acceptance (P1-specific, per elaboration `struct_plus_record`)

Hard gate: enums live and reject unknown values; all 7 descriptions ≤ 2 sentences; both skill docs synced; tests pass; typecheck + lint clean. Tool-area token before/after delta is **recorded only** (no threshold).
