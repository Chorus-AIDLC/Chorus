// Expand/collapse memory for the sidebar project quick-access region when the
// user is INSIDE a project.
//
// The quick-access region (see sidebar-project-quick-access.tsx) is always
// expanded on global pages, but inside a project it defaults to a collapsed
// header row so the current project's navigation stays primary. This module
// owns how that in-project expand/collapse *choice* is remembered across visits:
// it persists a single boolean in localStorage (per browser/device).
//
// The choice is view-state, not account data — the account-level pinned/recent
// projects live server-side (see project-visit.service.ts), but whether the
// region is expanded inside a project is an ephemeral per-device preference, so
// localStorage is its right home.
//
// Mirrors the SSR-guarded, try/catch-degrading shape of
// group-expansion-preference.ts: no localStorage read in the initial render (so
// server and first client markup agree — the default is used until an effect
// hydrates the stored value), and a bad read/write degrades to the default
// rather than throwing.

/** localStorage key — global to the sidebar region (not scoped to a project). */
const STORAGE_KEY = "chorus_sidebar_quick_access_expanded";

/**
 * Default in-project expanded state: collapsed. Inside a project the region
 * starts as a header row (the spec's "collapsed by default inside a project").
 */
export const DEFAULT_IN_PROJECT_EXPANDED = false;

/**
 * Read the persisted in-project expanded flag.
 *
 * Returns the default (collapsed) when running server-side (no `window`), when
 * nothing has been stored yet, or when the stored value is malformed. Never
 * throws — a bad read degrades to the default.
 */
export function readQuickAccessExpanded(): boolean {
  if (typeof window === "undefined") return DEFAULT_IN_PROJECT_EXPANDED;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_IN_PROJECT_EXPANDED;
    // Stored as the literal string "true"/"false".
    if (raw === "true") return true;
    if (raw === "false") return false;
    return DEFAULT_IN_PROJECT_EXPANDED;
  } catch {
    // localStorage throwing (privacy mode / disabled) — degrade to default.
    return DEFAULT_IN_PROJECT_EXPANDED;
  }
}

/**
 * Persist the in-project expanded flag.
 *
 * No-op server-side. Best-effort: a failed write (quota, privacy mode) just
 * means the choice isn't remembered — it never throws.
 */
export function writeQuickAccessExpanded(expanded: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, expanded ? "true" : "false");
  } catch {
    // Best-effort: swallow storage exceptions.
  }
}
