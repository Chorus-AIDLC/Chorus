# Design: Idea-completion summary report

## Overview

This change introduces a new Document subtype, `report`, that captures the post-delivery summary of a finished Idea. The Document is created by the agent (skill-driven) once all Tasks linked to an Idea (transitively, via Proposals) reach a terminal state. The Markdown body is fully authored by the calling skill; the service layer is a thin wrapper around `documentService.createDocument` with `type=report`. UI surfaces reports under the existing `IdeaDetailPanel` `proposal` tab, reusing the doc-row + side-panel pattern.

The design intentionally avoids:

- a new Prisma model or schema migration,
- structured fields on `Document` for report metadata (Summary, Decisions, etc.) — those are markdown sections in `content`, governed by the tool-description template,
- a server-side autogen path (the service layer does not synthesize the body),
- coupling reports to the Idea's stored status (`open` / `elaborating` / `elaborated`); reports attach to a Proposal and aggregate up to the Idea via `Proposal.inputUuids`.

## Architecture

### Entity model

```
Idea (uuid)
 └── Proposal (status=approved, inputUuids: [ideaUuid])
      ├── Document (type=prd)         ← existing
      ├── Document (type=tech_design) ← existing
      ├── Document (type=spec)        ← existing
      └── Document (type=report)      ← NEW (1..N per Proposal)
```

A `report` Document is created with `proposalUuid` set to the Proposal whose Tasks are now all done. Aggregation up to the Idea is done client-side: the existing `getProposalsForIdeaAction` already returns all Proposals for an Idea, and each Proposal's documents are reachable via existing endpoints.

### Authoring path

```
last_task_verified
        │
        ├── (yolo skill end-step)        → mandatory: skill composes report → chorus_create_report
        ├── (develop skill end-step)     → advisory: skill prompts agent → chorus_create_report
        └── (PostToolUse hook reminder)  → read-only: appends "create the idea report" reminder to next prompt
```

The three triggers all funnel through the same MCP tool. The hook never authors content; it nudges. Skipping at yolo's end-step is a protocol violation surfaced in reviewer notes.

### MCP tool contract

```
chorus_create_report(input: {
  proposalUuid: string,
  title: string,
  content: string,         // full Markdown, byte-faithful — wrapper path matches openspec-aware §2 Rule 1
}) -> { documentUuid: string, projectUuid: string, version: 1 }
```

- **Permission gate**: `document:write` (existing bit). Available to PM and admin presets out of the box; available to developer agents only if explicitly granted.
- **Tool description (LLM-visible)** carries the report section template: Summary, Decisions, Follow-ups. The template is a constraint, not a schema — the body is free-form Markdown.
- **No `ideaUuid` parameter**. The Idea is implied by `Proposal.inputUuids`; service layer reads it. This avoids the agent passing inconsistent `(proposalUuid, ideaUuid)` pairs.
- **No `type` parameter**. The tool name encodes the type; the service writes `type="report"` unconditionally. Prevents agents from creating reports under the wrong type label.

### UI rendering

The Reports list lives on the **overview tab** of `IdeaDetailPanel`, **below** `OverviewTimeline`, aggregated across all approved Proposals of the Idea. The `proposal` tab is **not** modified.

Component layout in `idea-detail-panel.tsx` (overview-tab body):

```tsx
<OverviewTimeline ... />
<ReportsList
  ideaUuid={idea.uuid}
  proposals={proposals}
  onDocClick={openDoc}   // existing setter that opens DocumentPanel side-by-side
/>
```

`ReportsList` is a new component at `src/app/(dashboard)/projects/[uuid]/dashboard/panels/reports-list.tsx`. It:

1. Receives `proposals` (already fetched at the panel level via `getProposalsForIdeaAction` and lifted into `IdeaDetailPanel` state) and filters to `status === "approved"`.
2. Fetches Documents for each approved Proposal via the existing `getDocumentsByProposalAction`-equivalent (or a new aggregated server action `getReportsForIdeaAction(ideaUuid)` that merges across proposals — pick whichever keeps the data path simplest).
3. Filters to `type === "report"`, sorts by `createdAt` descending.
4. Renders a section header + count + one row per report (same row styling as the proposal-tab document rows: chevron-left + type badge + title).
5. On row click, calls `onDocClick({ title, type, content })` which the parent already wires to the existing `DocumentPanel` side panel (no `DocumentPanel` changes needed).

