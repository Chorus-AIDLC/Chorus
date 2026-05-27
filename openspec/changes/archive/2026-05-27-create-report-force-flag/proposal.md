# Add `force` flag to `chorus_create_report` — default to rejecting duplicate reports per proposal

## Why

Today `chorus_create_report` writes a `type="report"` Document on every call, with the explicit "multiple reports per proposal are by design" comment in `src/mcp/tools/public.ts:1099-1104`. In the field this is producing duplicate completion reports per Idea because the prompt-engineering layer fires the call from two independent triggers in a single `/yolo` run:

1. The PostToolUse hook `on-post-verify-task.sh` Branch B injects an `ACTION REQUESTED: create idea-completion report` reminder after the last `chorus_admin_verify_task`. The hook is self-deduplicating — it skips on second fire — but it has no way to stop the agent that just received the reminder.
2. The `/yolo` skill's Phase 5b carries an unconditional "always — skipping is a protocol violation" instruction with no preflight check.

Both paths call the tool; the server happily writes both rows. Net result: the user sees two (or more) reports under one Idea / one proposal.

The fix should put the "default rejects duplicates" decision on the **server**, not in skill text. PE files drift, hooks compose unpredictably with each other, and not every `chorus_create_report` caller will be Chorus-plugin-aware. A server-side guard is the only place that makes the duplicate impossible regardless of how the call arrived.

## What Changes

`chorus_create_report` accepts an optional `force: boolean` input field, defaulting to `false`. When `force` is unset or `false` and the target proposal already has at least one `Document` with `type="report"`, the tool returns an MCP error result (no Document created). The error message must clearly tell the caller two things: that a report already exists for this proposal, and that `force=true` is how to bypass the rejection. Exact wording is an implementation choice; tests assert on those two semantic pieces, not on a literal string.

When `force=true` the existing behavior is preserved verbatim — multiple reports per proposal remain explicitly authorized for the rare case (re-author after a redo, generate a second cut for a separate audience, etc.).

The implementation is **handler-only**: the duplicate check runs in the `chorus_create_report` registration in `src/mcp/tools/public.ts` against `documentService.listDocumentsByProposalUuids`. `documentService.createDocument` and `Document` Prisma schema are untouched. No data migration. The pre-existing report-realtime fan-out (`emitReportSideEffects`) is unaffected — when force=true, we reach `createDocument` exactly as today.

The tool's user-visible description and Zod input schema both surface the new behavior so an agent reading the description discovers "default rejects duplicates" without needing to read the code.

Tests: handler unit tests in `src/mcp/tools/__tests__/create-report.test.ts` plus end-to-end coverage in `src/__tests__/integration/idea-completion-report.integration.test.ts` to assert the second call fails by default and succeeds with `force=true`.

`docs/MCP_TOOLS.md` is updated alongside.

## Capabilities

`create-report-force` (new) — captures the duplicate-rejection-by-default contract on `chorus_create_report`.

This is a single-Requirement capability deliberately scoped narrowly. Three pre-existing capabilities were considered and rejected:

- `idea-completion-report` is still in flight (the `add-idea-completion-report` change is unarchived); piggybacking on an unmaterialized capability creates archive ordering grief.
- `mcp-tool-surface` documents tool **removals**; semantically the wrong home for new behavior on a kept tool.
- `report-realtime` covers the post-create SSE / notification fan-out; the duplicate gate runs *before* create, on a different layer.

## Impact

- API surface (additive only): `chorus_create_report` gains an optional `force: boolean` parameter.
- Behavior change: callers that today rely on the implicit "every call writes a row" semantics will start receiving an error on the second call against the same proposal. The two known callers in this repo are the `/yolo` skill (Phase 5b) and the `on-post-verify-task.sh` hook reminder; the fix is *intentionally* visible to both, since the duplicate is the bug. The skill text and hook reminder are not modified in this change — once force defaults to false, their duplicate-fire becomes a no-op error rather than a duplicate row, which is the desired containment.
- Test surface: `create-report.test.ts` and `idea-completion-report.integration.test.ts` grow new cases. `yolo-end-step-predicates.test.ts` is unchanged (its predicate truth table doesn't depend on server-side behavior).
- Docs: `docs/MCP_TOOLS.md` `chorus_create_report` entry adds the `force` row + the new error message.
- No DB migration. No new Prisma model. No new dependency.
- No CHANGELOG bump in this change — version bumps are aggregated at release time per the repo's existing release skill.
