"use client";

// Resource-graph hover tooltip overlay (desktop). Tech Design D1/D4.
//
// A DOM element absolutely positioned over the canvas container — NOT painted
// into the canvas (rich text + a styled badge + a11y are trivial in DOM and
// impractical in Canvas 2D). It previews the one thing the node card can't
// already show: the entity's FULL (untruncated) title + a single badge —
// lifecycle STATUS for idea/proposal/task, or document TYPE for a Document
// (which has no status).
//
// Badge styling/colors and i18n labels are REUSED verbatim from the existing
// per-entity surfaces (tasks kanban-board, proposals proposal-kanban, ideas
// idea-detail-panel, documents doc-type-config) — the tooltip must read the
// same as the rest of the app. The status sets are derived from the real
// Prisma enums (Idea: open|elaborating|elaborated; Proposal: draft|pending|
// approved|rejected|revised; Task: open|assigned|in_progress|to_verify|done|
// closed), NOT the design doc's (intentionally incomplete) enumeration.
//
// The data ({ status?, docType? }) is supplied by useNodeDetail (debounced +
// cached fetch-on-hover). While `loading`, the title is shown with a small
// spinner in place of the badge. The root carries `pointer-events-none` so it
// never intercepts a click meant for the canvas, and renders nothing when there
// is no hovered node.

import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { NodeDetail, NodeType } from "./use-node-detail";

// --- Status → badge color (verbatim from the existing per-entity surfaces) ---
//
// Each entry copies the surface's own inline `statusColors` map so the tooltip
// badge matches that surface exactly. Where a real enum value isn't colored by
// its surface (proposal `rejected`/`revised`), we reuse the shared palette
// already used elsewhere for the same semantics (rejected → destructive red of
// status.rejected; revised → the neutral draft chip).
const IDEA_STATUS_COLOR: Record<string, string> = {
  open: "bg-[#FFF3E0] text-[#E65100]",
  elaborating: "bg-[#E3F2FD] text-[#1976D2]",
  elaborated: "bg-[#E0F2F1] text-[#00796B]",
};

const PROPOSAL_STATUS_COLOR: Record<string, string> = {
  draft: "bg-[#F5F5F5] text-[#6B6B6B]",
  pending: "bg-[#FFF3E0] text-[#E65100]",
  approved: "bg-[#E8F5E9] text-[#2E7D32]",
  rejected: "bg-[#FFEBEE] text-[#C62828]",
  revised: "bg-[#F5F5F5] text-[#6B6B6B]",
  closed: "bg-[#F5F5F5] text-[#9A9A9A]",
};

const TASK_STATUS_COLOR: Record<string, string> = {
  open: "bg-[#FFF3E0] text-[#E65100]",
  assigned: "bg-[#E3F2FD] text-[#1976D2]",
  in_progress: "bg-[#E8F5E9] text-[#5A9E6F]",
  to_verify: "bg-[#F3E5F5] text-[#7B1FA2]",
  done: "bg-[#E0F2F1] text-[#00796B]",
  closed: "bg-[#F5F5F5] text-[#9A9A9A]",
};

// --- Status → i18n label key suffix (reuses the existing `status.*` keys) -----
//
// The surfaces map a raw status to a `status.<suffix>` key (camelCased where the
// enum is snake_cased). We mirror that so we reuse the keys already present in
// both locales rather than adding new ones.
const STATUS_I18N: Record<string, string> = {
  open: "open",
  // idea
  elaborating: "elaborating",
  elaborated: "elaborated",
  // proposal
  draft: "draft",
  pending: "pendingReview",
  approved: "approved",
  rejected: "rejected",
  revised: "draft", // no dedicated key; surfaces don't color it either
  // task
  assigned: "assigned",
  in_progress: "inProgress",
  to_verify: "toVerify",
  done: "done",
  closed: "closed",
};

