// src/app/(dashboard)/projects/[uuid]/graph/node-status.ts
//
// Shared status presentation for resource-graph nodes. The canvas painter
// (mindmap-canvas.tsx) consumes `(type, statusValue)` and needs ONE source of
// truth for the label key and color pair. (The DOM outline renderer that also
// consumed this was removed when the canvas became the sole rendering on all
// viewports; the resolver stays shared so any future consumer remains
// color-identical to the canvas, which paints raw hex via Path2D.)
//
// Vocabularies (verbatim from the existing per-entity surfaces — do not
// re-pick colors here):
//   - idea  → derived `badgeHint` (8 values), reusing idea-card.tsx's
//             `badgeHintI18n` (→ ideaTracker.badge.*) and `badgeHintColor`.
//             Those consts are FILE-LOCAL in idea-card.tsx (not exported),
//             so the entries are COPIED verbatim here.
//   - proposal/task → raw lifecycle status, reusing node-tooltip.tsx's
//             PROPOSAL_STATUS_COLOR / TASK_STATUS_COLOR + STATUS_I18N maps
//             (now lifted into this module — node-tooltip imports them
//             from here).
//   - document     → Document.type (PRD / Tech Design / ...), reusing
//             node-tooltip's DOC_TYPE_COLOR + DOC_TYPE_I18N (also lifted).
//
// All i18n label keys referenced below already exist in BOTH messages/en.json
// and messages/zh.json (verified). No new keys are introduced; if an unmapped
// or sentinel status arrives we resolve to `UNKNOWN_FALLBACK` so the renderer
// never crashes on a missing key.
//
// Field shape:
//   {
//     labelKey:   "ideaTracker.badge.building" | "status.inProgress" | ...
//     colorClass: Tailwind "bg-[#RRGGBB] text-[#RRGGBB]" (DOM badge)
//     bg:         "#RRGGBB" (canvas fill)
//     fg:         "#RRGGBB" (canvas text)
//   }
//
// `bg`/`fg` MUST equal the hex pair inside `colorClass`; a unit test pins this
// parity (node-status.test.ts).

import type { ResourceGraphNodeType } from "@/services/resource-graph.service";

export interface NodeStatusVisual {
  /** Full i18n key — pass directly to t() (e.g. `useTranslations()` root). */
  labelKey: string;
  /** Tailwind classes for the DOM badge (`bg-[#..] text-[#..]`). */
  colorClass: string;
  /** Canvas fill hex (the `bg-[#..]` half of colorClass). */
  bg: string;
  /** Canvas text hex (the `text-[#..]` half of colorClass). */
  fg: string;
  /**
   * Dark-mode canvas fill hex (the `dark:bg-[#..]` half of colorClass). The
   * canvas paints raw hex (Canvas 2D can't read `dark:` classes), so the painter
   * picks `darkBg`/`darkFg` when `<html>` carries `.dark`. Falls back to `bg`/`fg`
   * when a status has no dark variant.
   */
  darkBg: string;
  /** Dark-mode canvas text hex (the `dark:text-[#..]` half of colorClass). */
  darkFg: string;
}

// ---------------------------------------------------------------------------
// Idea badgeHint vocabulary — COPIED verbatim from idea-card.tsx
// (badgeHintI18n + badgeHintColor; both file-local consts there).
//
// idea-card.tsx applies these via `<span className={`... text-only color ...`}>`
// so only the foreground is given. The card visually wraps it in a neutral
// chip background (`bg-[#F0EEEA]`). We carry the same `bg-[#F0EEEA]` here so
// the graph badge reads identical to the tracker — same chip + same color.
// ---------------------------------------------------------------------------
const IDEA_BADGE_HINT_CHIP_BG = "#F0EEEA";
// Dark-mode neutral chip background for the idea badge — matches the app's
// `bg-secondary` under `.dark` (24 7% 20% → ~#332e29), so the graph chip reads
// like the tracker's secondary-chip rather than glowing pale on the charcoal
// surface. Foregrounds get lighter same-hue dark values (mirroring
// idea-card.tsx's `badgeHintColor` dark: variants) for legibility.
const IDEA_BADGE_HINT_CHIP_BG_DARK = "#332e29";

