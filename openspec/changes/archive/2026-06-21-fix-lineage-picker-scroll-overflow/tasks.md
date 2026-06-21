# Tasks

## 1. Lineage front-end robustness fixes

- [ ] 1.1 Remove the redundant nested `<ScrollArea max-h-[280px]>` in `set-parent-dialog.tsx`; render candidates directly in `CommandGroup` so `CommandList`'s native `max-h-[300px] overflow-y-auto` is the single scroll container.
- [ ] 1.2 Add `min-w-0` to the candidate-row `CommandItem` so the title `truncate` engages; verify the `shrink-0` cycle badge stays visible/aligned.
- [ ] 1.3 Add `min-w-0` (and `flex-1` if needed) to the parent-breadcrumb title span in `idea-detail-panel.tsx` so long parent titles truncate without overflow.
- [ ] 1.4 In `idea-lineage-tree.tsx`, insert a larger vertical group gap before each top-level tree boundary (`depth === 0` row after the first) while keeping the tight 1px hairline for in-tree rows.
- [ ] 1.5 Component tests: picker row has `truncate` + `min-w-0` and no nested scroll-area; lineage tree inserts a group gap only at top-level boundaries and preserves DFS order.
- [ ] 1.6 Playwright e2e: seed long-title ideas + a multi-tree lineage; assert the picker scrolls to the last item and the item is clickable, rows don't overflow, titles ellipsize, badges align, and Lineage-tab trees are visually grouped. Capture screenshots.
