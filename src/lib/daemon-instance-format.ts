/**
 * Shared, pure formatting helpers for daemon (agent, host, cwd) instances.
 *
 * A daemon instance is identified by `(agentUuid, clientType, host, cwd)`
 * (see `DaemonConnection`). Every owner-facing surface (presence drill-down,
 * @-mention picker, task-assignment pin, ad-hoc send picker, chat header)
 * renders the instance **path-first** (cwd primary) and **host-conditional**
 * (host de-emphasized). These helpers centralize the truncation contract so a
 * long `cwd` or `host` never breaks row layout or pushes status/tag/action
 * controls off the row.
 *
 * Truncation contract (tech_design "Key decision 3"):
 * - `formatCwd`: show the abbreviated tail (last 2 path segments). When even
 *   that exceeds the budget, drop leading segments with a leading ellipsis but
 *   ALWAYS keep the final segment (the working dir's own name) whole. The full
 *   absolute path is exposed as `title` for hover. A null cwd (legacy daemon
 *   that never self-reported one) maps to an explicit "unknown path" sentinel.
 * - `formatHost`: truncate from the RIGHT with a trailing ellipsis, capped at a
 *   fixed max width so host never crowds the path. Full host exposed as `title`.
 *   An empty host ("") maps to a localized "unknown host" placeholder.
 *
 * These functions are pure and i18n-agnostic: an "unknown" value resolves to an
 * i18n KEY (string), not English text. The caller resolves the key via
 * next-intl (`t(result.labelKey)`). This keeps the helper unit-testable and
 * avoids hardcoding English per the project i18n rules.
 */

/** i18n key the UI resolves when a cwd is unknown (legacy null-cwd daemon). */
export const UNKNOWN_PATH_KEY = "agentPresence.unknownPath";

/** i18n key the UI resolves when a host is unknown (empty self-report). */
export const UNKNOWN_HOST_KEY = "agentPresence.unknownHost";

/** Ellipsis used for left-truncation of a path's leading segments. */
const PATH_ELLIPSIS = "…/";

/** Ellipsis used for right-truncation of a host. */
const HOST_ELLIPSIS = "…";

/**
 * Default number of trailing path segments shown when the full path is long.
 * The abbreviated tail is "last 2 segments" per the truncation contract.
 */
const DEFAULT_TAIL_SEGMENTS = 2;

/**
 * Default character budget for a rendered cwd label. When the abbreviated tail
 * exceeds this, leading segments are dropped (with a "…/" prefix) until it fits,
 * but the final segment is never truncated — it is the actual repo/working dir.
 * Chosen to comfortably fit a monospace path chip; callers may override.
 */
const DEFAULT_CWD_CHAR_BUDGET = 28;

/**
 * Default maximum character width for a rendered host. Hosts are de-emphasized
 * and capped tighter than paths (design.md: "≈120px"). Callers may override.
 */
const DEFAULT_HOST_CHAR_BUDGET = 18;

export interface FormatCwdOptions {
  /** How many trailing segments to keep as the abbreviated tail. Default 2. */
  tailSegments?: number;
  /** Character budget for the visible label. Default 28. */
  charBudget?: number;
}

export interface FormattedCwd {
  /**
   * The label to render. When `isUnknown` is true this is the i18n KEY
   * (`UNKNOWN_PATH_KEY`) the caller must resolve via `t(...)`; otherwise it is
   * the already-formatted, possibly-truncated path string ready to render.
   */
  label: string;
  /**
   * The full value for a hover title. The full absolute path when known; for an
   * unknown cwd this is the same i18n KEY (caller resolves), so the title never
   * leaks raw English either.
   */
  title: string;
  /** True when the source cwd was null (legacy daemon, "unknown path"). */
  isUnknown: boolean;
}

export interface FormatHostOptions {
  /** Character budget for the visible host. Default 18. */
  charBudget?: number;
}

export interface FormattedHost {
  /**
   * The label to render. When `isUnknown` is true this is the i18n KEY
   * (`UNKNOWN_HOST_KEY`) the caller must resolve via `t(...)`; otherwise it is
   * the already-formatted, possibly-truncated host string.
   */
  label: string;
  /**
   * The full host for a hover title. For an unknown host this is the same i18n
   * KEY (caller resolves).
   */
  title: string;
  /** True when the source host was empty (""), i.e. not self-reported. */
  isUnknown: boolean;
}

