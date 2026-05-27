# Tech Design — `chorus_create_report` `force` flag

## Goal

Make duplicate completion reports under one Proposal a deliberate choice rather than the current accidental side-effect of two PE paths firing in sequence. Push the policy decision down to the server so it is correct regardless of whether the caller is `/yolo`, `/develop`, the PostToolUse hook, an external client, or a future workflow we haven't written yet.

## Constraints

- `chorus_create_report` is a **public-namespaced** MCP tool (no `pm_` prefix), gated on `document:write`. Both properties are preserved.
- Existing handler shape is `async ({ proposalUuid, title, content }) => { ... }` returning either `{ content: [{ type: "text", text }] }` (success — JSON serialised) or `{ content: [...], isError: true }` on failure. The two existing failure branches (`Proposal not found`, `Proposal status must be 'approved'`) are kept verbatim — the new branch matches that style.
- `documentService.createDocument` is shared with `chorus_pm_create_document`; we do not push the duplicate gate down into the service because reports under non-`/create_report` paths (e.g. server-side `createDocumentFromProposal`) intentionally allow multiple type=report rows during proposal drafting / approval flows.
- Bash 3.2 / no-DML-in-migration / Prisma-CLI-only invariants from `CLAUDE.md` are not relevant here (handler-only change in TS).

## Non-Goals

- Skill / hook text fixes (`yolo` Phase 5b, `develop` Step 11, `on-post-verify-task.sh` Branch B). The server-side fix makes those paths *self-correct* — duplicate fires return errors instead of writing extra rows. PE clean-up is a separate work item.
- Any DB schema change or unique constraint. The `Document` table currently holds multi-report rows under prior approved proposals; adding `(proposalUuid, type='report')` UNIQUE retroactively would either fail the migration or require lossy backfill. The application-layer check has equivalent strength for the realistic concurrency profile (report creation is a once-per-Idea event, not a high-frequency racy path).
- `chorus_pm_create_document` semantics. That tool already refuses `type="report"` (see its Zod schema). Out of scope.
- `chorus_pm_update_document` semantics. "Edit existing report" stays as today.

## API contract

`chorus_create_report` accepts:

| Field | Type | Required | Notes |
|---|---|---|---|
| `proposalUuid` | string (UUID) | yes | unchanged |
| `title` | string (1–200) | yes | unchanged |
| `content` | string (≥1) | yes | unchanged |
| `force` | boolean | no — default `false` | NEW. When `true`, bypass the duplicate-report check and always create a new report Document. |

Success response (`force` defaulted, no prior report): unchanged — `{ documentUuid, projectUuid, version }` JSON in `content[0].text`, no `isError`.

Success response (`force=true`, with or without prior report): identical shape; the new report is a separate row.

Error response (`force` defaulted, prior report exists): `isError: true`, `content[0].text` is a short message that conveys two things — (1) a report already exists on this proposal, (2) pass `force` (or `force=true`) to bypass. Exact phrasing is the implementer's call; tests assert on the two semantic substrings (something like "report" + "force"), not on a verbatim string. No i18n layer here — the message can be in either language; UI rendering can wrap or translate as a separate concern.

## Handler flow (post-change)

1. `getProposalByUuid` — unchanged. Return "Proposal not found" if missing.
2. `proposal.status === "approved"` check — unchanged. Return current message if not.
3. **NEW** — if `force !== true`, call `documentService.listDocumentsByProposalUuids(auth.companyUuid, [proposalUuid], "report")`. If the returned array is non-empty, return the duplicate-rejected error (above). No Document is created.
4. Otherwise (force=true OR no prior report): call `documentService.createDocument(...)` with `type="report"` exactly as today. `emitReportSideEffects` fires from inside `createDocument` for this row only — the SSE / notification fan-out is per-row, so users *do* get a fresh notification on each force=true write, which is correct.
5. Return the documentUuid / projectUuid / version JSON exactly as today.

`listDocumentsByProposalUuids` already exists (`src/services/document.service.ts:140`), already filters by `companyUuid` + `proposalUuid` + optional `type`, and is the canonical Idea-level read used by the report-realtime UI. Reusing it keeps the duplicate gate consistent with what users already see in the Idea Reports list.

## Why service-layer query, not DB UNIQUE

Two reasons in tension:

