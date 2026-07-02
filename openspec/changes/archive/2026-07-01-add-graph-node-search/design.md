# Design — Resource-Graph Node Search

## Context

Three existing pieces make this an additive front-end feature, not a rebuild:

- **`resource-graph.tsx`** owns the data (`graph`), the type filter (`visible`),
  and the two-level expand state (`expandedIdeas` / `expandedProposals`, both
  `Set<string>`). It derives `forceNodes`/`forceLinks` from
  `computeVisibleSet(graph, expandedIdeas, expandedProposals)` filtered by
  `visible[type]`, and hands them to either the canvas (desktop) or the outline
  (mobile). The search state belongs here too, because both renderers must read
  the same match set + expand state (just like expand state today).
- **`mindmap-canvas.tsx`** already dims by lineage: `focusId = hoverId ??
  selectedId`; `focusLineage` = that node's ancestors-to-root + descendant
  subtree; `paintNode` sets `focusAlpha = inLineage ? 1 : 0.18`. The camera has
  a one-time `fitToView(layout, dims, viewRef)` that frames content by writing
  `viewRef.current = { scale, tx, ty }`; the painter maps graph→screen as
  `screenX = x*scale + tx`.
- **`mindmap-outline.tsx`** renders the same nodes as indented DOM rows. It has
  **no** lineage dim today — it must gain a match-highlight / non-match-dim
  treatment for parity.

The full `title` is on every `ForceNode` already (the aggregation carries it;
the canvas only truncates at paint). So matching is a pure client string op.

## Goals / Non-Goals

**Goals**
- Case-insensitive substring search on title; auto-expand to every match;
  highlight matches, dim the rest; hover takes over (lineage wins).
- `current / total` count with previous/next navigation that centers each match
  (canvas camera move; outline scroll-into-view).
- Snapshot + restore expand state around a search session.
- Reuse `focusAlpha` and `fitToView`/transform math; reuse `computeVisibleSet`.
- Zero change to the aggregation service, the tree-layout module's algorithm,
  SSE live-reconcile, or the four side panels.

**Non-Goals**
- Fuzzy/subsequence matching or matching on type/status text (Q1).
- A new backend search endpoint or aggregation field (title already client-side).
- "Fit all matches in one frame" camera (Q5 chose first-match + stepping).
- Persisting a query across navigation / reloads.

## Decisions

### D1 — Match set is pure and lives in `resource-graph.tsx`

A helper `computeSearchMatches(nodes, query)` (colocated with
`resource-graph-visible-set.ts`) returns `Set<string>` of node ids whose
lowercased `title` includes the lowercased trimmed `query`. An empty/blank query
returns `null` (the "not searching" sentinel — distinct from an empty `Set`,
which means "searched, zero hits"). The component computes matches over the
**already type-filtered** node set (Q7=a: a filtered-out type cannot match) —
i.e. over the same `visibleNodes` it hands to the renderer, not the raw `graph`.

Match ordering for prev/next is the **pre-order DFS outline order** (the order
`computeTreeLayout(...).outline` produces — the same order the mobile outline
renders and the visual top-to-bottom / left-to-right reading order), so "next"
feels spatial, not random.

### D2 — Auto-expand-to-reveal

A second pure helper `expandAncestorsForMatches(graph, matchIds)` returns
`{ ideaUuids: Set, proposalUuids: Set }` — the ancestor ideas and proposals that
must be expanded for every match to be visible. Resolution per match node:

- a **task/document** → add its `proposalUuid` to proposalUuids, then that
  proposal's first project-local `sourceIdeaUuids[0]` to ideaUuids;
- a **proposal** → add its `sourceIdeaUuids[0]` to ideaUuids;
- an **idea** → ideas are always visible; nothing to add.