interface IdeaHintEntry {
  /** key suffix under `ideaTracker.badge.*` */
  labelKeySuffix: string;
  /** foreground (text-[#..]) hex from idea-card.tsx's badgeHintColor */
  fg: string;
  /** dark foreground (dark:text-[#..]) — lighter same-hue value for the dark canvas */
  darkFg: string;
}

const IDEA_BADGE_HINT: Record<string, IdeaHintEntry> = {
  open: { labelKeySuffix: "open", fg: "#888780", darkFg: "#aba29a" },
  researching: { labelKeySuffix: "researching", fg: "#7F77DD", darkFg: "#A99FF0" },
  answer_questions: { labelKeySuffix: "answerQuestions", fg: "#C47A20", darkFg: "#E0A050" },
  planning: { labelKeySuffix: "planning", fg: "#7F77DD", darkFg: "#A99FF0" },
  review_proposal: { labelKeySuffix: "reviewProposal", fg: "#C47A20", darkFg: "#E0A050" },
  building: { labelKeySuffix: "building", fg: "#7F77DD", darkFg: "#A99FF0" },
  verify_work: { labelKeySuffix: "verifyWork", fg: "#C47A20", darkFg: "#E0A050" },
  done: { labelKeySuffix: "done", fg: "#1D9E75", darkFg: "#4FD1A0" },
  closed: { labelKeySuffix: "closed", fg: "#888780", darkFg: "#aba29a" },
};

// ---------------------------------------------------------------------------
// Proposal / Task lifecycle vocabulary — LIFTED verbatim from node-tooltip.tsx.
// node-tooltip.tsx now re-imports PROPOSAL_STATUS_COLOR / TASK_STATUS_COLOR /
// STATUS_I18N from here.
// ---------------------------------------------------------------------------
export const PROPOSAL_STATUS_COLOR: Record<string, string> = {
  draft: "bg-[#F5F5F5] text-[#6B6B6B] dark:bg-[#1e1e20] dark:text-[#aba29a]",
  pending: "bg-[#FFF3E0] text-[#E65100] dark:bg-[#3a2a12] dark:text-[#F0A050]",
  approved: "bg-[#E8F5E9] text-[#2E7D32] dark:bg-[#14281a] dark:text-[#5FD07E]",
  rejected: "bg-[#FFEBEE] text-[#C62828] dark:bg-[#331619] dark:text-[#F0897E]",
  revised: "bg-[#F5F5F5] text-[#6B6B6B] dark:bg-[#1e1e20] dark:text-[#aba29a]",
  closed: "bg-[#F5F5F5] text-[#9A9A9A] dark:bg-[#1e1e20] dark:text-[#a8a29a]",
};

export const TASK_STATUS_COLOR: Record<string, string> = {
  open: "bg-[#FFF3E0] text-[#E65100] dark:bg-[#3a2a12] dark:text-[#F0A050]",
  assigned: "bg-[#E3F2FD] text-[#1976D2] dark:bg-[#13253a] dark:text-[#5AA9F0]",
  in_progress: "bg-[#E8F5E9] text-[#5A9E6F] dark:bg-[#14281a] dark:text-[#6FD19A]",
  to_verify: "bg-[#F3E5F5] text-[#7B1FA2] dark:bg-[#281630] dark:text-[#C98FE0]",
  done: "bg-[#E0F2F1] text-[#00796B] dark:bg-[#12292a] dark:text-[#4FD1C0]",
  closed: "bg-[#F5F5F5] text-[#9A9A9A] dark:bg-[#1e1e20] dark:text-[#a8a29a]",
};