1. Concurrency: report creation is single-actor, low-frequency (the agent firing it is the same agent whose previous tool call materialised the proposal). The realistic worst-case is two near-simultaneous calls in the same `/yolo` run; both reach the duplicate-check at the same time and both proceed. The probability is small and the cost (one extra row) matches today's status quo. A UNIQUE constraint would catch it deterministically — but at the cost of a DB migration the existing data wouldn't survive.
2. Existing data: the production database already has multiple `type="report"` rows under several proposals. A UNIQUE constraint migration would fail on those rows, requiring a lossy data-cleanup migration. Not justifiable for a soft-policy decision.

The application-level check is consistent with the rest of `public.ts` (e.g. proposal status, idempotency guards, AC checks). If usage patterns ever change such that duplicate races become real, escalating to a UNIQUE index is straightforward — the API contract doesn't change.

## Description / inputSchema text

Two surface points need updating so a calling agent learns the new behavior without reading the source.

In the tool description (LLM-visible, currently a long template description):

> Adds a paragraph near the top: *"By default this tool refuses to create a second report on a proposal that already has one — the call returns an error and writes nothing. Pass `force: true` only when intentionally authoring an additional report (e.g. after a major rework). The default-reject is the safe path; agent prompts and post-verify hooks may both attempt this call, and rejecting duplicates server-side keeps the Idea Reports list clean regardless of caller."*

In the Zod schema for `force`:

> `.describe("Default false. When false, calls against a proposal that already has a report return an error and create nothing. Set true only to deliberately add another report to the same proposal.")`

Both surfaces match the canonical project pattern (see `chorus_pm_create_idea`, `chorus_pm_create_proposal` for example).

## Test plan

- **Unit** (`src/mcp/tools/__tests__/create-report.test.ts`): four cases.
  1. `force` omitted, proposal has no prior report → success (existing happy-path stays green; the new check sees `[]` and proceeds to create).
  2. `force` omitted, proposal has one prior report → `isError: true`, error text contains both a "report exists" signal and the literal substring `force`, `createDocument` not called.
  3. `force=false` explicit, proposal has prior report → same as case 2 (treats explicit and default identically).
  4. `force=true`, proposal has prior report → `createDocument` called once, success response.
  5. `force=true`, proposal has no prior report → `createDocument` called, success (no regression for callers who always pass force=true).
  6. Schema test: parse with extra `force: true` succeeds; parse with `force: "yes"` (string) fails.
  7. Description / schema text assertions: description contains the new paragraph keyword (e.g. "force"), `force` field schema `_def.description` is non-empty.
- **Integration** (`src/__tests__/integration/idea-completion-report.integration.test.ts`): one test exercising the real proposalService + documentService against the project's prisma mock — first `chorus_create_report` succeeds, second (default) fails with the expected text, third (force=true) succeeds and returns a *different* `documentUuid`. Asserts the post-state has exactly two report rows in DB.
- **Regression**: `yolo-end-step-predicates.test.ts` is unchanged; its predicate truth table is purely client-side and oblivious to server force semantics. We assert it stays green by running it.

## Risk surface

- **Behavior change visible to existing automation.** `/yolo` Phase 5b will start seeing the error after the hook fires. This is the *desired* outcome and the change requester signed off on it. We don't modify the skill in this change because the error is recoverable — the agent reads it, understands "report already exists", and moves on; no Idea is left in a bad state. (A subsequent PR will tidy the skill text to short-circuit before the duplicate call, but is out of scope here.)
- **Documentation skew.** `docs/MCP_TOOLS.md` is updated in the same change. `public/skill/chorus/SKILL.md` and `public/chorus-plugin/skills/chorus/SKILL.md` carry brief mentions of `chorus_create_report`; we audit those and refresh as needed (likely a single-sentence diff each).
- **Test churn.** Existing happy-path assertions on `chorus_create_report` stay green because we add the duplicate check *only* when `force !== true` *and* a prior report exists. The pre-existing failure branches (`Proposal not found`, status table) trigger before the new branch — no reorder needed. Existing tests that hit the happy path will need their `documentService` mock to also stub `listDocumentsByProposalUuids` returning `[]`; this is a one-line shim per test, not a substantive change.

## Migration

None. No data migration, no schema change, no Prisma client regeneration.
