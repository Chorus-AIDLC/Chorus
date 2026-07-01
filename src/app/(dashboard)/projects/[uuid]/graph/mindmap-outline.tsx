"use client";

// Project Resource Graph — the MOBILE rendering layer (vertical indented
// outline). Tech Design D3.
//
// On a narrow viewport the same tree — same expand state — renders as a DOM
// vertical indented outline instead of the wide horizontal canvas
// (mindmap-canvas.tsx). DOM (not canvas) because an outline is naturally a
// scrolling list and gets accessibility + text selection for free.
//
// This component is a pure consumer of the SAME stable prop contract the canvas
// uses (`nodes`, `links`, `selectedId`, `onNodeClick`). It does NOT own the
// expand/collapse state, the four side panels, the type filter, or the SSE
// live-reconcile — all of that stays in resource-graph.tsx. It only:
//   - derives the pre-order DFS ordering by calling the SAME `computeTreeLayout`
//     the canvas uses (so the indentation depth is identical to the desktop
//     derivation level), and renders one row per visible node;
//   - reuses the type chip + glyph + title and the +/− expand affordance with a
//     child count for hubs (Idea / Proposal);
//   - drives expand + panel-open through the SAME
//     `onNodeClick(id, type, onAffordance)` contract — so toggling on mobile and
//     resizing to desktop preserves expansion (both render from the same state);
//   - applies the agent-presence highlight to rows (view = dashed / mutate =
//     solid) reusing usePresence + getAgentColor, and IDENTIFIES the acting
//     agent with a small colored label (spec MODIFIED presence requirement —
//     "identify the acting agent" in BOTH renderers).
//
// All controls are shadcn/ui `Button`s (no raw <button>/<div>-as-control), per
// the project UI rules. Keyboard activation is native to <button>; the IME
// composition guard does not apply (there is no Enter-submit text input here).

