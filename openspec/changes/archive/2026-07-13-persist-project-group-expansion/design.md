# Design: Persist project-list group expand/collapse state

## Context

`ProjectsPage` (`src/app/(dashboard)/projects/page.tsx`, a `"use client"`
component) renders the grouped project list. Two sub-components own the
expand/collapse UI:

- `GroupSection` — one real ProjectGroup, keyed by `group.uuid`. It renders a
  Radix `Collapsible` wired to `const [isOpen, setIsOpen] = useState(defaultOpen)`
  (line ~307). The page passes `defaultOpen={index === 0}` (line ~944), so only
  the first group opens on mount.
- `UngroupedSection` — the projects with no group (a pseudo-group, not a real
  `ProjectGroup`). Its droppable id is the module constant
  `UNGROUPED_DROPPABLE_ID = "__ungrouped__"` (line ~289). It seeds
  `useState(false)` (line ~452) — always collapsed on mount.

Because `defaultOpen` only feeds the `useState` **initializer**, it is read once
at mount and any subsequent toggle is purely local and never persisted. There is
no shared store of "which groups are open."

The same file already persists the list/grid view mode to `localStorage` under
key `chorus_projects_view_mode` (lines ~587–596), reading it in a `useState`
initializer guarded by `typeof window !== "undefined"` and writing it back in a
`useEffect`. That is the established local pattern; a more defensive,
unit-tested variant lives at
`src/app/(dashboard)/projects/[uuid]/dashboard/dashboard-view-preference.ts`
(`readStoredView` / `storeView`, SSR-guarded, try/catch-degrading). This design
follows the *latter* (extract a tiny tested helper) because the expansion state
is a set, not a scalar, and benefits from a parse/serialize seam we can test.

## Elaboration contract (binding)

One resolved round on idea `db1d007f`:

- **Q1 = a** — store client-side in browser `localStorage`, per browser. No
  server-side per-user preference, no new API.
- **Q2 = b** — a group the user has never toggled (first-ever visit, or a
  newly-created group not in the saved state) defaults to **collapsed**. This
  changes today's "first group auto-expands" behavior.
- **Q3 = a** — the "Ungrouped" section is remembered too, like any real group.

## Goal

The project list reopens exactly as the user left it. The only "no saved state"
fallback is all-collapsed.

## Decisions

### D1 — Model expansion as a Set of expanded keys (collapsed = absent)

Persist the **set of keys that are currently expanded**, not a per-group boolean
map. This directly encodes Q2: a key that is not in the set is collapsed, which
means (a) a brand-new user with no saved state has an empty set → everything
collapsed, and (b) a newly-created group is absent from the set → collapsed,
with no special "seen this group before?" bookkeeping. Toggling a group open
adds its key; collapsing removes it. Stale keys for deleted groups sit
harmlessly in storage (never matched against a rendered group) — they are simply
ignored on read, so no active pruning is required.

**Key scheme:** real groups use `group.uuid`; the Ungrouped section uses the
existing sentinel `"__ungrouped__"` (reuse `UNGROUPED_DROPPABLE_ID`, do not
invent a second constant). UUIDs never collide with the sentinel.

### D2 — Extract an SSR-safe, tested helper module

New file `src/app/(dashboard)/projects/group-expansion-preference.ts`, modeled on
`dashboard-view-preference.ts`:

```ts
const STORAGE_KEY = "chorus_projects_expanded_groups";

/** Read the set of expanded group keys. Empty set when unset / SSR / malformed. */
export function readExpandedGroups(): Set<string> { … }

/** Persist the set of expanded group keys. No-op server-side; best-effort. */
export function writeExpandedGroups(keys: Set<string>): void { … }
```

- Serialize as a JSON string array (`JSON.stringify([...keys])`); parse with a
  guard that returns an empty set on non-array / parse error / non-string
  members. Never throws.
- `readExpandedGroups()` returns `new Set()` when `typeof window === "undefined"`,
  when the key is absent, or when the value is malformed (older/other build).
- `writeExpandedGroups()` is a no-op server-side and swallows quota/security
  exceptions (privacy mode), matching `storeView`.