Visual differentiation:

- The doc-type badge shows `Report` (i18n: `documents.typeReport`).
- The Reports section header reads "Reports" (i18n: `idea.reportsList`) with the count to its right.
- A small subhead clarifies that reports cover the whole Idea, not a single Proposal (i18n: `idea.reportsAcrossProposals`).

Empty / loading states:

- Reports list is **hidden entirely** (no header, no empty-state copy) when zero `report` Documents exist across all approved Proposals of the Idea — this matches the project convention used elsewhere (e.g. how `proposal-view.tsx` handles its "no proposals" branch as a precedent for hiding empty section headers).
- When loading, render a small spinner consistent with the panel's existing pattern.

Why overview, not proposal-tab:

- The Reports list is an Idea-level artifact (one finished Idea may span multiple Proposals; the report cluster is the recap of the whole Idea). Per-proposal placement would force users to fan out across proposal blocks just to find what shipped.
- The overview tab already presents the Idea as a coherent timeline; the Reports list is the natural "after delivery" cap below the timeline.

### Section template (lives in the LLM-visible tool description; skills point at it rather than re-stating)

```markdown
# <Idea title> — completion report

## Summary
1-3 sentences on what shipped. Plain prose.

## Decisions
Terse bullets — the key calls made during elaboration / proposal review and why this option not the alternative.

## Follow-ups
What's still open — link to a new Idea / blog / doc-update if tracked elsewhere; "None" if there are no follow-ups.
```

## Module Contracts

- **`documentService.createReport(input)`** (new, optional thin wrapper) returns the created Document. May be inlined into `documentService.createDocument` if the caller already passes `type="report"` correctly — no business value to a separate function unless we add type-specific validation later.
- **MCP tool registration** (in `src/mcp/tools/public.ts` since the tool has no `pm_` prefix and is gated on `document:write`):

  ```typescript
  server.registerTool("chorus_create_report", {
    description: "<template-bearing description, see skill template above>",
    inputSchema: z.object({
      proposalUuid: z.string().uuid(),
      title: z.string().min(1).max(200),
      content: z.string().min(1),
    }),
  }, async (params) => {
    requireAgentPermission(auth, "document", "write");
    const proposal = await proposalService.getByUuid(auth.companyUuid, params.proposalUuid);
    if (!proposal) throw new Error("Proposal not found");
    const doc = await documentService.createDocument(auth.companyUuid, {
      projectUuid: proposal.projectUuid,
      proposalUuid: params.proposalUuid,
      type: "report",
      title: params.title,
      content: params.content,
      createdByUuid: auth.actorUuid,
    });
    return { content: [{ type: "text", text: JSON.stringify({ documentUuid: doc.uuid, projectUuid: doc.projectUuid, version: doc.version }, null, 2) }] };
  });
  ```

- **Permission map entry** (`src/mcp/tools/permission-map.ts`): `"chorus_create_report" → { resource: "document", action: "write" }`.
- **No new REST endpoint.** Existing `GET /api/documents/[uuid]` and `GET /api/projects/[uuid]/documents` cover read paths; existing list-by-proposal already returns reports because they live as `Document` rows.

## Hook contract

`bin/on-post-verify-task.sh` (Claude Code plugin) and the Codex equivalent get a new branch with **two** checks:

1. After `chorus_admin_verify_task` succeeds, look at the verified task's Proposal:
   - Is `inputType=="idea"`? (skip otherwise)
   - Are all this Proposal's tasks in `done`/`closed`?
   - Does this Proposal have any `type="report"` Document? (skip if yes)
2. If all three pass, emit `additionalContext` containing the literal substring `create idea-completion report` plus a one-line example call.
3. Otherwise exit silently.