import { useEffect, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import {
  Lightbulb,
  ClipboardList,
  CheckSquare,
  FileText,
  Plus,
  Minus,
  Bot,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePresence } from "@/hooks/use-presence";
import { getAgentColor } from "@/lib/agent-color";
import { computeTreeLayout } from "@/lib/resource-graph-tree-layout";
import type { ResourceGraphNodeType as NodeType } from "@/services/resource-graph.service";
import type { ForceNode, ForceLink } from "./mindmap-canvas";
import { resolveNodeStatusVisual } from "./node-status";

// --- Visual tokens (kept in lockstep with mindmap-canvas.tsx) ---------------

const TYPE_COLOR: Record<NodeType, string> = {
  idea: "#7C4DFF",
  proposal: "#2563EB",
  task: "#E8833A",
  document: "#00897B",
};

// DOM glyphs use the same lucide icons as the desktop filter swatch (the canvas
// paints emoji into the chip; on DOM we use the crisper lucide icon to match the
// rest of the app's chrome).
const TYPE_ICON: Record<NodeType, LucideIcon> = {
  idea: Lightbulb,
  proposal: ClipboardList,
  task: CheckSquare,
  document: FileText,
};

// Horizontal indentation per derivation level (px). Mirrors the desktop tree's
// left → right depth as a top → bottom indented hierarchy.
const INDENT_STEP = 22;

// The reconciled node payload (`ResourceGraphNode`) carries a per-node `status`
// string (idea→derived badgeHint, proposal/task→raw lifecycle status,
// document→Document.type), populated by the resource-graph service. The
// canvas `ForceNode` shape that this outline consumes is structurally
// compatible and gains `status` as the renderer side of the foundation work
// lands. We read it through a local widen so the status pipeline is decoupled
// from the canvas's exported type, and an absent `status` falls through to the
// shared resolver's neutral UNKNOWN_FALLBACK (no crash on a stale payload).
type OutlineForceNode = ForceNode & { status?: string };

interface MindMapOutlineProps {
  nodes: ForceNode[];
  links: ForceLink[];
  /** UUID of the currently-selected node (keeps a highlight while a panel is open). */
  selectedId: string | null;
  /**
   * Click router — IDENTICAL contract to the canvas. `onAffordance` is true when
   * the user activated the expand/collapse control of a hub (→ toggle) rather
   * than the row body (→ open panel).
   */
  onNodeClick: (id: string, type: NodeType, onAffordance: boolean) => void;
  // --- Node search (shared state from the parent resource-graph.tsx) ---------
  // Same shared-search props the canvas receives, so a viewport resize preserves
  // the query/matches/cursor (both renderers read the same parent state). The
  // outline's visual consumption (row highlight/dim, current-match accent,
  // scroll-into-view) is a sibling task; these are OPTIONAL so the plumbing can
  // land first. Absent = "no active search".
  /** Match set when searching (highlight matches / dim the rest); null/absent = not searching. */
  matchIds?: ReadonlySet<string> | null;
  /** The current-match cursor id (distinct accent; scrolled into view). */
  currentMatchId?: string | null;
}

export function MindMapOutline({
  nodes,
  links,
  selectedId,
  onNodeClick,
  matchIds = null,
  currentMatchId = null,
}: MindMapOutlineProps) {
  const t = useTranslations();
  const { getPresence } = usePresence();

  const nodeById = useMemo(() => {
    const m = new Map<string, ForceNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  // Pre-order DFS ordering with per-node depth — the SAME layout the canvas
  // consumes, so a node's outline indentation depth equals its desktop
  // derivation level (and the two views stay in sync across a resize).
  const outline = useMemo(
    () => computeTreeLayout(nodes, links).outline,
    [nodes, links],
  );

  // Search dim is active only for a NON-empty match set (Q2=a: an empty result
  // must NOT dim the whole tree, and a null match set means "not searching").
  // This mirrors the canvas's `resolveFocusAlpha` rule-2/rule-3 boundary.
  const searchDimActive = matchIds != null && matchIds.size > 0;

  // Per-row DOM refs (keyed by node id) so the scroll-into-view effect can bring
  // the current match into view — the outline's analog of the canvas camera
  // centering. Rebuilt each render from the live row set; stale ids are pruned
  // implicitly because we only set refs for rendered rows.
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  // Scroll the current match into view (block:center) when it changes (D5).
  // Keyed on currentMatchId so stepping prev/next re-scrolls; guarded so a
  // not-searching / no-current state does nothing.
  useEffect(() => {
    if (!currentMatchId) return;
    const el = rowRefs.current.get(currentMatchId);
    // Guard the call itself (not just `el`): some environments — jsdom, certain
    // SSR/test runtimes — don't implement scrollIntoView on the element.
    if (typeof el?.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center" });
    }
  }, [currentMatchId]);

  return (
    <div
      className="absolute inset-0 overflow-y-auto overflow-x-hidden bg-[#FAF8F4] px-2 py-2"
      data-testid="mindmap-outline"
    >
      <ul className="flex flex-col gap-1.5">
        {outline.map((entry) => {
          const node = nodeById.get(entry.id);
          if (!node) return null;
          // Match-highlight / non-match-dim treatment (the outline had none).
          // When a search is active with hits: matching rows stay opaque, the
          // rest dim. No active search (or zero hits) → no dim.
          const isMatch = matchIds?.has(node.id) ?? false;
          const dimmed = searchDimActive && !isMatch;
          const isCurrentMatch =
            currentMatchId != null && node.id === currentMatchId;
          return (
            <OutlineRow
              key={entry.id}
              rowRef={(el) => {
                if (el) rowRefs.current.set(node.id, el);
                else rowRefs.current.delete(node.id);
              }}
              node={node as OutlineForceNode}
              depth={entry.depth}
              selected={node.id === selectedId}
              dimmed={dimmed}
              isCurrentMatch={isCurrentMatch}
              presence={getPresence(node.type, node.id)}
              onNodeClick={onNodeClick}
              t={t}
            />
          );
        })}
      </ul>
    </div>
  );
}

// --- Row --------------------------------------------------------------------

interface OutlineRowProps {
  node: OutlineForceNode;
  depth: number;
  selected: boolean;
  /** True when a search is active (with hits) and this row is NOT a match. */
  dimmed: boolean;
  /** True when this row is the prev/next current-match cursor. */
  isCurrentMatch: boolean;
  /** Per-row ref callback so the parent can scroll the current match into view. */
  rowRef: (el: HTMLLIElement | null) => void;
  presence: ReturnType<ReturnType<typeof usePresence>["getPresence"]>;
  onNodeClick: (id: string, type: NodeType, onAffordance: boolean) => void;
  t: ReturnType<typeof useTranslations>;
}

// Current-match accent — kept in lockstep with the canvas current-match ring
// (mindmap-canvas.tsx CURRENT_MATCH_RING_COLOR). A saturated pink, distinct from
// the selection border (the node's type color) and from a plain match (no ring).
const CURRENT_MATCH_RING_COLOR = "#EC4899";

function OutlineRow({
  node,
  depth,
  selected,
  dimmed,
  isCurrentMatch,
  rowRef,
  presence,
  onNodeClick,
  t,
}: OutlineRowProps) {
  const color = TYPE_COLOR[node.type];
  const Icon = TYPE_ICON[node.type];

  // Status badge — resolved through the SHARED `node-status.ts` resolver so
  // the outline's pill is color-identical to the canvas's status pill on the
  // card eyebrow (canvas paints raw hex via Path2D; we mount a shadcn <Badge>
  // with the matching `bg-[#..] text-[#..]` Tailwind pair). An unmapped value
  // resolves to UNKNOWN_FALLBACK so the badge renders safely.
  const statusVisual = resolveNodeStatusVisual(node.type, node.status ?? "");

  // Presence highlight: mutate (solid) takes precedence over view (dashed),
  // mirroring the canvas + PresenceIndicator convention. The primary agent
  // drives the outline color AND is named in a small pill (identify the acting
  // agent — spec MODIFIED presence requirement, BOTH renderers).
  const mutating = presence.find((p) => p.action === "mutate");
  const primary = mutating ?? presence[presence.length - 1] ?? null;
  const presenceColor = primary ? getAgentColor(primary.agentName) : null;

  const collapsed = !node.expanded;
  const count = node.childCount ?? 0;

  const rowStyle: React.CSSProperties = {
    marginLeft: depth * INDENT_STEP,
  };
  // Presence highlight wins the row OUTLINE channel (it signals a live agent and
  // is rarer/more urgent than the search cursor); the current-match cursor uses
  // a RING (box-shadow) channel instead, so the two never fight for the same
  // CSS property and can co-exist on one row.
  if (presenceColor) {
    rowStyle.outline = `2px ${mutating ? "solid" : "dashed"} ${presenceColor}`;
    rowStyle.outlineOffset = "-2px";
  }
  if (isCurrentMatch) {
    // A distinct accent ring on the current match — separate from the `selected`
    // border (type color) and from a plain match (no ring). Drawn as a 2px
    // box-shadow ring so it layers over the card border without shifting layout.
    rowStyle.boxShadow = `0 0 0 2px ${CURRENT_MATCH_RING_COLOR}`;
    rowStyle.borderRadius = 10;
  }

  return (
    <li
      ref={rowRef}
      style={rowStyle}
      className={cn(
        "relative transition-opacity",
        // Non-match dim while a search is active (the outline had no dim before).
        dimmed && "opacity-40",
      )}
      data-match={isCurrentMatch ? "current" : undefined}
      data-dimmed={dimmed ? "true" : undefined}
    >
      <div
        className={cn(
          "flex items-center gap-1 rounded-[10px] border bg-white pr-1",
          selected ? "border-2" : "border-[#EAE4DB]",
        )}
        style={selected ? { borderColor: color } : undefined}
      >
        {/* Row body — opens the side panel (onAffordance=false). The whole
            chip+title region is one accessible button. */}
        <Button
          type="button"
          variant="ghost"
          onClick={() => onNodeClick(node.id, node.type, false)}
          className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-[10px] px-1.5 py-1.5 text-left hover:bg-[#FAF8F4]"
        >
          <span
            className="flex size-7 shrink-0 items-center justify-center rounded-[9px] text-white"
            style={{ backgroundColor: color }}
            aria-hidden="true"
          >
            <Icon className="size-4" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span
              className="text-[9px] font-semibold uppercase leading-none tracking-wider"
              style={{ color }}
            >
              {t(`graph.nodeType.${node.type}` as const)}
            </span>
            <span className="truncate text-[13px] font-medium leading-tight text-[#2C2C2C]">
              {node.title}
            </span>
          </span>
        </Button>

        {/* Status badge — sits AFTER the title block (so the title gets the
            flex space and truncates first) and BEFORE the presence pill +
            expand affordance. `shrink-0` keeps the badge intact on a narrow
            viewport; the title region above is `min-w-0 flex-1` so it absorbs
            the squeeze instead. */}
        <Badge
          data-testid="outline-status-badge"
          className={cn(
            "shrink-0 max-w-[110px] truncate px-1.5 py-0 text-[10px] font-medium",
            statusVisual.colorClass,
          )}
        >
          {t(statusVisual.labelKey)}
        </Badge>

        {/* Acting-agent label — names who is operating on this entity. */}
        {primary && presenceColor && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium text-white"
            style={{ backgroundColor: presenceColor }}
            data-testid="outline-presence-agent"
          >
            <Bot className="size-2.5" aria-hidden="true" />
            <span className="max-w-[80px] truncate">{primary.agentName}</span>
          </span>
        )}

        {/* Expand/collapse affordance — hubs (Idea / Proposal with children)
            only. Activating it toggles the subtree (onAffordance=true) via the
            SAME contract the canvas uses, operating on the SAME shared expand
            state in resource-graph.tsx. */}
        {node.hasAffordance && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onNodeClick(node.id, node.type, true)}
            aria-label={
              collapsed
                ? t("graph.outline.expand", { count })
                : t("graph.outline.collapse")
            }
            aria-expanded={!collapsed}
            className="shrink-0 gap-0.5 rounded-md px-1.5 text-[10px] font-semibold tabular-nums"
            style={{ color }}
          >
            {collapsed ? (
              <Plus className="size-3" aria-hidden="true" />
            ) : (
              <Minus className="size-3" aria-hidden="true" />
            )}
            {collapsed && count > 0 ? count : null}
          </Button>
        )}
      </div>
    </li>
  );
}
