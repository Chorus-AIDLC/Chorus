# Add Node Search to the Resource-Graph Mind-Map

## Why

The resource-graph mind-map can collapse/expand, filter by type, hover-highlight
a node's lineage, and show each node's status on its card — but it has **no way
to search for a node**. When a project has many ideas/proposals/tasks/documents
and the tree is collapsed, finding a specific node by title means scanning by
eye and manually expanding layer by layer. Deep nodes hidden under a collapsed
idea/proposal are especially hard to reach.

The full `title` of every node is already on the client (the canvas only
truncates at paint time, it never mutates the source string), so title matching
needs **no new backend query** — the data is already loaded by the existing
aggregation. The feature is purely a front-end addition that reuses two
mechanisms already in place:

- the **dim mechanism** — `mindmap-canvas.tsx` already computes a `focusLineage`
  set (the hovered/selected node's ancestors + descendants) and paints each node
  at `focusAlpha` 1.0 (in lineage) or 0.18 (out). Search highlight reuses this
  same alpha channel by feeding a second focus source (the match set) into the
  per-node alpha decision.
- the **expand model** — `expandedIdeas` / `expandedProposals` Sets in
  `resource-graph.tsx`, consumed by `computeVisibleSet`. Auto-expand-to-hit adds
  the ancestor ideas/proposals of each match to those Sets so the existing
  visible-set → tree-layout → tween pipeline reveals the hits with the existing
  300ms animation.

## What Changes

Add a **search box** to the graph view (reusing shadcn `<Input>`, on the
existing top-right control card) that, as the user types a query:

1. **Auto-expands to every hit.** For each matching node, its ancestor chain
   (idea → its proposal → its task/document) is added to the expand Sets so the
   match becomes visible even if it was hidden under a collapsed hub.
2. **Highlights matches.** All title-matching nodes stay at full opacity.
3. **Dims the rest.** Non-matching nodes drop to the existing dim alpha (the
   same visual the hover lineage-focus uses), so the handful of matches pop.
4. **Hover still takes over.** Search highlight is "a set of discrete matches";
   if the user hovers a node while a search is active, the existing hover
   behavior wins — that node's **entire upstream + downstream lineage** lights
   up and everything else (including other matches) dims. Search highlight only
   governs the non-hover state.

### Decisions locked in elaboration (idea 0957b076)

- **Match rule (Q1=a):** case-insensitive **substring** match on **title only**
  (not type/status text, no fuzzy). Simplest and most predictable; no backend.
- **Empty result (Q2=a):** keep all nodes at normal opacity and show a one-line
  "no matches" hint. Do not gray out the whole tree.
- **Hover composition (Q3=a):** hover takes over — only the hovered node's full
  lineage is lit, everything else (including matches) dims; matches stay lit only
  while nothing is hovered.
- **Exit/restore (Q4=a):** snapshot `expandedIdeas`/`expandedProposals` when a
  search begins; on clear (Esc / clear button / empty query) restore the
  snapshot so search-forced expansion does not pollute the user's manual layout.
- **Camera (Q5=b):** on a settled query, center the camera on the **first match**
  (desktop); on mobile, scroll the first match into view. (Not "fit all matches
  in frame".)
- **Count + navigation (Q6=b):** show **"current / total"** (e.g. `3 / 12`) with
  **previous / next** buttons that step through matches, centering each.
  Pressing **Enter** in the search box steps to the next match and
  **Shift+Enter** to the previous (find-in-editor keyboard shortcut, IME-guarded)
  — a follow-up requested after the initial build.
- **Type filter interaction (Q7=a):** match only within currently-visible
  (checked) types; a filtered-out type produces no matches. Search never flips
  the user's filter checkboxes.

### Derived implementation decisions (confirmed with requester)

- The **"current match"** indicator (the prev/next cursor) is visually distinct
  from a plain match (e.g. a highlight ring) and drives the camera, but it does
  **NOT** trigger the `selectedId → focusLineage` ancestor/descendant lighting.
  The whole-tree state stays "all matches lit, rest dimmed"; lineage lighting
  happens **only** on hover (per Q3=a) so the two never fight.
- **Wrap-around:** "next" past the last match returns to the first; "previous"
  before the first goes to the last.
- **Mobile outline:** shows the same `3 / 12` + prev/next; each step scrolls the
  current match into view and centers it (the DOM analog of the canvas camera).
  The outline also gains a match-highlight / non-match-dim treatment it does not
  currently have.
- **Debounce:** as the query changes the match set changes; the camera recenters
  (to the first match) only after the query settles (debounced), not on every
  keystroke.
- **i18n:** placeholder, "no matches", and the count text are localized (en+zh).

This is an **ADDED** capability requirement on `project-resource-graph`. No
existing requirement changes meaning; no aggregation/service change, no schema
change.

## Capabilities

- `project-resource-graph` (ADDED) — node search that auto-expands to matches,
  highlights matches while dimming the rest, supports a match count with
  previous/next navigation, and yields to the existing hover lineage-highlight.

## Impact

- **Code (front-end only):**
  - A pure match helper (case-insensitive substring over visible-typed nodes) +
    an "expand-to-reveal" helper that, given the match set and the full graph,
    returns the ancestor ideas/proposals to add to the expand Sets. Both unit-
    tested, colocated with `resource-graph-visible-set.ts`.
  - `resource-graph.tsx`: owns `searchQuery`, the match set, the current-match
    index, the pre-search expand snapshot, and the search↔expand wiring; renders
    the search box + count/nav controls on the existing control card.
  - `mindmap-canvas.tsx`: extend per-node alpha so a match set dims non-matches
    when nothing is hovered (hover lineage still wins); paint the current-match
    ring; recenter the camera on the current match (reusing the `fitToView`
    transform math).
  - `mindmap-outline.tsx`: add match-highlight / non-match-dim row treatment and
    scroll-the-current-match-into-view; render the same count/nav on mobile.
- **i18n:** new keys (`graph.search.*`) in both `en` and `zh`.
- **Tests:** unit tests for the match + expand-to-reveal helpers (incl. empty
  result, filtered-out types, deep nesting, wrap-around index math); component
  tests for canvas alpha composition (match dim vs. hover takeover), the
  current-match ring, and the outline highlight + count/nav.
- **design.pen:** update the "Chorus - Project Graph View" screen to show the
  search box, count/nav, match highlight, and dimmed non-matches.

## Out of Scope

- Fuzzy / subsequence matching and matching on type/status text (Q1 chose
  substring-on-title; can be a later enhancement).
- Any backend/aggregation change or new search endpoint (title is already on the
  client).
- A "fit all matches in one frame" camera mode (Q5 chose first-match centering +
  prev/next stepping).