// Status raw enum value → `status.*` key suffix (same as node-tooltip's
// STATUS_I18N). idea badgeHint values are NOT in here — they route through
// `ideaTracker.badge.*` (IDEA_BADGE_HINT above).
export const STATUS_I18N: Record<string, string> = {
  open: "open",
  // proposal
  draft: "draft",
  pending: "pendingReview",
  approved: "approved",
  rejected: "rejected",
  revised: "draft", // no dedicated key; matches surface palette
  // task
  assigned: "assigned",
  in_progress: "inProgress",
  to_verify: "toVerify",
  done: "done",
  closed: "closed",
};

// ---------------------------------------------------------------------------
// Document type vocabulary — LIFTED verbatim from node-tooltip.tsx.
// ---------------------------------------------------------------------------
export const DOC_TYPE_COLOR: Record<string, string> = {
  prd: "bg-[#E3F2FD] text-[#1976D2] dark:bg-[#13253a] dark:text-[#5AA9F0]",
  tech_design: "bg-[#F3E5F5] text-[#7B1FA2] dark:bg-[#281630] dark:text-[#C98FE0]",
  adr: "bg-[#FFF8E1] text-[#9A6B00] dark:bg-[#332a12] dark:text-[#E0B44E]",
  spec: "bg-[#E8F5E9] text-[#5A9E6F] dark:bg-[#14281a] dark:text-[#6FD19A]",
  guide: "bg-[#E0F2F1] text-[#00796B] dark:bg-[#12292a] dark:text-[#4FD1C0]",
  report: "bg-[#FFF8E1] text-[#9A6B00] dark:bg-[#332a12] dark:text-[#E0B44E]",
  design: "bg-[#F3E5F5] text-[#7B1FA2] dark:bg-[#281630] dark:text-[#C98FE0]",
  note: "bg-[#FFF3E0] text-[#E65100] dark:bg-[#3a2a12] dark:text-[#F0A050]",
  other: "bg-[#F5F5F5] text-[#6B6B6B] dark:bg-[#1e1e20] dark:text-[#aba29a]",
};

export const DOC_TYPE_I18N: Record<string, string> = {
  prd: "documents.typePrd",
  tech_design: "documents.typeTechDesign",
  adr: "documents.typeAdr",
  spec: "documents.typeSpec",
  guide: "documents.typeGuide",
  report: "documents.typeReport",
  design: "documents.typeDesign",
  note: "documents.typeNote",
  other: "documents.typeOther",
};

// ---------------------------------------------------------------------------
// Sentinel + fallback
// ---------------------------------------------------------------------------

/**
 * Sentinel value the resource-graph service writes for a node whose status
 * could not be derived to a concrete state (e.g. an idea whose
 * `computeDerivedStatus` returned `badgeHint: null`). Keeping the field a
 * `string` keeps the payload self-describing; renderers map this to the
 * neutral fallback below.
 */
export const STATUS_UNKNOWN_SENTINEL = "unknown";

/**
 * Neutral fallback returned by `resolveNodeStatusVisual` for an unmapped or
 * sentinel status — guarantees the canvas/DOM renderers always receive a
 * concrete `{ labelKey, colorClass, bg, fg }` and never crash on a missing key.
 * `graph.status.unknown` is a NEW key, added to both en.json and zh.json.
 */
