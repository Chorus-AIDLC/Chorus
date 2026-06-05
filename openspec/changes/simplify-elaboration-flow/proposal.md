# Simplify Elaboration Flow

## Why

The current elaboration workflow is cumbersome for agents and PMs:

1. **Too many MCP calls with manual UUID bookkeeping.** A full two-round elaboration takes 5+ calls (`start → answer → validate → start → answer → validate`), and `answer` / `validate` each require the caller to extract and pass `roundUuid` from a prior response. Agents routinely lose track of which round is active.
2. **`validate` conflates three unrelated jobs** — resolving the whole elaboration, opening a follow-up round, and tagging per-question issues. The issue-tagging job (`contradiction` / `ambiguity` / `incomplete`) is **never rendered in the UI** (`elaboration-panel.tsx` only shows Q/A text and a binary answered/pending badge), so it carries no user value.
3. **No first-class way to add a round after elaboration is resolved.** Once an Idea reaches `elaborated`, the only "add a round" path is `validate(followUpQuestions)`, which is unavailable from the resolved state. PMs who want to append a clarification after the fact have no clean entry point.

The original Idea title mentioned "appendConversation", but elaboration confirmed this was a misnomer: the real need is **making it easy to append elaboration rounds**, not introducing a free-form chat model.

## What Changes

- **`chorus_pm_start_elaboration` becomes the single "generate a round" entry point.** It already creates a round; we extend it so it is callable both while `elaborating` and after `elaborated`. When invoked on a resolved Idea it creates an **appended round** and keeps the Idea in `elaborated` (a pure supplement — never reverts to `elaborating`, never blocks downstream proposals).
- **`chorus_answer_elaboration` makes `roundUuid` optional.** When omitted, the service auto-locates the Idea's single active (`pending_answers`) round. Passing `roundUuid` still works (backward compatible).
- **`chorus_pm_validate_elaboration` marks the elaboration complete (requires `idea:admin`).** It validates the most recent answered round (Idea → `elaborated`, `elaborationStatus` → `resolved`) and takes only `ideaUuid` + optional `roundUuid`. It does not tag per-question issues or create follow-up rounds — opening a follow-up round is just another `chorus_pm_start_elaboration` call. The tool description and every skill that calls it MUST state that **human confirmation is required before calling it (except in YOLO mode)**.
- **Round-level `isAppended` marker.** Rounds created after the Idea was first resolved are flagged. Both the UI (an "appended / follow-up" badge) and MCP responses (`chorus_get_elaboration`, and the Idea's elaboration payload) surface the marker.
- **`chorus_pm_skip_elaboration` is unchanged.**

## Capabilities

- **elaboration-round-generation** — unified round creation across `elaborating` and `elaborated` states, including appended rounds and their marker.
- **elaboration-resolution** — the admin-gated, human-confirmed resolution action exposed via `chorus_pm_validate_elaboration`.
- **elaboration-answer-autolocate** — optional `roundUuid` on answering, with auto-location of the active round.

## Impact

- **Affected specs:** new capabilities `elaboration-round-generation`, `elaboration-resolution`, `elaboration-answer-autolocate`.
- **Affected code:**
  - `prisma/schema.prisma` — add `ElaborationRound.isAppended Boolean @default(false)` (migration via CLI).
  - `src/types/elaboration.ts` — add `isAppended` to round response; remove `ValidationIssueInput` / `ValidationIssueType` usage tied to the dropped issue-tagging job (kept only if referenced elsewhere).
  - `src/services/elaboration.service.ts` — `startElaboration` accepts resolved-state entry + sets `isAppended`; `answerElaboration` auto-locates round; new `resolveElaboration` service fn (backs the re-scoped tool); delete old `validateElaboration` issue/follow-up logic.
  - `src/mcp/tools/pm.ts` — re-scope the `chorus_pm_validate_elaboration` tool to call `resolveElaboration` (drop the `issues[]` / `followUpQuestions` params); make `roundUuid` optional on answer.
  - `src/mcp/tools/permission-map.ts` — re-gate `chorus_pm_validate_elaboration` from `idea:write` → `idea:admin`.
  - `src/components/elaboration-panel.tsx` — render the appended-round badge.
  - `messages/en.json`, `messages/zh.json` — i18n for the new badge.
  - `docs/MCP_TOOLS.md`, `docs/DESIGN_REQUIREMENTS_ELABORATION.md` — reference updates.
  - Skill surfaces (4 roots): `idea`, `yolo`, `brainstorm` SKILL.md — update `chorus_pm_validate_elaboration` guidance to the new resolve semantics + the human-confirmation note + the `idea:admin` handoff.
- **Backward compatibility:** `start` / `answer` / `skip` signatures preserved (`roundUuid` only relaxed to optional). The `chorus_pm_validate_elaboration` **name is kept** (reused), so callers don't hit "tool not found"; but its signature changed (dropped `issues[]` / `followUpQuestions`) and its permission rose to `idea:admin` — an accepted breaking change for that one tool (it has no production-critical external consumers, and its only meaningful output, resolve, is preserved).
- **Tests:** `src/services/__tests__/elaboration.service.test.ts`, `src/mcp/__tests__/server.test.ts`, `src/__tests__/integration/permissions.test.ts` updated for the new tool surface and behavior.
