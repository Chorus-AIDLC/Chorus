# Technical Design: Fix lineage picker scroll/overflow + lineage-tab grouping

## Overview

Three independent front-end defects in the idea-lineage UI, all CSS/markup-level. No
shared runtime contract between them, so they can be implemented and reviewed together as
one cohesive "lineage front-end robustness" module without cross-task coupling.

## Defect 1 + 2 — Set-parent picker: cannot scroll, rows overflow

### Current structure (`set-parent-dialog.tsx`)

```
<DialogContent>                       // sm:max-w-lg ≈ 512px, max-w-[calc(100%-2rem)]
  <Command>
    <CommandInput/>
    <CommandList>                     // command.tsx:55 — max-h-[300px] overflow-y-auto  ← already a scroller
      <CommandEmpty/>
      <CommandGroup>                  // command.tsx:83 — overflow-hidden
        <ScrollArea max-h-[280px]>    // set-parent-dialog.tsx:136 — REDUNDANT 2nd scroller, broken
          {candidates.map(idea =>
            <CommandItem className="flex items-center justify-between gap-2 …">  // ← missing min-w-0
              <span className="truncate …">{idea.title}</span>                  // ← truncate never fires
              {isBlocked && <span className="… shrink-0 …"><Ban/> cycleBlocked</span>}
            </CommandItem>
          )}
        </ScrollArea>
      </CommandGroup>
    </CommandList>
  </Command>
</DialogContent>
```

### Root cause