Scope is intentionally proposal-local — the hook does not aggregate across multiple Proposals of the same Idea. That case is `/yolo`'s mandatory end-step's responsibility. Keeping the hook proposal-scoped means it costs ~2 cheap MCP reads per `chorus_admin_verify_task` and is easy to reason about; the trade-off is a missed reminder when an Idea spans multiple proposals and the user is using `/develop` (not `/yolo`) — that path is rare and the user can still author the report manually.

The hook is **read-only**: it does not call `chorus_create_report` itself; the agent decides whether and how to author the body.

## Risks & Mitigations

- **Risk: agents skip the yolo end-step.** Mitigation: review-time check — the proposal-reviewer skill (`chorus:proposal-reviewer`) is not in scope, but the develop-task verification flow can include "no report exists for finished Idea" as a soft signal in the next idea-tracker checkin.
- **Risk: agents author thin / generic reports.** Mitigation: skill template is concrete (Summary / Decisions / Follow-ups), short by design — it's a recap, not a detail dump. The LLM-visible tool description carries it.
- **Risk: report duplication when multiple agents independently trigger end-step.** Mitigation: hook checks "Idea has zero `report` Documents" before injecting reminder. The MCP tool itself permits N reports per Proposal — that is the explicit answer to elaboration q4 ("不限基数"), so duplicates are not a *correctness* failure, just a quality smell. Out-of-scope to dedupe at write time.
- **Risk: UI clutter for Ideas with many proposals × many reports.** Mitigation: Reports list aggregates at idea level under the overview tab, sorted by `createdAt` descending so the most-recent report is on top; truncate to first N (e.g. 5) with a "show all" affordance if N grows large in practice. Re-evaluate after the first real Idea finishes.
- **Risk: the "last task" predicate is wrong when Tasks span multiple Proposals.** Mitigation: the yolo end-step uses the Idea-level predicate (all Tasks across all approved Proposals for this Idea are terminal). The hook deliberately uses a simpler proposal-local predicate — see "Hook contract" above for the rationale.
- **Risk: report content drift if regenerated.** Mitigation: each `chorus_create_report` call creates a new Document (version 1). Multiple reports per Proposal is allowed by design; UI lists them in createdAt order. Authors can update via existing `chorus_pm_update_document` if they own it.

## Implementation Plan

1. **Backend tool**: register `chorus_create_report` in `src/mcp/tools/public.ts`; add permission map entry; verify `documentService.createDocument` accepts `type="report"` without changes (it should — type is a free-form string).
2. **Tool description copy**: write the LLM-visible description with the section template baked in. This is the single source of truth for the report shape.
3. **MCP tool docs**: append entry to `docs/MCP_TOOLS.md`; mirror to `public/skill/chorus/SKILL.md` and `public/chorus-plugin/skills/chorus/SKILL.md` and Codex / OpenClaw equivalents.
4. **Frontend**: add `report` to `DOC_TYPE_I18N_KEYS` and locale files (`messages/en.json`, `messages/zh.json`) for the badge label. Add `idea.reportsList` and `idea.reportsAcrossProposals` keys. Create `reports-list.tsx` and wire it into the `overview` tab of `IdeaDetailPanel` directly under `OverviewTimeline`.
5. **`docs/design.pen` update**: add the Reports list mock on the overview-tab body directly under `OverviewTimeline` (frame `Idea Tracker - Overview Tab with Reports List`, id `whWtH`); reuse the existing doc-row visual; include a sibling `Detail Panel - Report` mock showing the click-row → side-panel expansion.
6. **Skill end-step copy**: update `yolo` and `develop` skills in 4 plugin packages with the end-step language. Bilingual where the skill is bilingual.
7. **Hook**: add the post-verify branch to `bin/on-post-verify-task.sh` and the Codex hook. Reuse the same predicate-tools as the existing OpenSpec branch.
8. **Tests**: pure tests for the tool registration (permission gating, type pin), service-layer test that report Documents survive `getDocumentsByProposal`, and a render test for `<ReportsList>` covering: shows below `OverviewTimeline` when `report` Documents exist, hidden when zero exist, click-row opens `DocumentPanel`, and the `proposal` tab is unchanged.
9. **Integration**: end-to-end smoke — create an Idea, run a fake yolo flow that creates one report, verify it shows up in the idea-tracker overview Reports list and opens in `DocumentPanel`.