export const UNKNOWN_FALLBACK: NodeStatusVisual = {
  labelKey: "graph.status.unknown",
  colorClass: "bg-[#F5F5F5] text-[#6B6B6B] dark:bg-[#1e1e20] dark:text-[#aba29a]",
  bg: "#F5F5F5",
  fg: "#6B6B6B",
  darkBg: "#1e1e20",
  darkFg: "#aba29a",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a Tailwind color-class string into its light + dark hex pairs.
 *
 * The class carries up to four arbitrary-value utilities:
 *   `bg-[#..] text-[#..] dark:bg-[#..] dark:text-[#..]`
 * The light pair feeds the light-canvas fill/text; the `dark:`-prefixed pair
 * feeds the dark-canvas fill/text (Canvas 2D can't honor `dark:` itself). A
 * status with no `dark:` variant falls back to its light hex so the canvas
 * still paints a concrete color.
 */
function splitColorClass(colorClass: string): {
  bg: string;
  fg: string;
  darkBg: string;
  darkFg: string;
} {
  // Match `dark:` variants FIRST and strip them, so the bare `bg-`/`text-`
  // regexes below don't accidentally capture the dark hex.
  const darkBgMatch = colorClass.match(/dark:bg-\[(#[0-9A-Fa-f]{3,8})\]/);
  const darkFgMatch = colorClass.match(/dark:text-\[(#[0-9A-Fa-f]{3,8})\]/);
  const lightOnly = colorClass
    .replace(/dark:bg-\[#[0-9A-Fa-f]{3,8}\]/g, "")
    .replace(/dark:text-\[#[0-9A-Fa-f]{3,8}\]/g, "");
  const bgMatch = lightOnly.match(/bg-\[(#[0-9A-Fa-f]{3,8})\]/);
  const fgMatch = lightOnly.match(/text-\[(#[0-9A-Fa-f]{3,8})\]/);
  const bg = bgMatch ? bgMatch[1] : UNKNOWN_FALLBACK.bg;
  const fg = fgMatch ? fgMatch[1] : UNKNOWN_FALLBACK.fg;
  return {
    bg,
    fg,
    darkBg: darkBgMatch ? darkBgMatch[1] : bg,
    darkFg: darkFgMatch ? darkFgMatch[1] : fg,
  };
}

/**
 * Resolve a `(type, statusValue)` pair to a complete visual record.
 * Unknown / sentinel values resolve to `UNKNOWN_FALLBACK` (no crash).
 */
export function resolveNodeStatusVisual(
  type: ResourceGraphNodeType,
  statusValue: string,
): NodeStatusVisual {
  if (!statusValue || statusValue === STATUS_UNKNOWN_SENTINEL) {
    return UNKNOWN_FALLBACK;
  }

  if (type === "idea") {
    const entry = IDEA_BADGE_HINT[statusValue];
    if (!entry) return UNKNOWN_FALLBACK;
    const colorClass =
      `bg-[${IDEA_BADGE_HINT_CHIP_BG}] text-[${entry.fg}] ` +
      `dark:bg-[${IDEA_BADGE_HINT_CHIP_BG_DARK}] dark:text-[${entry.darkFg}]`;
    return {
      labelKey: `ideaTracker.badge.${entry.labelKeySuffix}`,
      colorClass,
      bg: IDEA_BADGE_HINT_CHIP_BG,
      fg: entry.fg,
      darkBg: IDEA_BADGE_HINT_CHIP_BG_DARK,
      darkFg: entry.darkFg,
    };
  }

  if (type === "document") {
    const colorClass = DOC_TYPE_COLOR[statusValue];
    const labelKey = DOC_TYPE_I18N[statusValue];
    if (!colorClass || !labelKey) return UNKNOWN_FALLBACK;
    const { bg, fg, darkBg, darkFg } = splitColorClass(colorClass);
    return { labelKey, colorClass, bg, fg, darkBg, darkFg };
  }

  // proposal | task — raw lifecycle status
  const palette = type === "proposal" ? PROPOSAL_STATUS_COLOR : TASK_STATUS_COLOR;
  const colorClass = palette[statusValue];
  const suffix = STATUS_I18N[statusValue];
  if (!colorClass || !suffix) return UNKNOWN_FALLBACK;
  const { bg, fg, darkBg, darkFg } = splitColorClass(colorClass);
  return { labelKey: `status.${suffix}`, colorClass, bg, fg, darkBg, darkFg };
}

/**
 * Every concrete (i.e. non-fallback) status value the resolver knows, grouped
 * by node type. Exposed for unit testing (canvas↔DOM hex parity assertion).
 * Document type strings are listed under `document`.
 */
export const KNOWN_STATUS_VALUES: Record<ResourceGraphNodeType, string[]> = {
  idea: Object.keys(IDEA_BADGE_HINT),
  proposal: Object.keys(PROPOSAL_STATUS_COLOR),
  task: Object.keys(TASK_STATUS_COLOR),
  document: Object.keys(DOC_TYPE_COLOR),
};
