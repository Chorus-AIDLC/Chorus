# Redesign Idea Lineage View Controls on the Dashboard

## Why

The project dashboard's Overview tab gained idea-derivation (lineage) features in recent
releases (#307 single-parent lineage, #309 `parentUuid` exposure). The data and behavior
work, but the **control layout is poor**:

- Three interactive controls sit in a diagonal "staircase" with no alignment baseline:
  - top-left: `Ideas / Stats` primary segmented control (`idea-tracker.tsx`),
  - top-right: `+ New Idea` button,
  - bottom-right: `Flat / By lineage` segmented control on its own row (`idea-tracker-list.tsx`).
- **Layout jumps**: switching to Stats removes the second row entirely; switching back
  re-adds it, so the content area's vertical offset shifts.
- **Two segmented controls with inconsistent styling**: `Ideas/Stats` uses white-fill +
  border (`#E5E0D8`); `Flat/By lineage` uses beige-fill (`#EFEBE3`). Same control type,
  different look.
- The lineage list view is **always opt-in**, so projects that actively use derivation
  still land on the flat status-grouped view and must discover the toggle.

## What Changes

1. **Collapse to a single 3-way primary switch**: `Ideas (flat) / Lineage / Stats`. The
   separate `Flat / By lineage` segmented control is removed. `New Idea` stands alone on
   the right. This eliminates the second control and the layout jump.
2. **Adaptive default view (progressive disclosure)**: on first mount, if any idea in the
   project has a parent or derived children (`parentUuid` set or `childCount > 0`), default
   to `Lineage`; otherwise default to `Ideas` (status-grouped). Computed **once on mount** —
   later data changes (SSE refresh, a newly derived child) never force a view switch.
3. **Per-project manual override memory**: once the user manually picks a view, that choice
   is persisted per project in `localStorage` and wins over the adaptive default on
   subsequent visits.
4. **Unified control styling**: the primary switch uses the beige-fill style (`#EFEBE3`
   track + white highlighted selected state), matching Chorus's warm palette.

## Capabilities

- `idea-lineage-view`: how the dashboard chooses, persists, and renders the idea list view
  mode (flat status groups vs. lineage tree vs. stats), including the adaptive default and
  manual-override memory.

## Impact

- **Affected code** (frontend only, no schema/API change):
  - `src/app/(dashboard)/projects/[uuid]/dashboard/idea-tracker.tsx` — owns the primary
    view switch; absorbs the third option and `New Idea`.
  - `src/app/(dashboard)/projects/[uuid]/dashboard/idea-tracker-list.tsx` — drops its own
    `Flat / By lineage` toggle; receives `viewMode` from the parent.
  - A small `localStorage` helper for the per-project view preference.
  - `messages/en.json`, `messages/zh.json` — i18n keys for the new option label.
  - `docs/design.pen` — reflect the new single-row control layout.
- **No data migration.** Uses existing tracker fields (`parentUuid`, `childCount`).
- **Backward compatible**: the lineage tree and flat status group renderers are unchanged;
  only how the view mode is selected/owned moves up a level.
