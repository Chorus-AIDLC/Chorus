// Expand/collapse memory for the project-list group cards.
//
// The project list (see page.tsx) shows projects grouped by ProjectGroup, plus
// an "Ungrouped" bucket. This module owns how the open/collapsed choice is
// *remembered* across visits: it persists the SET OF EXPANDED group keys in
// localStorage (per browser).
//
// Modeling the state as a set of *expanded* keys — rather than a per-group
// boolean map — is deliberate. A key that is absent from the set is collapsed,
// which means both a first-ever visit (empty set) and a newly-created group
// (not yet in the set) default to collapsed with no "have I seen this group
// before?" bookkeeping. Real groups key on their `group.uuid`; the Ungrouped
// section keys on the existing `UNGROUPED_DROPPABLE_ID` ("__ungrouped__")
// sentinel. Stale keys for deleted groups are harmless — they are never matched
// against a rendered group, so they are simply ignored on read.
//
// Mirrors the SSR-guarded, try/catch-degrading shape of
// dashboard-view-preference.ts (readStoredView / storeView).

/** localStorage key — global to the project list (not scoped to an entity). */
const STORAGE_KEY = "chorus_projects_expanded_groups";

/**
 * Read the set of currently-expanded group keys.
 *
 * Returns an empty Set when running server-side (no `window`), when nothing has
 * been stored yet, or when the stored value is malformed (not valid JSON, not an
 * array, or an array with non-string members — e.g. written by an older build).
 * Never throws — a bad read degrades to "everything collapsed".
 */
export function readExpandedGroups(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    if (!parsed.every((k) => typeof k === "string")) return new Set();
    return new Set(parsed as string[]);
  } catch {
    // Malformed JSON, or localStorage throwing (privacy mode / disabled) —
    // degrade to an empty set.
    return new Set();
  }
}

/**
 * Persist the set of expanded group keys as a JSON string array.
 *
 * No-op server-side. Best-effort: a failed write (quota, privacy mode) just
 * means the choice isn't remembered — it never throws.
 */
export function writeExpandedGroups(keys: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Best-effort: swallow storage exceptions.
  }
}