/**
 * Split an absolute (or relative) path into its non-empty segments, tolerant of
 * a leading slash, trailing slash, and repeated separators. The path is
 * normalized to "/" separators first so a Windows-style cwd still abbreviates
 * by its tail.
 */
function splitSegments(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((seg) => seg.length > 0);
}

/**
 * Format a daemon instance's working directory for path-first display.
 *
 * - `null` cwd → the "unknown path" sentinel (`isUnknown: true`, label/title =
 *   `UNKNOWN_PATH_KEY` for the caller to localize).
 * - Otherwise → the abbreviated tail (last `tailSegments` segments). If that
 *   tail still exceeds `charBudget`, leading segments are dropped one at a time
 *   with a leading "…/", but the FINAL segment is always kept whole. If even a
 *   single final segment exceeds the budget, it is still shown in full (never
 *   truncated) — the contract guarantees the working dir name stays intact.
 *
 * `title` is always the full original absolute path (with original separators)
 * for hover, even when the visible label is abbreviated.
 */
export function formatCwd(
  absPath: string | null,
  opts: FormatCwdOptions = {},
): FormattedCwd {
  if (absPath === null) {
    return { label: UNKNOWN_PATH_KEY, title: UNKNOWN_PATH_KEY, isUnknown: true };
  }

  const tailSegments = opts.tailSegments ?? DEFAULT_TAIL_SEGMENTS;
  const charBudget = opts.charBudget ?? DEFAULT_CWD_CHAR_BUDGET;

  const segments = splitSegments(absPath);

  // No real segments (e.g. "/", "", "//"). Show the raw path as-is so root and
  // empty strings remain visible; full path stays the title.
  if (segments.length === 0) {
    return { label: absPath, title: absPath, isUnknown: false };
  }

  // The abbreviated tail: at most the last `tailSegments` segments.
  const isAbbreviatedFromFull = segments.length > tailSegments;
  const tail = segments.slice(-tailSegments);

  // Build the candidate label. If we already dropped leading segments to form
  // the tail, prefix the ellipsis; otherwise it's the whole (short) path.
  const buildLabel = (segs: string[], droppedLeading: boolean): string => {
    const joined = segs.join("/");
    return droppedLeading ? `${PATH_ELLIPSIS}${joined}` : joined;
  };

  let visibleSegs = tail;
  let droppedLeading = isAbbreviatedFromFull;
  let label = buildLabel(visibleSegs, droppedLeading);

  // Over budget: drop leading segments of the tail one at a time, always
  // keeping at least the final segment. Each drop forces the leading ellipsis.
  while (label.length > charBudget && visibleSegs.length > 1) {
    visibleSegs = visibleSegs.slice(1);
    droppedLeading = true;
    label = buildLabel(visibleSegs, droppedLeading);
  }

  return { label, title: absPath, isUnknown: false };
}

/**
 * Format a daemon instance's host for de-emphasized, host-conditional display.
 *
 * - `""` host (not self-reported) → the "unknown host" sentinel
 *   (`isUnknown: true`, label/title = `UNKNOWN_HOST_KEY` for the caller to
 *   localize). This preserves the existing empty-string-coercion behavior in a
 *   single, testable place.
 * - Otherwise → right-truncated with a trailing "…" so the visible string never
 *   exceeds `charBudget` characters (the ellipsis counts toward the budget).
 *   `title` is the full host for hover.
 */
export function formatHost(
  host: string,
  opts: FormatHostOptions = {},
): FormattedHost {
  if (host === "") {
    return { label: UNKNOWN_HOST_KEY, title: UNKNOWN_HOST_KEY, isUnknown: true };
  }

  const charBudget = opts.charBudget ?? DEFAULT_HOST_CHAR_BUDGET;

  if (host.length <= charBudget) {
    return { label: host, title: host, isUnknown: false };
  }

  // Reserve room for the trailing ellipsis. Guard against a tiny budget so we
  // always emit at least the ellipsis rather than a negative slice.
  const keep = Math.max(0, charBudget - HOST_ELLIPSIS.length);
  const label = `${host.slice(0, keep)}${HOST_ELLIPSIS}`;

  return { label, title: host, isUnknown: false };
}