The component **unions** these into the live `expandedIdeas`/`expandedProposals`
(it only ever adds — never removes a user's manual expansion mid-search). The
existing `computeVisibleSet` → `computeTreeLayout` → tween pipeline then reveals
the matches with the existing 300ms animation, no new render path. (Matching is
done over the type-filtered nodes; revealing requires the match's ancestors,
which are the same type as the hub anyway, so expansion is filter-safe.)

### D3 — Snapshot / restore expand state (Q4=a)

On the transition **not-searching → searching** (query goes from blank to
non-blank), capture `expandSnapshot = { ideas: new Set(expandedIdeas),
proposals: new Set(expandedProposals) }`. On **searching → not-searching** (Esc,
clear button, or query cleared), restore both Sets from the snapshot and drop it.
This guarantees search-forced expansion never pollutes the user's manual layout.
A snapshot is taken only on the leading edge (don't overwrite it on every
keystroke while already searching).

### D4 — Alpha composition: match dim vs. hover takeover (Q3=a)

Today `paintNode` dims by `focusLineage` alone. Generalize the per-node alpha
decision to two focus sources, resolved in priority order:

1. **Hover/selection lineage present** (`hoverId ?? selectedId` resolves a
   `focusLineage`) → behave exactly as today: in-lineage = 1.0, else 0.18.
   Hover takes over completely — matches get no special opacity in this state.
2. **Else, a match set is active** (searching) → match = 1.0, non-match = 0.18
   (reuse the same dim alpha for visual consistency).
3. **Else** (not searching, nothing hovered) → everyone 1.0 (unchanged).

So the canvas takes an additional prop, e.g. `matchIds: Set<string> | null`
(null = not searching), and `paintNode` picks the alpha by the rules above. The
"current match" ring (D5) is independent of this alpha.

> Subtlety: the existing `focusId = hoverId ?? selectedId` keeps `selectedId`
> (an open side panel) lighting a lineage. That's fine — opening a panel is an
> explicit focus. The point of Q3=a is only that **search matches** don't drive
> lineage; the current-match cursor (D5) deliberately does NOT set `selectedId`.

### D5 — Current-match cursor + camera (Q5=b, Q6=b)

`resource-graph.tsx` holds `currentMatchIndex` (into the D1-ordered match list).
The node at that index is the **current match**:

- **Visual:** a distinct highlight ring on the current match (canvas: a ring
  drawn in `paintNode` when `node.id === currentMatchId`, visually different from
  the selection ring and the plain-match full-opacity; outline: a ring/accent
  class on the row). It does **NOT** set `selectedId`, so it does **NOT** trigger
  `focusLineage` (keeps D4 rule 1 from firing off a mere search cursor).
- **Camera (desktop):** center the current match. Compute its rendered center and
  set `viewRef.current = { scale, tx: dims.width/2 - cx*scale, ty:
  dims.height/2 - cy*scale }` (the same centering math `fitToView` uses, keeping
  the current scale rather than refitting), then `scheduleRender()`. Because the
  canvas owns `viewRef`, expose a small imperative hook (e.g. a
  `centerOnRef`/callback or a `centerNodeId` prop the canvas reacts to) from the
  canvas to the parent. Prefer a `centerNodeId` prop: when it changes, the canvas
  centers on that node id after layout settles.
- **Scroll (mobile):** the outline scrolls the current match's row into view
  (`scrollIntoView({ block: "center" })` via a ref keyed by the current id).

**Stepping:** prev/next move `currentMatchIndex` with **wrap-around** (`(i + 1)
% n`, `(i - 1 + n) % n`). On a query change, after the debounce settles,
`currentMatchIndex` resets to 0 (first match) and the camera centers on it.

### D6 — Debounce (derived decision)

The match set + auto-expand recompute can run per keystroke (cheap, pure), but
the **camera recenter** is debounced (~200ms after the query settles) so the
view doesn't jump on every character. Implementation: a debounced effect keyed on
`searchQuery` that, once settled, resets `currentMatchIndex` to 0 and triggers
the center. (Highlight/dim and auto-expand can update immediately for
responsiveness; only the camera move waits.)

### D7 — Empty result (Q2=a)

When `matchIds` is a non-null **empty** Set (searched, zero hits): no auto-expand
happens, all nodes stay at full opacity (D4 rule 2 with an empty match set would
dim everything, so guard: an empty match set → treat as "no dim", i.e. render
like rule 3), and the control card shows a localized "no matches" line. Count
shows `0`. Prev/next are disabled.

### D8 — Search box + controls UI

On the existing top-right control `Card` (above or merged with the type filter):
a shadcn `<Input>` with a leading search icon and a trailing clear (`X`) button;
`Esc` in the input clears the query (route the key handler through
`isImeComposing(e)` from `@/lib/ime` and early-return while composing, per the
project IME rule, even though Esc isn't Enter — any submit/clear-on-key handler
follows the guard convention). Below the input: the `current / total` count
(e.g. `3 / 12` or a localized "12 matches" when not stepping) and prev/next
buttons (shadcn `<Button size="icon" variant="ghost">` with chevron icons),
disabled when total is 0. All strings via `t()`.

The input's `onKeyDown` (one IME-guarded handler) also maps **Enter → next match**
and **Shift+Enter → previous match** by calling the same `stepMatch(±1)` the
prev/next buttons use (a find-in-editor shortcut; a no-op when there are no
matches since `stepMatch` guards on an empty list). This was added as a follow-up
after the initial build; because the guard already routed through
`isImeComposing`, the Enter branch inherits it — a CJK candidate-confirming Enter
never advances the cursor.

## Risks / Trade-offs

- **Auto-expand changes the visible set, which retriggers layout/tween.** This is
  the intended reuse, but a very large match set could expand most of the tree.
  Acceptable — it mirrors "expand all", which already exists; restore-on-clear
  (D3) undoes it.
- **Centering during a tween:** right after auto-expand the layout is animating,
  so the current match's final position settles ~300ms later. The debounced
  recenter (D6) and reading the live rendered center (or the settled layout
  position) keep the center correct; if it lands slightly early, the next paint
  is correct. Acceptable; we center off the layout's target position, not the
  mid-tween position, to avoid chasing.
- **selectedId still lights a lineage.** If a side panel is open (selectedId set)
  AND a search is active, hover-less state shows the selected node's lineage, not
  the match dim (D4 rule 1 wins). This is consistent ("an open panel is an
  explicit focus") and rare; documented, not worked around.

## Migration

Pure front-end addition. No data migration, no API/endpoint change, no schema
change. New i18n keys under `graph.search.*` in both locales.
