# Design: Container Ideas

## Guiding constraint

The idea owner's overriding requirement is **minimal code + interaction change**. Every decision below picks the smallest viable option that still honors the two hard rules: a container can elaborate, and a container cannot create a proposal.

## Data model

Add one scalar to the `Idea` model:

```prisma
isContainer Boolean @default(false) // Container idea: groups derived children; may elaborate but MUST NOT create a proposal. Orthogonal to parentUuid.
```

- **Additive migration**, DDL-only: `ALTER TABLE "Idea" ADD COLUMN "isContainer" BOOLEAN NOT NULL DEFAULT false;`. No index — it is never a query filter, only a per-row read + guard.
- **Orthogonal to `parentUuid`.** A container may or may not have a parent; a non-container may have children. Container-hood constrains what an idea can *produce*, not its position in the lineage forest. "Derive a child idea" and "an idea that happens to have children" are the same lineage edge — the difference is purely the UI entry point and wording, so no second relation and no per-edge marker are introduced (elaboration Q8 = orthogonal reuse).

## Guard: containers cannot create proposals

`createProposal` in `src/services/proposal.service.ts` is the single choke point for all four proposal-creation entry points (MCP `chorus_pm_create_proposal`, REST `POST /projects/[uuid]/proposals`, server action `createProposalAction`, full-page `CreateProposalForm`). The guard lives there:

- When `inputType === "idea"`, load the input ideas (the service already resolves ideas for the assignee/availability checks in the callers; the guard fetches `isContainer` for each input idea uuid).
- If **any** input idea has `isContainer === true`, reject with a clear error (e.g. `"Container ideas cannot create proposals — derive a child idea instead."`). No proposal row is written.
- Callers (MCP tool, server action) may add a friendlier pre-check that returns the same message earlier, but the service guard is authoritative so no path can bypass it.

**Reversibility interaction (elaboration Q4 = freely reversible).** The guard only blocks *new* creation. If an idea that already has proposals is later flagged `isContainer = true`, existing proposals/tasks are untouched — no cascade delete. This keeps "freely reversible" honest and avoids destructive side effects. The UI simply stops offering *new* proposal progression on a container.

## Elaboration semantics (Q3 = shared context)

No behavioral change to elaboration itself — a container elaborates through the exact same rounds. "Shared context for children" is a **read-only presentation** concern: the child idea detail panel may surface a link/reference to the parent container's resolved elaboration. Nothing is auto-injected into the child's own elaboration, and no new field is stored. (Minimal-change: this is display-layer reuse of data already reachable via `parentUuid`.)

## Status & progress (Q7 + Q9 = read-only rollup)

A container has no proposals/tasks of its own, so its lifecycle status stays exactly what the existing derived-status logic produces (typically `elaborated`). On top of that, the lineage section renders a **read-only** child-completion rollup:

- Count = `idea.children.filter(c => c.derivedStatus === "done").length` / `idea.children.length`.
- `getIdea` already resolves each direct child's `derivedStatus` (via `getIdeasWithDerivedStatus`), so the data is already on `idea.children` — the rollup can be computed client-side in the panel, or as one derived field on `IdeaResponse`. No new status field, no new stored column (Q9 = option b).
- The `ProposalView` `completedCount / total` pattern is the visual precedent to match.

## UI surface (Q5 = detail panel + badge, Q6 = hide + derive)

In `idea-detail-panel.tsx` (the actively-developed dashboard panel, not the legacy `ideas/` one):

- **Toggle.** A "Container" toggle (shadcn `Switch` or a labeled control) in the edit form / action row, wired through `updateIdeaAction({ ideaUuid, projectUuid, isContainer })`. Freely reversible.
- **Badge.** A "Container" `<Badge>` next to the derived-status badge in the header. Optionally also on `idea-card.tsx` (the tracker "+N derived" card).
- **Proposal CTA hidden.** On a container, the proposal-progression CTAs in the footer (Verify Elaborate / Start Development / Yolo) are hidden; the "Derive child idea" action (already wired via `showDeriveDialog` + `NewIdeaDialog parentUuid={idea.uuid}`) becomes the primary path. The proposal tab still renders if legacy proposals exist (reversibility case), but no *new* proposal entry is offered.
- **Child rollup.** In the lineage section (which already lists `idea.children` with per-child derived-status badges), add the "N/M children done" read-only line.

All new strings go through i18n (`ideaTracker.lineage.*`) in both `en.json` and `zh.json`.

## What we explicitly do NOT do

- No second lineage relation, no per-edge "derived" marker (Q8 = orthogonal reuse of the existing single edge).
- No new status field / no container-specific lifecycle state (Q9).
- No auto-inheritance/auto-injection of container elaboration into children (Q3 = read-only shared context only).
- No cascade delete of existing proposals when toggling container on (Q4 = free reversibility, non-destructive).
- No blocking of task creation or claim-for-develop on the container — only proposal creation is blocked (Q2 = proposal-only).

## Risks

- **Legacy proposal on a toggled container.** Mitigated: guard blocks only new creation; existing proposals remain viewable. Documented as intended.
- **Skill drift.** The idea/proposal skills across 4 surfaces must all learn the container rule, or a daemon agent could try to write a proposal on a container and hit the guard error. Mitigated by the skill-update tasks in this change.
- **DTO fan-out.** `isContainer` must reach every `select` that feeds `formatIdeaResponse`, or the badge silently won't render. Mitigated by tests asserting `isContainer` presence in `getIdea` / tracker payloads.
