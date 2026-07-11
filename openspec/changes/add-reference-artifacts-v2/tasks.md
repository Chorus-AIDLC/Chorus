# Tasks

## 1. Thread A — idea-level references (service + MCP read + UI)
- [ ] 1.1 `reference-artifact.service.ts`: add `"idea"` to `REFERENCE_TARGET_TYPES` + `resolveTargetProjectUuid` case; unit tests for idea target (happy + not-found + cross-tenant).
- [ ] 1.2 `chorus_get_idea` (public.ts): inline a `references` array. Widen `ReferencesSection` prop to include `idea`; mount it on the idea detail panel(s).

## 2. Thread C — inline references[] at creation (service helper + 3 tools)
- [ ] 2.1 Add `createReferences` batch helper to the service. Thread optional `references[]` into `chorus_pm_create_idea`, `chorus_pm_create_proposal`, `chorus_create_tasks`; materialize after entity insert; fail-soft on a bad ref. Keep all 3 write tools. Tests. (Depends on Thread A service change.)

## 3. Thread B — idea-tracker references panel
- [ ] 3.1 `idea.service.ts`: batch `referenceCount` (groupBy) onto tracker rows through `getTrackerGroups`; add to `IdeaCardItem`. Collapsible per-row panel in the tracker (count collapsed → read-only list on expand, lazy-fetched); `references.*` i18n in en+zh. (Depends on Thread A so idea references exist.)
