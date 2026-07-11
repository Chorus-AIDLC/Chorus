# Design: Reference Artifacts V2

## Context

Follow-on to V1 (idea 0a99c88e), built on the same uncommitted working tree (elaboration q6=a). Three owner-requested threads, each grounded in a touch-point analysis of the V1 code.

Resolved decisions (idea 4504808c elaboration, rounds 1–2):

| # | Decision | Choice |
|---|----------|--------|
| q1b | MCP write shape | Inline `references[]` at creation **+ KEEP** all 3 write tools (supersedes the round-1 "drop add" answer) |
| q2b | Which create-sites inline | `create_idea` + `create_proposal` + `create_tasks` (real-uuid sites); **skip** `add_task_draft` |
| q2 | Idea as target | Add `idea` to `targetType` |
| q3 | Tracker collapsed state | Count only |
| q4 | Tracker panel | Read-only |
| q5 | Rollup | Idea-scoped only, no descendant aggregation |
| q6 | Sequencing | Fold into V1 working tree, one PR |

## Thread A — idea-level references

`ReferenceArtifact.targetType` is a bare `String` with `@@index([targetType, targetUuid])`, so `idea` needs **no migration**.

- **Service** (`reference-artifact.service.ts`): add `"idea"` to `REFERENCE_TARGET_TYPES`; add a resolution case to the private `resolveTargetProjectUuid` switch:
  ```ts
  case "idea": {
    const idea = await prisma.idea.findFirst({ where: { uuid: targetUuid, companyUuid }, select: { projectUuid: true } });
    if (!idea) throw new Error(`Target idea with UUID ${targetUuid} not found`);
    return idea.projectUuid;
  }
  ```
  Downstream `eventBus.emitChange` and `activityService.createActivity` already accept `"idea"` in their type unions — no change. REST route + server-action `validTargetTypes` read the exported const, so they auto-accept `idea`.
- **MCP read** (`public.ts` `chorus_get_idea`): inline a `references` array exactly like `chorus_get_task`/`get_proposal` already do (`listReferences({ targetType: "idea", targetUuid })`); `referenceArtifactService` already imported.
- **UI**: widen `ReferencesSection` prop `targetType` to `"proposal" | "task" | "idea"` (component is otherwise targetType-agnostic). Mount `<ReferencesSection targetType="idea" targetUuid={idea.uuid} canWrite compact />` on the idea detail panel (`dashboard/panels/idea-detail-panel.tsx`, Overview tab, after the reports/lineage block). Also mount on the secondary `ideas/idea-detail-panel.tsx` for the proposal→source-idea drill-in.
- **Permission**: idea-references reuse `document:write` (consistent with V1; no new bit).

## Thread B — idea-tracker references panel

- **Data** (`idea.service.ts`): in `getIdeasWithDerivedStatus`, batch a `prisma.referenceArtifact.groupBy({ by: ['targetUuid'], where: { companyUuid, targetType: 'idea', targetUuid: { in: ideaUuids } }, _count: true })` (mirrors the existing `reportCount` batching) and fold `referenceCount` onto each row; surface it through `getTrackerGroups`' `TrackerIdeaItem` and the tracker REST route (inherits automatically). Add `referenceCount?: number` to `IdeaCardItem`.
- **UI** (`idea-card.tsx` / row): a shadcn `Collapsible` (already in `components/ui/collapsible.tsx`, used by `idea-status-group.tsx`). Collapsed trigger shows just the count (e.g. a small "🔗 N" badge; hidden when 0). Expanding lazy-fetches the list via the existing `listReferencesAction("idea", uuid)` and renders it **read-only** (reuse `ReferencesSection` in a read-only mode, or a lightweight row list) — no add/edit/delete in the tracker (that lives on the idea detail panel).

## Thread C — inline references[] at creation

Shared service helper, called after the entity row exists (all three sites yield a real uuid). It is **fail-soft**: one bad reference must not abort the others or the host entity — collect per-item errors and return them:
```ts
export async function createReferences(companyUuid, targetType, targetUuid, items, createdBy) {
  const created = [], errors = [];
  for (const it of items ?? []) {
    try {
      created.push(await createReference({ companyUuid, targetType, targetUuid, ...it,
        createdByType: createdBy.type, createdByUuid: createdBy.uuid }));
    } catch (e) {
      errors.push({ item: it, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { created, errors };  // callers surface `errors` in the tool response text
}
```
- **`chorus_pm_create_idea`** (pm.ts): add optional `references[]` to the schema; after `ideaService.createIdea` returns, call `createReferences(companyUuid, "idea", idea.uuid, references, {...})`.
- **`chorus_pm_create_proposal`** (pm.ts): same, `"proposal"`, `proposal.uuid`.
- **`chorus_create_tasks`** (public.ts): add `references[]` to each per-task object; in the existing post-creation block (where deps/AC are attached using `createdTasks[i].uuid`), call `createReferences(companyUuid, "task", createdTasks[i].uuid, task.references, {...})`.
- Ref item shape reuses the existing `referenceTypeEnum` from pm.ts: `{ type, url, title, notes? }`.
- **Ordering** (confirmed): idea/proposal/task uuids are DB-generated at insert; references are created strictly after, in the tool handler (not inside the service create fn) — matches how `create_tasks` already sequences deps/AC post-insert.

### Why keep the write tools (q1b=a)

`add_task_draft` yields a **draft** uuid (materialized to a real Task only at proposal approval), so a draft can't own a `ReferenceArtifact` today — its tasks get references post-hoc via `chorus_add_reference`. Dropping the add tool would strand that path plus genuine mid-run discovery. The inline param removes the *create-then-add* redundancy the owner flagged; the add tool remains for post-hoc use. Net: inline on 3 real-uuid sites, all 3 write tools retained, `add_task_draft` unchanged.

## Out of scope (deferred)

- Descendant/rollup aggregation of references (q5=a).
- Tracker-panel inline CRUD (q4=a — read-only).
- Inline references on `add_task_draft` (draft-JSON materialization; q2b=a).
- AC-level references, local files, snapshots (still deferred from V1).

## Permission scope of inline references (deliberate)

The standalone `chorus_add_reference` is gated `document:write`. An inline `references[]` param instead rides the **host create tool's** gate: `create_idea` (`idea:write`), `create_proposal` (`proposal:write`), `create_tasks` (its existing gate). This is a deliberate, acceptable widening: creating the host entity is the higher-privilege action, and attaching evidence to something you're allowed to create is strictly narrower than free-standing reference writes. It is called out here rather than left accidental. If a future policy wants inline refs to also require `document:write`, add that check in the shared helper's callers — not needed for V2.

## Doc / contract sweep (part of this change)

Adding `idea` as a target and inline params makes several agent-facing contract texts stale. This change updates them (Thread A/C ACs cover it): `chorus_add_reference`'s tool description ("proposal or task" → include idea), `docs/MCP_TOOLS.md` (idea target + the new inline `references[]` params + `chorus_get_idea`'s `references[]`), and the four skill-doc surfaces per the plugin-maintenance skill — kept minimal, no bloat.

## Risks

- **Tracker query cost**: the extra `groupBy` is one batched query over the visible idea set (same shape as `reportCount`) — negligible; no N+1.
- **Partial inline-create failure**: resolved above — **fail-soft** with per-ref errors surfaced in the tool response (see the `createReferences` helper), so a bad URL never loses the host entity. Enforced by Thread C AC3.
