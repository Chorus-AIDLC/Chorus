// View-mode selection for the project dashboard Overview.
//
// The dashboard shows ideas one of three ways: a flat status-grouped list
// ("ideas"), a derivation tree ("lineage"), or aggregate stats ("stats").
// This module owns how that choice is *defaulted* and *remembered*:
//
// - adaptiveDefault(): progressive disclosure — surface the lineage tree only
//   when the project actually has derivation, otherwise the familiar flat list.
// - readStoredView() / storeView(): a per-project manual override that wins over
//   the adaptive default on subsequent visits.
//
// The adaptive default is computed once on mount (see idea-tracker.tsx); a later
// data refresh must never yank the user to a different view.

export type DashboardView = "ideas" | "lineage" | "stats";

const VALID_VIEWS: readonly DashboardView[] = ["ideas", "lineage", "stats"];

/** localStorage key — scoped per project so preferences don't leak across projects. */
const storageKey = (projectUuid: string): string => `chorus:dashboard-view:${projectUuid}`;

/**
 * Read the user's stored view preference for a project.
 *
 * Returns null when there is no preference, when running server-side (no
 * `window`), or when the stored value isn't one of the three valid views
 * (e.g. written by an older build) — callers fall back to the adaptive default.
 */
export function readStoredView(projectUuid: string): DashboardView | null {
  if (typeof window === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(storageKey(projectUuid));
  } catch {
    // localStorage can throw (privacy mode, disabled storage) — degrade to null.
    return null;
  }
  return VALID_VIEWS.includes(raw as DashboardView) ? (raw as DashboardView) : null;
}

/** Persist the user's manual view choice for a project. No-op server-side. */
export function storeView(projectUuid: string, view: DashboardView): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(projectUuid), view);
  } catch {
    // Best-effort: a failed write just means the choice isn't remembered.
  }
}

/** The adaptive default: lineage when the project has derivation, else the flat list. */
export function adaptiveDefault(hasLineage: boolean): DashboardView {
  return hasLineage ? "lineage" : "ideas";
}

/** Minimal shape needed to detect lineage — decoupled from the full tracker item type. */
interface LineageProbe {
  parentUuid?: string | null;
  childCount?: number;
}

/**
 * True when any idea across the status groups participates in a lineage —
 * i.e. has a parent (`parentUuid`) or derived children (`childCount > 0`).
 * Absent fields count as "no signal" and never throw.
 */
export function hasLineageInGroups(
  groups: Record<string, LineageProbe[]> | undefined | null,
): boolean {
  if (!groups) return false;
  return Object.values(groups).some((ideas) =>
    ideas.some((idea) => Boolean(idea.parentUuid) || (idea.childCount ?? 0) > 0),
  );
}
