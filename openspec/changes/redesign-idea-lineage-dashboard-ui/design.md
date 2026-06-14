# Design: Idea Lineage View Controls

## Context

Two components currently split ownership of the dashboard idea view:

- `idea-tracker.tsx` owns `activeTab: "ideas" | "stats"` and renders the `Ideas / Stats`
  segmented control + `New Idea` button in a `justify-between` row.
- `idea-tracker-list.tsx` owns `viewMode: "flat" | "tree"` and renders its own
  `Flat / By lineage` segmented control in a separate `justify-end` row.

The redesign **lifts the view selection into a single owner** so there is one control, one
row, and no layout jump.

## Decisions (from elaboration round 1)

| # | Decision |
|---|----------|
| Controls | One 3-way primary switch: `Ideas` / `Lineage` / `Stats`. `New Idea` stands alone on the right. The standalone `Flat / By lineage` control is removed. |
| Default | Adaptive: if any idea has `parentUuid` set or `childCount > 0` → default `Lineage`, else `Ideas`. |
| Compute timing | Once on first mount only. SSE refresh / newly derived child never force a switch. |
| Override memory | Manual selection persisted per project in `localStorage`; wins over adaptive default on later visits. |
| Styling | Unified beige-fill segmented control (`#EFEBE3` track + white selected pill with `shadow-sm`). |
| Stats scope | Stats is the third peer option; when selected there is no flat/lineage notion (it is not an idea list). |

## View model

Replace the two independent state atoms with one:

```ts
type DashboardView = "ideas" | "lineage" | "stats";
```

- `ideas` → status-grouped flat list (the existing `IdeaStatusGroup` rendering).
- `lineage` → `IdeaLineageTree` (existing renderer, unchanged).
- `stats` → `IdeaTrackerStats` (existing, unchanged).

`idea-tracker.tsx` becomes the single owner of `DashboardView`. `idea-tracker-list.tsx`
keeps rendering both the flat and tree layouts but is now **told which** to render via a
prop (`viewMode: "flat" | "tree"`) instead of owning a toggle. Its internal
`Flat / By lineage` segmented control and `viewMode` state are deleted.

### Why keep flat/tree as an internal prop rather than fully merging

`IdeaTrackerList` already builds both `groups` (status-keyed) and `allIdeas` (flattened for
the forest). Mapping the parent's `ideas`/`lineage` selection to a `"flat"|"tree"` prop is a
one-line translation and avoids rewriting the list's data plumbing. Stats stays a sibling
branch in the parent (it never enters the list component).

## Adaptive default + override resolution

A small helper module owns persistence (one key per project):

```ts
// dashboard-view-preference.ts
const key = (projectUuid: string) => `chorus:dashboard-view:${projectUuid}`;

export function readStoredView(projectUuid: string): DashboardView | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(key(projectUuid));
  return v === "ideas" || v === "lineage" || v === "stats" ? v : null;
}

export function storeView(projectUuid: string, view: DashboardView): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key(projectUuid), view);
}

// Adaptive default — computed from the initial tracker data, once.
export function adaptiveDefault(hasLineage: boolean): DashboardView {
  return hasLineage ? "lineage" : "ideas";
}
```

Initial state resolution (runs once, in a lazy `useState` initializer so it is not
recomputed on every render or data refresh):

```ts
const [view, setView] = useState<DashboardView>(() => {
  const stored = readStoredView(projectUuid);          // manual override wins
  if (stored) return stored;
  const hasLineage = initialTrackerData
    ? Object.values(initialTrackerData.groups)
        .flat()
        .some((i) => i.parentUuid || (i.childCount ?? 0) > 0)
    : false;
  return adaptiveDefault(hasLineage);                  // else adaptive
});

const selectView = (next: DashboardView) => {
  setView(next);
  storeView(projectUuid, next);                        // persist manual choice
};
```

Key properties:

- **Compute once**: the `useState(() => …)` initializer runs only on mount. Realtime
  refreshes (`useRealtimeEntityTypeEvent`) update the list data but never call `setView`,
  so the user's view never jumps under them.
- **Override wins**: `readStoredView` is checked first, so a stored choice short-circuits
  the adaptive branch.
- **SSR-safe**: all `localStorage` access is guarded by `typeof window`.

## Control rendering

A single segmented control with three buttons, beige-fill style (lifted from the current
`Flat / By lineage` look), in a `justify-between` row with `New Idea` on the right:

```
[ Ideas | Lineage | Stats ]                              [ + New Idea ]
```

- Track: `inline-flex gap-0.5 rounded-lg bg-[#EFEBE3] p-0.5`.
- Selected button: `bg-white font-medium text-[#2C2C2A] shadow-sm`.
- Unselected: `text-[#888780] hover:text-[#2C2C2A]`.
- `New Idea` keeps its existing orange styling (`bg-[#C67A52]`), shown only on `ideas`/`lineage`
  views (hidden on `stats`, mirroring today's behavior where New Idea hides on Stats).

## Empty-state ownership (after lifting view state)

Today `idea-tracker.tsx` hides the entire control row when `isEmpty`, and `isEmpty` is
computed *inside* `IdeaTrackerList` and pushed up via `onEmptyChange` — but only from the
list's `ideas` render branch. Once view selection moves to the parent and the list's
`viewMode` state is deleted, that bottom-up signal becomes unreliable (it would not fire
when the parent renders the tree or stats branch).

**Resolution — the parent owns emptiness.** `idea-tracker.tsx` already receives
`initialTrackerData` (the grouped tracker payload) and refreshes it on realtime events.
Emptiness is therefore derivable at the parent from the same data the switch is built on:

```ts
const totalIdeas = initialTrackerData
  ? Object.values(initialTrackerData.groups).reduce((n, arr) => n + arr.length, 0)
  : 0;
const isEmpty = totalIdeas === 0;
```

- The `onEmptyChange` callback prop on `IdeaTrackerList` is **removed**; the list no longer
  reports emptiness upward.
- **The primary switch stays mounted and reachable even when `isEmpty`.** The empty CTA
  ("no ideas yet") renders in the content area *below* the switch, so the user can still
  reach `Stats` (and `New Idea`) with zero ideas. This is a deliberate change from today's
  behavior, where the whole control row is hidden at zero ideas.
- With zero ideas there is no lineage, so `adaptiveDefault(false)` resolves to `ideas` —
  consistent with the empty CTA living under the `Ideas` view.

## i18n

- Add `ideaTracker.tabs.lineage` to both `messages/en.json` ("Lineage") and
  `messages/zh.json` ("血缘"). Reuse existing `ideaTracker.tabs.ideas` / `.stats`.
- The old `ideaTracker.lineage.viewFlat` / `.viewTree` keys are no longer used by the
  dashboard control; leave them in place (still referenced by tests/other surfaces) — removal
  is out of scope.

## Risks

- **`childCount` presence on tracker rows.** The adaptive check relies on `childCount` /
  `parentUuid` being present on the tracker API payload. They are (per `IdeaCardItem`), but
  the spec includes a scenario asserting the default falls back to `ideas` when neither
  signal is present, so a missing field degrades gracefully rather than throwing.
- **Stale stored value.** If a stored value is not one of the three literals (older build),
  `readStoredView` returns `null` and we fall back to adaptive — no crash.

## Out of scope

- The lineage tree renderer, idea cards, derive/set-parent dialogs, and the detail panel's
  lineage section are unchanged.
- No change to the tracker API or any server code.
