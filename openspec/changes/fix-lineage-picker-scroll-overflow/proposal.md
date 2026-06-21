# Fix lineage front-end: set-parent picker scroll/overflow + lineage-tab grouping

## Why

The idea-lineage (single-parent forest) feature shipped with three front-end defects that
make it hard to use on this project, where idea titles are routinely very long:

1. **Set-parent picker candidate list cannot scroll.** In
   `set-parent-dialog.tsx` the candidate list nests a Radix `<ScrollArea max-h-[280px]>`
   *inside* `CommandList`, which is already a scroll container
   (`command.tsx`: `max-h-[300px] overflow-y-auto`). The inner Radix `ScrollArea.Root`
   is given only `max-height` and no definite height, so its `Viewport` (`size-full` =
   `height:100%`) collapses to content height and never becomes an overflow region — its
   scrollbar never engages. The wrapping `CommandGroup` is `overflow-hidden`, so every
   candidate row past ~280px is clipped and unreachable. With this project's idea count,
   that ceiling is hit immediately: you cannot reach most parents.

2. **Picker rows overflow the dialog horizontally.** The candidate-row `CommandItem` uses
   `flex justify-between gap-2` but lacks `min-w-0`. A flex item defaults to
   `min-width:auto`, refusing to shrink below its content's intrinsic width, so the
   title `truncate` never takes effect and a long title pushes the whole row past the
   `DialogContent` boundary (`sm:max-w-lg` ≈ 512px). The redundant Radix `ScrollArea`
   from defect (1) compounds this: it injects a `display:table` viewport wrapper that
   sizes to max-content and defeats any `min-w-0` shrink chain. The same missing-`min-w-0`
   pattern is also latent on the parent-breadcrumb title in `idea-detail-panel.tsx`.

3. **Lineage tab crams unrelated trees together.** On the project dashboard's `Lineage`
   view, `idea-lineage-tree.tsx` flattens the whole forest into one DFS-ordered list and
   draws an identical 1px hairline between *every* row. The boundary between two unrelated
   top-level trees is therefore visually identical to a parent→child row inside one tree,
   so distinct lineage trees blur into a single undifferentiated block and the grouping
   the view exists to convey is lost.

## What Changes

- **Remove the redundant inner `<ScrollArea>`** in the set-parent picker and let
  `CommandList`'s native `max-h + overflow-y-auto` own vertical scrolling. This fixes
  scrolling *and* removes the `display:table` wrapper that was defeating truncation.
- **Add `min-w-0` to the picker candidate row** so the title `truncate` engages: long
  titles end in `…`, the right-side "would-cycle" badge stays `shrink-0` and fully
  visible, and rows never overflow the dialog at any width.
- **Harden the lineage breadcrumb** in `idea-detail-panel.tsx` with the same `min-w-0`
  fix (the derived-children list and tracker `IdeaCard` already use `min-w-0` and need no
  change).
- **Group lineage trees on the Lineage tab** by inserting a larger vertical gap before
  each top-level tree boundary (every `depth === 0` row after the first), keeping
  intra-tree parent→child rows tight. Each blood-related cluster reads as one visual group.
- Pure front-end change. No server action, data model, API, or i18n-key changes.

## Capabilities

- `idea-lineage` — extends the existing capability with rendering-robustness requirements
  for the set-parent picker (scroll + overflow + truncation) and a tree-grouping
  requirement for the Lineage view. See `specs/idea-lineage/spec.md` (ADDED requirements).

## Impact

- **Affected code (front-end only):**
  - `src/app/(dashboard)/projects/[uuid]/dashboard/panels/set-parent-dialog.tsx`
    (remove nested `<ScrollArea>`, add `min-w-0` on the candidate row).
  - `src/app/(dashboard)/projects/[uuid]/dashboard/panels/idea-detail-panel.tsx`
    (add `min-w-0` to the parent-breadcrumb title row).
  - `src/app/(dashboard)/projects/[uuid]/dashboard/idea-lineage-tree.tsx`
    (insert tree-boundary spacing at `depth === 0` rows after the first).
- **Tests:** component tests for the DOM-structure-assertable parts (truncation classes
  present, tree-boundary spacing only at top-level boundaries) + a real-browser Playwright
  e2e (per elaboration round 2/3) that seeds several very-long-title ideas and a multi-tree
  lineage, then asserts the candidate list scrolls to the bottom, long titles truncate,
  no horizontal overflow, and lineage trees are visually grouped.
- **No DB migration. No i18n keys added. No behavioral change to lineage data or pipeline
  semantics** — weak-lineage rules are untouched.
- **Risk:** low — CSS/markup only; the `ScrollArea` removal is the only structural change
  and is covered by the e2e scroll assertion.