- **No scroll:** the Radix `ScrollArea.Root` (`scroll-area.tsx`) gets only `max-h-[280px]`
  and no definite height. Its `Viewport` is `size-full` (`height:100%`); with no
  fixed-height ancestor, `100%` resolves to content height, so the viewport never has a
  smaller box than its content and never becomes an overflow region — the scrollbar
  thumb never appears. Meanwhile the parent `CommandGroup` is `overflow-hidden`, so the
  portion of the list beyond the `max-h-[280px]` box is clipped and unreachable (can't be
  scrolled into view, can't be clicked).
- **Overflow / no truncation:** the candidate-row `CommandItem` is a flex container with a
  flex-child title `<span class="truncate">`. The default `min-width:auto` on the title
  refuses to shrink below intrinsic content width, so `truncate` (which needs the box to
  be allowed to become narrower than its content) is inert; with `justify-between`, the
  long title pushes the row past the dialog edge. The redundant Radix `ScrollArea` makes
  this worse: its `Viewport` injects an inner `<div style="min-width:100%; display:table">`
  wrapper, and a `display:table` box sizes to max-content — defeating any `min-w-0` shrink
  chain underneath it (documented pitfall; previously bit the daemon transcript wide-table
  fix).

### Fix

1. **Delete the nested `<ScrollArea>`** wrapper; render `candidates.map(...)` directly
   inside `CommandGroup`. `CommandList`'s own `max-h-[300px] overflow-y-auto` becomes the
   single, working scroll region. This also removes the `display:table` wrapper.
2. **Add `min-w-0` to the candidate-row `CommandItem`** className (alongside the existing
   `flex items-center justify-between gap-2`). The title `<span class="truncate">` then
   shrinks and ellipsizes; the `shrink-0` badge stays fully visible and right-aligned.
   (If needed, wrap the title in a `min-w-0 flex-1` span — but `min-w-0` on the row is
   sufficient because the title is the only growable child.)

> cmdk note: `cmdk`'s `CommandList` virtualization is not enabled here (plain children),
> and `cmdk` filters/hides items by `value`; removing the extra scroll wrapper does not
> change item filtering — `CommandInput` search still works because filtering is on
> `CommandItem value`, independent of the scroll container.

## Defect 2b — Lineage breadcrumb in `idea-detail-panel.tsx`

The parent breadcrumb (`idea-detail-panel.tsx`, the `idea.parent` button) lays out
`CornerLeftUp` (`shrink-0`) + a `derivedFrom` label (`shrink-0`) + the parent title
(`truncate`) as direct flex children **without `min-w-0`** on the title — same latent
failure as defect 2. Add `min-w-0` (and `flex-1` if required) to the title span so a long
parent title truncates instead of stretching the row. The derived-children list
(`min-w-0` already present) and the tracker `IdeaCard` (`min-w-0` already present) need no
change — verified by reading the source.

## Defect 3 — Lineage tab tree grouping (`idea-lineage-tree.tsx`)

### Current

`buildForest(ideas)` returns a single DFS-ordered `FlatRow[]`, where each top-level tree
starts at a `depth === 0` row and its descendants follow with `depth > 0`. The render is:

```
rows.map((row, idx) =>
  <div key=…>
    {idx > 0 && <div className="mx-0 h-px bg-[#F0EEEA]" />}   // identical hairline between ALL rows
    <PresenceIndicator …><IdeaCard depth=… showConnector=… /></PresenceIndicator>
  </div>
)
```

So a new-tree boundary and an in-tree parent→child boundary are rendered identically.

### Fix

Distinguish **top-level tree boundaries** (a `depth === 0` row that is not the first row)
from in-tree row separators. At a tree boundary, render a larger vertical gap (a spacer /
bigger margin) instead of — or in addition to — the hairline; keep the tight 1px hairline
for in-tree rows. This requires no change to `buildForest` (DFS order already guarantees
`depth === 0` marks each new top-level tree) and no change to `IdeaCard`.

Implementation sketch (exact classes finalized in code):

```
rows.map((row, idx) => {
  const isTreeBoundary = idx > 0 && row.depth === 0;   // start of a new top-level tree
  return (
    <div key={row.idea.uuid}>
      {isTreeBoundary
        ? <div className="h-2.5" aria-hidden />          // group gap between unrelated trees
        : idx > 0 && <div className="mx-0 h-px bg-[#F0EEEA]" />}  // tight in-tree separator
      <PresenceIndicator …><IdeaCard …/></PresenceIndicator>
    </div>
  );
})
```

The outer `rounded-lg bg-white overflow-hidden` container is preserved; the gap is a
transparent spacer so the grouped trees still sit on one surface but read as distinct
clusters.

## Testing

- **Component tests (jsdom — DOM-structure assertions only):**
  - Picker row renders the title with the `truncate` class and the row carries `min-w-0`;
    the blocked badge carries `shrink-0`.
  - No nested `[data-slot="scroll-area"]` remains inside the picker `CommandList`.
  - Lineage tree: given a forest with two top-level trees (one with children), a
    group-gap element appears only at the second tree's `depth === 0` boundary, and
    in-tree rows use the hairline — assert by structure/marker, not pixel size.
- **Playwright e2e (real browser — the only way to verify scroll & overflow; per
  elaboration rounds 2 & 3):**
  - Seed several ideas with very long titles + a multi-tree lineage in the local DB.
  - Open the set-parent dialog: assert the candidate list scrolls to the last item
    (`scrollTop` reaches bottom), the last item is clickable, long rows do not overflow
    (`scrollWidth <= clientWidth` on the dialog / no row wider than `DialogContent`), titles
    are ellipsized, and the cycle badge stays aligned.
  - Open the Lineage tab: screenshot + assert unrelated trees are separated by the group
    gap while in-tree rows stay tight.
  - jsdom returns 0 for `scrollHeight`/`getBoundingClientRect`, so scroll/overflow can
    only be validated in a real browser — this is exactly the gap that let the no-scroll
    bug ship originally.

## Risks & Mitigations

- **Risk:** removing the `<ScrollArea>` changes the scrollbar appearance (native vs Radix
  styled). **Mitigation:** acceptable — `CommandList` is the standard cmdk scroller used
  elsewhere; the e2e confirms scrolling works and the visual is consistent with other
  command palettes.
- **Risk:** group-gap spacer could look like an empty list row. **Mitigation:** transparent
  `aria-hidden` spacer with no border; e2e screenshot review confirms it reads as a gap.
- **Risk:** very deep/however-many trees still need the picker to scroll — covered, since
  the fix restores the single working scroller with no height cap regression.
