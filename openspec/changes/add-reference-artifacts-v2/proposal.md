## Why

Owner feedback on the shipped-and-deployed (but unmerged) Reference Artifacts V1: (1) many references belong at the **idea** layer, not just proposals/tasks; (2) the idea tracker should surface references as a collapsible panel with an outer count; (3) attaching references should be possible **inline at creation** rather than always requiring a second `chorus_add_reference` call. V2 delivers all three as an additive extension of V1, on the same working tree.

## What Changes

- **Idea-level references** — add `idea` to `ReferenceArtifact.targetType`. Because `targetType` is a plain `String` column, this needs **no migration** — a service-layer target-resolution case, a widened UI prop, an inline `references` array on `chorus_get_idea`, and a References section on the idea detail panel.
- **Idea-tracker references panel** — each idea row in the tracker gains a `referenceCount`; a collapsible panel shows the count when collapsed (owner: "外层展示数字") and a read-only list of references when expanded (lazy-fetched via the existing REST list endpoint).
- **Inline `references[]` at creation** — `chorus_pm_create_idea`, `chorus_pm_create_proposal`, and `chorus_create_tasks` gain an optional `references[]` param; each entity's references are materialized right after the entity is created, via a shared `createReferences` service helper. This resolves the create-then-add redundancy the owner flagged.
- **Write tools retained** — `chorus_add_reference` / `chorus_update_reference` / `chorus_remove_reference` all stay. The inline param removes the create-time redundancy; the standalone add tool is still needed for genuine post-hoc attach (an agent discovers a doc mid-run) and for tasks materialized from task-drafts (a draft carries a draft-uuid, not a real Task row, so it can't carry a ReferenceArtifact — those get references post-hoc). `add_task_draft` therefore does **not** get an inline param.

## Capabilities

### New Capabilities

- `reference-artifacts-v2`: The V2 extensions — idea as a reference target, the idea-tracker references count + collapsible read-only panel, and inline `references[]` on the three real-entity creation tools, with the full write-tool surface retained.

### Modified Capabilities

<!-- None — V1's reference-artifacts spec requirements are extended additively by the new capability's requirements; no V1 requirement is rewritten. -->

## Impact

- **No schema migration** — `targetType` is a `String`; the existing `@@index([targetType, targetUuid])` already covers `idea`.
- **Service** (`reference-artifact.service.ts`): add `"idea"` to `REFERENCE_TARGET_TYPES` + a resolution case; add a `createReferences` batch helper.
- **MCP** (`pm.ts`, `public.ts`): inline `references[]` on create_idea / create_proposal / create_tasks; inline `references` array on `chorus_get_idea`. No permission-map change (no new tools; idea-refs reuse `document:write`).
- **UI**: widen `ReferencesSection` targetType to include `idea`; mount it on the idea detail panel; add a collapsible references panel to the idea-tracker row; a `referenceCount` field threaded through `idea.service.ts` `getTrackerGroups` (batched `groupBy`).
- **i18n**: a couple of new `references.*` keys (tracker panel label) in en + zh.
- No breaking changes; fully additive over V1.