// --- Document type → badge color + label key ---------------------------------
//
// doc-type-config.ts only configures prd/spec/design/note/report/other, but the
// real Document.type enum (and the graph) also include tech_design/adr/guide.
// The `documents.type*` i18n keys for ALL of these already exist in both
// locales, so we map every value here (colors reuse the doc-type palette).
const DOC_TYPE_COLOR: Record<string, string> = {
  prd: "bg-[#E3F2FD] text-[#1976D2]",
  tech_design: "bg-[#F3E5F5] text-[#7B1FA2]",
  adr: "bg-[#FFF8E1] text-[#9A6B00]",
  spec: "bg-[#E8F5E9] text-[#5A9E6F]",
  guide: "bg-[#E0F2F1] text-[#00796B]",
  report: "bg-[#FFF8E1] text-[#9A6B00]",
  design: "bg-[#F3E5F5] text-[#7B1FA2]",
  note: "bg-[#FFF3E0] text-[#E65100]",
  other: "bg-[#F5F5F5] text-[#6B6B6B]",
};

const DOC_TYPE_I18N: Record<string, string> = {
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

const STATUS_COLOR_BY_TYPE: Record<NodeType, Record<string, string>> = {
  idea: IDEA_STATUS_COLOR,
  proposal: PROPOSAL_STATUS_COLOR,
  task: TASK_STATUS_COLOR,
  document: {}, // documents use DOC_TYPE_COLOR, not a status map
};

const NEUTRAL_COLOR = "bg-[#F5F5F5] text-[#6B6B6B]";

export interface NodeTooltipProps {
  /** The hovered node's full (untruncated) title — already known from the node payload. */
  title: string;
  /** The hovered node's entity type. */
  type: NodeType;
  /** Resolved detail (status / docType) from useNodeDetail; null while loading or unresolved. */
  detail: NodeDetail | null;
  /** True while the per-entity detail fetch is in flight (show a spinner for the badge). */
  loading: boolean;
  /** Absolute screen position of the tooltip's top-left, in container pixels. */
  x: number;
  y: number;
}

// Resolve the badge's { color, label } for a node type + its detail. Returns
// null when there is nothing to show yet (no detail → caller renders a spinner).
function resolveBadge(
  type: NodeType,
  detail: NodeDetail | null,
  t: ReturnType<typeof useTranslations>,
): { color: string; label: string } | null {
  if (!detail) return null;
  if (type === "document") {
    const value = detail.docType;
    if (!value) return null;
    const color = DOC_TYPE_COLOR[value] ?? NEUTRAL_COLOR;
    const key = DOC_TYPE_I18N[value];
    return { color, label: key ? t(key) : value };
  }
  const value = detail.status;
  if (!value) return null;
  const color = STATUS_COLOR_BY_TYPE[type][value] ?? NEUTRAL_COLOR;
  const suffix = STATUS_I18N[value];
  return { color, label: suffix ? t(`status.${suffix}`) : value };
}

export function NodeTooltip({
  title,
  type,
  detail,
  loading,
  x,
  y,
}: NodeTooltipProps) {
  const t = useTranslations();
  const badge = resolveBadge(type, detail, t);

  return (
    <div
      data-testid="node-tooltip"
      role="tooltip"
      // pointer-events-none: the tooltip never intercepts a click meant for the
      // canvas, and never blocks moving the pointer onto an adjacent node.
      className="pointer-events-none absolute z-20 max-w-[260px] rounded-lg border border-[#EAE4DB] bg-white px-3 py-2 shadow-lg"
      style={{ left: x, top: y }}
    >
      <p className="text-sm font-medium leading-snug text-[#2C2C2C]">{title}</p>
      <div className="mt-1.5 flex items-center">
        {badge ? (
          <Badge className={badge.color}>{badge.label}</Badge>
        ) : loading ? (
          // While the detail fetch is in flight (or hasn't resolved yet) show a
          // small spinner in place of the badge; the title (already known from
          // the node payload) stays visible above it.
          <span
            data-testid="node-tooltip-loading"
            className="inline-flex items-center gap-1 text-xs text-[#9A9A9A]"
          >
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            {t("graph.tooltip.loading")}
          </span>
        ) : (
          // Resolved with no badge to show (e.g. an unknown/failed detail): keep
          // the slot empty rather than implying a perpetual "loading" state.
          <span data-testid="node-tooltip-no-badge" className="sr-only">
            {/* no badge */}
          </span>
        )}
      </div>
    </div>
  );
}