Storage-key name follows the same-file `chorus_projects_*` convention
(`chorus_projects_expanded_groups`), not the `chorus:...:scope` form — this state
is global to the project list, not scoped to one entity.

### D3 — Lift open-state into the page; make the sections controlled

`ProjectsPage` owns a single `expandedGroups: Set<string>` state:

- **Seed to empty on the server / first render, hydrate from storage in a
  post-mount `useEffect`.** Do NOT read `localStorage` in the `useState`
  initializer here. Rationale: unlike the `viewMode` scalar (which the existing
  code reads inline), seeding from storage inline is only safe because the page
  gates all group rendering behind `loading` and renders nothing group-related in
  server HTML. To be defensive and consistent with the tested
  `idea-tracker.tsx` approach — and because the data is fetched client-side after
  mount anyway (groups don't exist until `fetchData` resolves) — we seed empty
  and apply stored state in an effect. There is no flash: the group cards only
  appear after the client-side fetch completes, well after hydration.

- A `toggleGroup(key: string, open: boolean)` callback updates the set
  immutably and writes it through `writeExpandedGroups`. Wire persistence either
  inside the callback or via a `useEffect([expandedGroups])` that skips the
  initial empty render — either is acceptable; the callback approach avoids
  persisting the transient empty seed.

- `GroupSection` and `UngroupedSection` become **controlled**: replace their
  internal `useState` with props `open: boolean` and
  `onOpenChange: (open: boolean) => void`, passed from the page. The page
  computes `open={expandedGroups.has(group.uuid)}` (and
  `expandedGroups.has(UNGROUPED_DROPPABLE_ID)` for Ungrouped) and passes
  `onOpenChange={(o) => toggleGroup(key, o)}`. Radix `Collapsible` already takes
  `open` + `onOpenChange`, so the `Collapsible` wiring is unchanged; only the
  source of the boolean moves up.

- **Remove `defaultOpen` / `index === 0`.** The `index` argument of
  `groups.map` is no longer needed for expansion (keep it only if still used for
  keys — it is not; `key={group.uuid}`).

### D4 — Why not keep per-component state + a persistence effect each

Keeping `useState` inside each section and syncing to storage per-instance would
re-introduce the mount-time seeding problem (each instance reads storage
independently) and scatter the storage key across two components. Lifting to the
page centralizes the read/write to one place and one effect, and makes the
sections dumb/controlled — easier to reason about and test.

## Alternatives considered

- **Server-side per-user preference** (Q1 option b) — rejected by the owner;
  would need a new preference API + storage and cross-device sync semantics for a
  minor UI convenience.
- **Persist a full `{key: boolean}` map** — rejected: it forces us to distinguish
  "explicitly collapsed" from "never seen," which Q2=b makes unnecessary (both
  are just "collapsed"). A set of expanded keys is the minimal encoding.

## Risks

- **Behavior change on first visit.** Existing users who relied on the first
  group being open will now see everything collapsed until they expand once (then
  it sticks). This is the explicit Q2=b decision; called out in the PRD so it is
  not a surprise at review.
- **Stale keys accumulate** for deleted groups. Harmless (ignored on read); not
  worth active pruning. Noted so a reviewer doesn't flag it as a leak.
- **localStorage disabled / privacy mode.** Helper degrades to empty-set reads
  and no-op writes; the page still works, just without persistence — same
  posture as the existing view-mode and dashboard-view helpers.

## Testing

- **Unit-test the helper** (`group-expansion-preference.test.ts`): round-trip a
  set; empty set when key absent; empty set on malformed JSON / non-array /
  non-string members; no-op / empty under a stubbed missing `window` or a
  throwing `localStorage`. This is the pure, deterministic core.
- **Manual e2e (both themes):** on `/projects`, expand a non-first group and
  collapse the first, reload → the same groups are open; expand Ungrouped, reload
  → Ungrouped stays open; clear the key, reload → all collapsed. Verified in
  light and dark (no color/layout-class change, so this is a structural check).

## Design.pen

This is a behavior-only refinement to an existing control (which groups start
open) — no new screen or component, no layout/visual change to the group cards.
The project-list screen is already represented in `docs/design.pen`; this change
does not add or restructure frames. No `.pen` edit is required.
