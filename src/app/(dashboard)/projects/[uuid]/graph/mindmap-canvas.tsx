"use client";

// Project Resource Graph — the *rendering* layer (deterministic mind-map tree).
//
// This is the wave-2 replacement for the force-directed canvas. The data is a
// rooted FOREST (root Ideas → Proposals → Tasks/Documents, plus Idea→Idea
// lineage), so instead of a physics simulation we lay it out deterministically
// with `computeTreeLayout` (d3-hierarchy, in `@/lib/resource-graph-tree-layout`)
// and tween nodes to their exact coordinates. No d3-force, no reheat — that is
// the whole point ("不跳动").
//
// What this layer owns (purely visual):
//   - the deterministic horizontal tree layout (left → right; depth = derivation
//     level; multiple root Ideas stack vertically), with manual pan/zoom.
//   - a coordinate TWEEN: on every new layout, surviving nodes glide old→new
//     over ~300ms ease-out; new nodes fade/scale in at their target; removed
//     nodes fade out. (Tech Design D2.)
//   - custom node painting (ported from the old force canvas): rounded card,
//     type-colored chip + glyph, eyebrow type label, truncated title, +/−
//     expand button with child count, selection ring, and the agent-presence
//     ring (view = dashed / mutate = solid) reusing usePresence + getAgentColor.
//   - SOLID directional elbow/bezier connectors for `derive`/`lineage` (toward
//     the derived node); a DASHED low-opacity overlay for `depends` and
//     multi-source proposal links that does NOT affect layout, raised to full
//     opacity only when an endpoint is in the hovered/selected node's family.
//   - hover/selection family-focus: the connected component of the focused node
//     (over solid tree edges) stays opaque; everyone else dims.
//
// What it does NOT own (delegated up to ResourceGraph): data fetching, the
// expand/collapse visible-set, the four side panels, the type filter, and the
// SSE live-reconcile. It receives ready-to-render nodes/links + callbacks.
//
// SSR: this file is imported by the parent (resource-graph.tsx) via next/dynamic
// with ssr:false (it touches the DOM canvas + ResizeObserver). The prop contract
// (`nodes`, `links`, `selectedId`, `onNodeClick`) and the re-exported
// `ForceNode`/`ForceLink` type names are preserved from the force era so no
// other import breaks (Tech Design D5).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Minus, Maximize } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePresence } from "@/hooks/use-presence";
import { getAgentColor } from "@/lib/agent-color";
import {
  computeTreeLayout,
  type TreeLayoutNode,
  type TreeLayoutLink,
} from "@/lib/resource-graph-tree-layout";
import type {
  ResourceGraphNodeType as NodeType,
  ResourceGraphEdgeKind as EdgeKind,
} from "@/services/resource-graph.service";
import {
  resolveNodeStatusVisual,
  type NodeStatusVisual,
} from "./node-status";
import { NodeTooltip } from "./node-tooltip";

// --- Public data shapes (Tech Design D5) ------------------------------------
//
// Preserved historical names. They alias the layout module's input types so
// `resource-graph.tsx` and the live-update test keep importing
// `{ ForceNode, ForceLink } from "./mindmap-canvas"` unchanged.
//
// `status` is the per-node string consumed by the shared `node-status.ts`
// resolver (Tech Design D1) — added here so both the canvas painter and the
// outline row (which also imports `ForceNode` from this module) see the same
// shape with one extra field. The status semantics per node type are owned by
// `resource-graph.service.ts`; this layer is purely a presentation pass-through.
export type ForceNode = TreeLayoutNode & {
  /** Per-node status string (idea badgeHint / proposal status / task status / document type). */
  status?: string;
};
export type ForceLink = TreeLayoutLink;

interface MindMapCanvasProps {
  nodes: ForceNode[];
  links: ForceLink[];
  /** UUID of the currently-selected node (keeps a ring while a panel is open). */
  selectedId: string | null;
  /**
   * Click router. `onAffordance` is true when the pointer landed on the
   * expand/collapse region of a hub (→ toggle) rather than the card body
   * (→ open panel).
   */
  onNodeClick: (id: string, type: NodeType, onAffordance: boolean) => void;
  // --- Node search (search state lives in the parent resource-graph.tsx) -----
  // These are the shared-search props both renderers receive. The parent owns
  // the search query, match set, and current-match cursor; this canvas consumes
  // them for highlight/dim, the current-match ring, and camera centering. They
  // are OPTIONAL so the prop plumbing can land before the canvas's visual
  // consumption (that is a sibling task); an absent prop = "no active search".
  /** Match set when searching: full opacity for matches, dim for the rest;
   *  `null`/absent = not searching (no dim). */
  matchIds?: ReadonlySet<string> | null;
  /** The current-match cursor id (distinct ring; does NOT drive focusLineage). */
  currentMatchId?: string | null;
  /** Center-camera signal: when this id changes, center the camera on it. */
  centerNodeId?: string | null;
}

// --- Visual tokens (design.pen "Chorus - Project Graph View") ---------------

const TYPE_COLOR: Record<NodeType, string> = {
  idea: "#7C4DFF",
  proposal: "#2563EB",
  task: "#E8833A",
  document: "#00897B",
};

// Dark-mode type hues. The four brand colors are painted as a SATURATED CHIP
// FILL (with a white icon on top) AND as the eyebrow type-label text + selection
// ring, all from the same `color`. On the charcoal surface the light hues read
// heavy/muddy — especially the document teal `#00897B` (~27% L, nearly a dark
// hole) and the proposal blue — so each is lifted in lightness while keeping its
// hue. Resolved live at paint time via `.dark` on <html> (same convention as
// resolveSurface / resolveStatusPill; the MutationObserver repaints on flip).
const TYPE_COLOR_DARK: Record<NodeType, string> = {
  idea: "#9B82FF", // violet, lifted
  proposal: "#5A8DEF", // blue, lifted off the muddy #2563EB
  task: "#F0964E", // amber, slightly lifted
  document: "#1CA695", // teal, substantially lifted off the near-black #00897B
};

// Lucide icon geometry per type, matching the lucide-react components the rest
// of the app uses for these entity types (Lightbulb / ClipboardList /
// SquareCheckBig / FileText — see the filter swatches in resource-graph.tsx).
// Canvas 2D can't mount React components, so we stroke the icons' raw SVG path
// data (extracted verbatim from lucide-react@0.563, 24×24 viewBox, stroke-based)
// via Path2D — a faithful vector render, not an emoji. Each entry is the list
// of sub-path `d` strings that make up the glyph.
const TYPE_ICON_PATHS: Record<NodeType, string[]> = {
  // Lightbulb
  idea: [
    "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5",
    "M9 18h6",
    "M10 22h4",
  ],
  // ClipboardList (the top rect is expressed as a rounded-rect path)
  proposal: [
    "M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z",
    "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2",
    "M12 11h4",
    "M12 16h4",
    "M8 11h.01",
    "M8 16h.01",
  ],
  // SquareCheckBig
  task: [
    "M21 10.656V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.344",
    "m9 11 3 3L22 4",
  ],
  // FileText
  document: [
    "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
    "M14 2v5a1 1 0 0 0 1 1h5",
    "M10 9H8",
    "M16 13H8",
    "M16 17H8",
  ],
};

const EDGE_COLOR: Record<EdgeKind, string> = {
  derive: "#CFC6B6",
  lineage: "#7C4DFF",
  depends: "#E8833A",
};

// The single dim alpha shared by the hover lineage-focus AND the search
// non-match dim (Tech Design D4 — "reuse the same dim alpha for visual
// consistency"). One constant so both code paths can never drift apart.
const DIM_ALPHA = 0.18;

// Current-match ring color (Tech Design D5). Deliberately NOT any of the four
// type colors (violet/blue/amber/teal) and NOT the selection ring (which uses
// the node's own type color) — a saturated pink reads as the search cursor and
// can't be confused with either.
const CURRENT_MATCH_RING_COLOR = "#EC4899";

/**
 * Per-node opacity multiplier, composing the hover/selection lineage focus with
 * the search match set in priority order (Tech Design D4 / Q3=a). Pure +
 * exported so the precedence is unit-testable without a canvas:
 *
 *   1. A hover/selection lineage is active (`focusLineage` non-null) → dim by
 *      lineage exactly as before: in-lineage 1.0, else DIM_ALPHA. Hover TAKES
 *      OVER — the match set gets no say in this state.
 *   2. Else an active, NON-EMPTY search match set → match 1.0, non-match
 *      DIM_ALPHA.
 *   3. Else (nothing focused; not searching; OR an empty match set) → 1.0 for
 *      everyone. An empty match set must NOT dim the whole tree (Q2=a).
 *
 * Note `currentMatchId` is intentionally NOT a parameter: the current-match
 * cursor drives only the ring + camera, never the dim, and never lineage.
 */
export function resolveFocusAlpha(
  nodeId: string,
  focusLineage: ReadonlySet<string> | null,
  matchIds: ReadonlySet<string> | null,
): number {
  if (focusLineage) return focusLineage.has(nodeId) ? 1 : DIM_ALPHA;
  if (matchIds && matchIds.size > 0) {
    return matchIds.has(nodeId) ? 1 : DIM_ALPHA;
  }
  return 1;
}

/**
 * The view transform that centers `pos` (a node's settled graph-space center)
 * in a viewport of `dims`, KEEPING the current `scale` (Tech Design D5 — center
 * without refitting). Same centering math `fitToView` uses; pure + exported so
 * the camera move is unit-testable without a canvas.
 */
export function centerTransformFor(
  pos: { x: number; y: number },
  dims: { width: number; height: number },
  scale: number,
): ViewTransform {
  return {
    scale,
    tx: dims.width / 2 - pos.x * scale,
    ty: dims.height / 2 - pos.y * scale,
  };
}

// Zoom bounds — shared by the wheel, pinch, and double-tap paths so all three
// clamp scale identically (Tech Design D1/D3).
const SCALE_MIN = 0.2;
const SCALE_MAX = 2.5;

// --- Wheel zoom tuning ------------------------------------------------------
//
// The `/graph` canvas ALWAYS zooms on wheel (idea 9d326265, elaboration round 3
// — "protect mouse-wheel zoom"): a plain mouse wheel zooms at any speed, a
// trackpad pinch (delivered by the browser as a ctrl+wheel with fine pixel
// deltas) zooms, and panning is via drag — the wheel never pans. No device
// inference. A ctrlKey wheel (pinch / Ctrl-⌘) uses the finer pinch sensitivity;
// a plain notch uses the mouse-notch feel.
const ZOOM_WHEEL_SENSITIVITY = 0.0015; // mouse-notch zoom feel
const ZOOM_PINCH_SENSITIVITY = 0.01; // pinch/ctrl+wheel deltas are fine pixels — a larger factor keeps them responsive without over-zooming

// The fixed multiplier the on-screen +/- zoom buttons step by (Tech Design D2).
const ZOOM_BUTTON_STEP = 1.3;

// Double-tap disambiguation window (Tech Design D2). A second tap within this
// time AND distance of the first is a double-tap (zoom), not a node click.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST = 30; // screen px between the two taps
const DOUBLE_TAP_ZOOM_FACTOR = 2; // zoom-in target = fit scale × this (clamped)

/**
 * The view transform for a two-finger pinch (Tech Design D1, Q2=a). Given the
 * gesture START (screen-space midpoint of the two fingers, their distance, and
 * the view transform at gesture start) plus the LIVE midpoint + distance,
 * returns the new transform. Scale is `startScale × liveDist/startDist` clamped
 * to [SCALE_MIN, SCALE_MAX]; the graph point that was under the START midpoint
 * is pinned under the LIVE midpoint, so the tree both scales AND pans to follow
 * the fingers (map-like feel). Pure + exported so the math is unit-testable
 * without a canvas (mirrors centerTransformFor).
 */
export function pinchTransform(
  start: {
    midpoint: { x: number; y: number };
    dist: number;
    view: ViewTransform;
  },
  live: { midpoint: { x: number; y: number }; dist: number },
): ViewTransform {
  const nextScale = Math.min(
    SCALE_MAX,
    Math.max(SCALE_MIN, start.view.scale * (live.dist / start.dist)),
  );
  // Graph point under the START midpoint — kept under the LIVE midpoint so the
  // pan-follow is folded into the anchor math (no separate translation term).
  const gx = (start.midpoint.x - start.view.tx) / start.view.scale;
  const gy = (start.midpoint.y - start.view.ty) / start.view.scale;
  return {
    scale: nextScale,
    tx: live.midpoint.x - gx * nextScale,
    ty: live.midpoint.y - gy * nextScale,
  };
}

// Canvas paint geometry (graph-space units; the view transform scales them).
const CARD_W = 200;
const CARD_H = 46;
const CARD_R = 12;
const CHIP = 30;
// The expand/collapse control occupies the right BTN_W strip of the card —
// a big, easy-to-hit target. The click hit-test uses the same value.
const BTN_W = 40;

const TWEEN_MS = 300; // coordinate tween + fade duration (Tech Design D2)

// Canvas 2D fills can't read CSS custom properties, so the theme-dependent
// SURFACE colors (page bg, card fill/border/divider, title text) are resolved
// per-frame from the `.dark` class on <html> — the same convention the rest of
// the app uses (see useDarkClass in markdown-content.tsx). Node/edge CATEGORY
// colors (TYPE_COLOR / EDGE_COLOR) are theme-invariant brand hues and stay as-is.
interface SurfacePalette {
  bg: string;
  cardFill: string;
  cardBorder: string;
  divider: string;
  title: string;
}
const SURFACE_LIGHT: SurfacePalette = {
  bg: "#FAF8F4",
  cardFill: "#FFFFFF",
  cardBorder: "#EAE4DB",
  divider: "#EFEAE2",
  title: "#2C2C2C",
};
const SURFACE_DARK: SurfacePalette = {
  // Warm-charcoal palette matching globals.css `.dark` (hue 24°, off pure black).
  bg: "#211e1c", // --background (24 9% 12%)
  cardFill: "#29231f", // --card (24 8% 15%) — elevated surface
  cardBorder: "#40392f", // --border (24 7% 25%) — warm hairline
  divider: "#332e29", // --secondary (24 7% 20%)
  title: "#f0ebe4", // --foreground (30 20% 92%) — warm off-white
};
function resolveSurface(): SurfacePalette {
  if (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  ) {
    return SURFACE_DARK;
  }
  return SURFACE_LIGHT;
}

// Hover-tooltip anchor geometry (screen pixels). The tooltip is anchored beside
// the hovered card (Tech Design D2): preferred to the card's right edge with a
// small gap, vertically centered; flipped to the left / clamped inside the
// container on overflow. These are coarse layout estimates of the DOM tooltip's
// box (its real size varies with the title) used only to choose a side and to
// clamp — the tooltip itself is `max-w-[260px]`.
const TOOLTIP_GAP = 12; // px gap between the card edge and the tooltip
const TOOLTIP_EST_W = 260; // matches the tooltip's max width (for flip/clamp)
const TOOLTIP_EST_H = 64; // approximate height (title + badge row)
const TOOLTIP_MARGIN = 8; // keep this far from the container edges when clamping

// --- Tween bookkeeping ------------------------------------------------------
//
// One animation record per visible node. `from`/`to` are graph-space target
// coordinates (card CENTERS). `phase` distinguishes a survivor glide (move),
// an entering node (fade/scale in), and a leaving node (fade out, then GC'd).
interface NodeAnim {
  from: { x: number; y: number };
  to: { x: number; y: number };
  // 0 → start of the current transition, 1 → settled.
  start: number;
  enter: boolean; // true while fading/scaling in
  exit: boolean; // true while fading out (node no longer in input set)
  node: ForceNode; // last-known node payload (kept alive during exit)
}

// View transform: graph → screen is `screenX = x * scale + tx`.
interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);

export function MindMapCanvas({
  nodes,
  links,
  selectedId,
  onNodeClick,
  matchIds = null,
  currentMatchId = null,
  centerNodeId = null,
}: MindMapCanvasProps) {
  const { getPresence } = usePresence();
  const t = useTranslations();

  // Localized type-eyebrow labels (e.g. zh 想法/提案/任务/文档). The painter is a
  // plain function and can't call the t() hook, so resolve the four labels here
  // and pass them down — the canvas eyebrow uses the `graph.nodeType.${type}`
  // i18n keys.
  const typeLabels = useMemo<Record<NodeType, string>>(
    () => ({
      idea: t("graph.nodeType.idea"),
      proposal: t("graph.nodeType.proposal"),
      task: t("graph.nodeType.task"),
      document: t("graph.nodeType.document"),
    }),
    [t],
  );

  // Per-node status pill resolver. The painter is pure (cannot call t()) so it
  // receives a `(node) → { bg, fg, label } | null` resolver instead. Resolution
  // routes through the shared `node-status.ts` module for one source of truth on
  // the label key + color pair (Tech Design D1/D2). A node with an unmapped or
  // sentinel status resolves to `UNKNOWN_FALLBACK`; we still
  // paint the pill (so users see a neutral chip rather than a hole) using its
  // translated `graph.status.unknown` label.
  const resolveStatusPill = useCallback(
    (node: ForceNode): { bg: string; fg: string; label: string } | null => {
      if (!node.status) return null;
      const visual: NodeStatusVisual = resolveNodeStatusVisual(
        node.type,
        node.status,
      );
      // Canvas 2D can't honor `dark:` classes, so pick the dark hex pair when
      // <html> carries `.dark` — resolved live at paint time, the same way
      // resolveSurface() reads the class (the MutationObserver repaints on flip).
      const dark =
        typeof document !== "undefined" &&
        document.documentElement.classList.contains("dark");
      return {
        bg: dark ? visual.darkBg : visual.bg,
        fg: dark ? visual.darkFg : visual.fg,
        label: t(visual.labelKey),
      };
    },
    [t],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState({ width: 800, height: 600 });

  const [hoverId, setHoverId] = useState<string | null>(null);

  // --- Hover tooltip (Tech Design D3) ---------------------------------------
  // Title-only overlay: the hovered node's FULL untruncated title (the one
  // thing the card can't show after its own truncation). No per-entity fetch,
  // no badge — status now lives on the card itself (the eyebrow-row pill). The
  // anchor is a screen-pixel position recomputed from the live rendered center
  // + the view transform on each paint while a node is hovered (see
  // renderFrame). Stored as state so the DOM tooltip re-renders as the
  // camera/card moves. This is purely additive — it does NOT touch hoverId-
  // driven focusLineage below.
  const [tooltipAnchor, setTooltipAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // Mirror of tooltipAnchor read inside the rAF painter — lets the painter clear
  // a stale anchor without listing tooltipAnchor as a renderFrame dependency
  // (which would rebuild the painter every time the anchor nudges).
  const tooltipAnchorRef = useRef(tooltipAnchor);
  tooltipAnchorRef.current = tooltipAnchor;

  // --- Deterministic layout (Tech Design D1) --------------------------------
  // Pure: identical visible node/link sets + expand state → identical coords.
  const layout = useMemo(
    () => computeTreeLayout(nodes, links),
    [nodes, links],
  );

  const nodeById = useMemo(() => {
    const m = new Map<string, ForceNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  // The hovered node drives the title-only tooltip overlay (Tech Design D3).
  // The title is already in the node payload, so no per-entity fetch is needed.
  const hoveredNode = hoverId ? nodeById.get(hoverId) ?? null : null;

  // --- Directed tree-spine maps -------------------------------------------
  // The layout resolves exactly one tree-spine parent per non-root node (idea
  // → parent idea via lineage; proposal/document → owner; task → its first
  // visible `depends` prerequisite, else its proposal). We reuse THAT map as
  // the single source of truth — both for "is this link a solid spine edge?"
  // (see isSpineEdge) and for hover/selection focus, which lights up the
  // focused node's UPSTREAM (ancestor chain to the root) and DOWNSTREAM (its
  // whole descendant subtree) and dims everything off that lineage path.
  const treeParentById = layout.treeParentById;
  const treeChildrenOf = useMemo(() => {
    const childrenOf = new Map<string, Set<string>>();
    for (const n of nodes) childrenOf.set(n.id, new Set());
    for (const [child, parent] of treeParentById) {
      childrenOf.get(parent)?.add(child);
    }
    return childrenOf;
  }, [nodes, treeParentById]);

  // The focused node's LINEAGE: itself + every ancestor up to the root idea +
  // every descendant. This is the node's up/down-stream along the derivation
  // tree — its direct ancestors (proposal → source idea → parent ideas → root)
  // and its full descendant subtree. Intentionally different from the graph's
  // connected-component "family": a sibling/cousin branch is NOT on this node's
  // lineage and stays dimmed. Returns null when nothing is focused (→ everyone
  // opaque).
  const focusId = hoverId ?? selectedId;
  const focusLineage = useMemo(() => {
    if (!focusId || !nodeById.has(focusId)) return null;
    const fam = new Set<string>([focusId]);
    // Upstream: walk the parent chain to the root (fam membership guards cycles).
    let cur: string | undefined = focusId;
    while (cur !== undefined) {
      const parent = treeParentById.get(cur);
      if (parent === undefined || fam.has(parent)) break;
      fam.add(parent);
      cur = parent;
    }
    // Downstream: DFS over children.
    const stack = [focusId];
    while (stack.length) {
      const c = stack.pop() as string;
      for (const kid of treeChildrenOf.get(c) ?? []) {
        if (!fam.has(kid)) {
          fam.add(kid);
          stack.push(kid);
        }
      }
    }
    return fam;
  }, [focusId, nodeById, treeParentById, treeChildrenOf]);

  // --- Animation state (refs, not React state) ------------------------------
  // `animsRef` carries each node's tween record across frames. `renderedRef`
  // exposes the LIVE (interpolated) center coords so the click/hover hit-test
  // and the link painter agree with what is on screen at this instant.
  const animsRef = useRef(new Map<string, NodeAnim>());
  const renderedRef = useRef(new Map<string, { x: number; y: number }>());
  const viewRef = useRef<ViewTransform>({ scale: 1, tx: 0, ty: 0 });
  const fittedRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  // Reconcile the tween map whenever the layout (target coords) changes:
  //   - surviving node → retarget `to`, restart the glide from its CURRENT
  //     rendered position (so an in-flight tween redirects smoothly).
  //   - new node → enter record, `from === to` at the target, fading/scaling in.
  //   - vanished node → flip to exit (fade out); GC'd once its fade completes.
  // The effect keys on `layout` identity (the memoized layout result), which
  // already changes whenever the visible node/link set changes.
  useEffect(() => {
    const anims = animsRef.current;
    const rendered = renderedRef.current;
    const now = performance.now();
    const positions = layout.positions;

    // Survivors + entries.
    for (const [id, pos] of positions) {
      const node = nodeById.get(id);
      if (!node) continue;
      const target = { x: pos.x, y: pos.y };
      const existing = anims.get(id);
      if (existing && !existing.exit) {
        // Retarget from the node's current rendered position.
        const cur = rendered.get(id) ?? existing.to;
        if (cur.x !== target.x || cur.y !== target.y) {
          existing.from = { ...cur };
          existing.to = target;
          existing.start = now;
          existing.enter = false;
        }
        existing.node = node;
      } else {
        // New (or re-appearing after an exit) node: enter at target.
        anims.set(id, {
          from: { ...target },
          to: target,
          start: now,
          enter: true,
          exit: false,
          node,
        });
        rendered.set(id, { ...target });
      }
    }

    // Vanished nodes → start fade-out (keep their last rendered position).
    for (const [id, anim] of anims) {
      if (!positions.has(id) && !anim.exit) {
        anim.exit = true;
        anim.enter = false;
        anim.start = now;
        anim.from = rendered.get(id) ?? anim.to;
        anim.to = anim.from;
      }
    }

    // Kick the render loop.
    scheduleRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, nodeById]);

  // --- Container sizing (HiDPI-aware) ---------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const apply = (w: number, h: number) =>
      setDims({ width: Math.max(1, Math.floor(w)), height: Math.max(1, Math.floor(h)) });
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) apply(r.width, r.height);
    });
    ro.observe(el);
    apply(el.clientWidth, el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // --- One-time fit on first non-empty layout (Tech Design: no auto-refit) --
  useEffect(() => {
    if (fittedRef.current) return;
    if (layout.positions.size === 0) return;
    if (dims.width <= 1 || dims.height <= 1) return;
    fittedRef.current = true;
    fitToView(layout, dims, viewRef);
    scheduleRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, dims]);

  // --- Render loop ----------------------------------------------------------
  // A single rAF-driven painter. Runs while any tween is in flight; otherwise
  // it paints one settled frame and stops (presence/hover/selection changes
  // re-arm it). Keeping it demand-driven avoids a permanent animation loop.
  const renderFrame = useCallback(() => {
    rafRef.current = null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const { width, height } = dims;
    // Size the backing store to device pixels (crisp on HiDPI) once per frame.
    const bw = Math.floor(width * dpr);
    const bh = Math.floor(height * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;

    const view = viewRef.current;
    const anims = animsRef.current;
    const rendered = renderedRef.current;
    const now = performance.now();

    // Advance every tween, write live centers into `rendered`, GC finished exits.
    let animating = false;
    for (const [id, anim] of anims) {
      const elapsed = now - anim.start;
      const p = TWEEN_MS <= 0 ? 1 : Math.min(1, elapsed / TWEEN_MS);
      const e = easeOutCubic(p);
      if (p < 1) animating = true;
      if (anim.exit) {
        // Stays put; fade handled in the painter via opacity below. GC at end.
        rendered.set(id, { ...anim.from });
        if (p >= 1) {
          anims.delete(id);
          rendered.delete(id);
        }
      } else {
        rendered.set(id, {
          x: anim.from.x + (anim.to.x - anim.from.x) * e,
          y: anim.from.y + (anim.to.y - anim.from.y) * e,
        });
      }
    }

    // Theme-dependent surface palette, resolved from the `.dark` class each
    // frame (a theme flip re-arms the render loop via the observer below).
    const surface = resolveSurface();

    // Clear.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = surface.bg;
    ctx.fillRect(0, 0, width, height);

    // Apply the pan/zoom transform (graph → screen). All subsequent geometry is
    // in graph space.
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.tx, dpr * view.ty);

    // 1) Links first (under the cards).
    paintLinks(ctx, {
      links,
      treeParentById,
      rendered,
      anims,
      hoverId,
      selectedId,
      focusLineage,
    });

    // 2) Node cards.
    for (const [id, anim] of anims) {
      const center = rendered.get(id);
      if (!center) continue;
      const elapsed = now - anim.start;
      const p = TWEEN_MS <= 0 ? 1 : Math.min(1, elapsed / TWEEN_MS);
      const e = easeOutCubic(p);
      let opacity = 1;
      let scale = 1;
      if (anim.enter) {
        opacity = e;
        scale = 0.85 + 0.15 * e;
      } else if (anim.exit) {
        opacity = 1 - e;
        scale = 1 - 0.1 * e;
      }
      paintNode(ctx, anim.node, center, {
        surface,
        opacity,
        scale,
        hoverId,
        selectedId,
        focusLineage,
        matchIds,
        currentMatchId,
        getPresence,
        typeLabels,
        resolveStatusPill,
      });
    }

    // 3) Hover-tooltip anchor (Tech Design D2). Compute the hovered card's
    // SCREEN position from its LIVE rendered center + the view transform (the
    // inverse of screenToGraph), then anchor the DOM tooltip beside the card:
    // preferred to the right edge with a gap, vertically centered; flipped to
    // the left and/or clamped inside the container when it would overflow.
    // Reading the live `rendered` center keeps the anchor attached while the
    // card tweens/pans/zooms. Written to React state only on meaningful change
    // (epsilon-guarded) so the DOM tooltip follows without per-frame churn.
    const hovered = hoverId ? rendered.get(hoverId) : undefined;
    const hoveredExiting = hoverId ? anims.get(hoverId)?.exit : false;
    if (hovered && !hoveredExiting) {
      const centerX = hovered.x * view.scale + view.tx;
      const centerY = hovered.y * view.scale + view.ty;
      const halfW = (CARD_W / 2) * view.scale;
      // Prefer the right side. Flip to the left if the right placement would run
      // past the container's right edge.
      const rightX = centerX + halfW + TOOLTIP_GAP;
      const leftX = centerX - halfW - TOOLTIP_GAP - TOOLTIP_EST_W;
      let ax =
        rightX + TOOLTIP_EST_W <= width - TOOLTIP_MARGIN ? rightX : leftX;
      // Final horizontal clamp inside the container (covers the degenerate case
      // where neither side fully fits).
      ax = Math.max(
        TOOLTIP_MARGIN,
        Math.min(ax, width - TOOLTIP_EST_W - TOOLTIP_MARGIN),
      );
      // Vertically centered on the card, then clamped inside the container.
      let ay = centerY - TOOLTIP_EST_H / 2;
      ay = Math.max(
        TOOLTIP_MARGIN,
        Math.min(ay, height - TOOLTIP_EST_H - TOOLTIP_MARGIN),
      );
      setTooltipAnchor((prev) =>
        prev && Math.abs(prev.x - ax) < 0.5 && Math.abs(prev.y - ay) < 0.5
          ? prev
          : { x: ax, y: ay },
      );
    } else if (tooltipAnchorRef.current !== null) {
      setTooltipAnchor(null);
    }

    if (animating || hasActivePresence(getPresence, nodes)) {
      scheduleRender();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims, links, treeParentById, hoverId, selectedId, focusLineage, matchIds, currentMatchId, getPresence, nodes, typeLabels, resolveStatusPill]);

  const renderFrameRef = useRef(renderFrame);
  renderFrameRef.current = renderFrame;
  const scheduleRender = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => renderFrameRef.current());
  }, []);
  // expose to the layout effect (declared before it via hoisting of the const)

  // Repaint on theme flip. The canvas resolves its SURFACE palette from the
  // `.dark` class on <html> at paint time (Canvas 2D can't read CSS tokens), so
  // a light↔dark toggle must re-arm the render loop. Observe the class attribute
  // rather than reading a React theme value so this works regardless of how the
  // theme is driven (next-themes toggles that class).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const obs = new MutationObserver(() => scheduleRender());
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, [scheduleRender]);

  // Repaint when presence / hover / selection / size / search state change
  // (these alter the painted frame even when no tween is running).
  useEffect(() => {
    scheduleRender();
  }, [
    hoverId,
    selectedId,
    focusLineage,
    matchIds,
    currentMatchId,
    dims,
    getPresence,
    scheduleRender,
  ]);

  // Camera centering on the current match (Tech Design D5/D6, Q5=b). When the
  // parent bumps `centerNodeId` (debounced on query-settle + on each prev/next
  // step), center the camera on that node's SETTLED layout position — not its
  // mid-tween rendered center, so we don't chase a moving target while an
  // auto-expand tween is in flight. Keeps the current scale (no refit) and
  // schedules a repaint. Reads layout.positions (the tween target), matching
  // fitToView's source of truth.
  useEffect(() => {
    if (!centerNodeId) return;
    if (dims.width <= 1 || dims.height <= 1) return;
    const pos = layout.positions.get(centerNodeId);
    if (!pos) return; // not laid out (yet) — a later center signal will catch it
    viewRef.current = centerTransformFor(
      pos,
      dims,
      viewRef.current.scale,
    );
    scheduleRender();
  }, [centerNodeId, layout, dims, scheduleRender]);

  useEffect(() => {
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        // Reset the guard so a remount can schedule again. Without this, React
        // StrictMode's mount→unmount→remount cycle (dev) leaves rafRef holding
        // a cancelled-but-non-null id, and every subsequent scheduleRender()
        // short-circuits on `if (rafRef.current != null) return` — the canvas
        // would never paint (white screen).
        rafRef.current = null;
      }
      // Drop a deferred touch-tap timer so it can't fire onNodeClick after
      // unmount.
      if (pendingTapRef.current != null) {
        clearTimeout(pendingTapRef.current);
        pendingTapRef.current = null;
      }
    };
  }, []);

  // --- Pointer interaction: hover, click, pan, zoom -------------------------
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origTx: number;
    origTy: number;
    moved: boolean;
  } | null>(null);

  // Active touch/pointer points, keyed by pointerId, in canvas-local screen
  // coords (Tech Design D1). Drives gesture arbitration: 1 point → drag/tap;
  // 2 points → pinch. Non-touch (mouse) never keeps more than one entry.
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  // Pinch gesture start snapshot (null when not pinching). Captured when the
  // second pointer joins; cleared when a pointer lifts.
  const pinchRef = useRef<{
    midpoint: { x: number; y: number };
    dist: number;
    view: ViewTransform;
  } | null>(null);
  // True once a touch sequence reached two fingers, until ALL fingers lift.
  // Guards the final finger-up (after pinchRef is already cleared) from being
  // misread as a tap → node click.
  const multiTouchRef = useRef(false);
  // Last clean tap (for double-tap detection, Tech Design D2): screen coords +
  // timestamp. A second tap within DOUBLE_TAP_MS / DOUBLE_TAP_DIST is a
  // double-tap (zoom), not a node click.
  const lastTapRef = useRef<{ x: number; y: number; t: number } | null>(null);
  // Deferred single-tap timer (touch only, D2). A touch tap that hits a node
  // schedules its onNodeClick DOUBLE_TAP_MS later; if a second tap lands inside
  // the window it's cancelled and the gesture becomes a zoom, so a fast
  // double-tap never both navigates and zooms. Mouse/pen clicks are NOT
  // deferred (desktop stays instant + unchanged).
  const pendingTapRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingTap = useCallback(() => {
    if (pendingTapRef.current !== null) {
      clearTimeout(pendingTapRef.current);
      pendingTapRef.current = null;
    }
  }, []);

  // Distance + midpoint of the two currently-active pointers (screen coords).
  // Returns null unless exactly two pointers are down.
  const twoPointerGeometry = useCallback(() => {
    const pts = [...pointersRef.current.values()];
    if (pts.length !== 2) return null;
    const [a, b] = pts;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return {
      midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      dist: Math.hypot(dx, dy) || 1,
    };
  }, []);

  const screenToGraph = useCallback((sx: number, sy: number) => {
    const v = viewRef.current;
    return { x: (sx - v.tx) / v.scale, y: (sy - v.ty) / v.scale };
  }, []);

  // Hit-test a graph-space point against the LIVE rendered card rects. Returns
  // the topmost node id (iterate in paint order; later entries are on top, but
  // cards don't overlap in a tree layout so order is moot). Skips exiting nodes.
  const hitTest = useCallback((gx: number, gy: number): ForceNode | null => {
    const rendered = renderedRef.current;
    const anims = animsRef.current;
    for (const [id, anim] of anims) {
      if (anim.exit) continue;
      const c = rendered.get(id);
      if (!c) continue;
      if (
        gx >= c.x - CARD_W / 2 &&
        gx <= c.x + CARD_W / 2 &&
        gy >= c.y - CARD_H / 2 &&
        gy <= c.y + CARD_H / 2
      ) {
        return anim.node ?? null;
      }
    }
    return null;
  }, []);

  const handlePointerDown = useCallback(
    (ev: React.PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
      pointersRef.current.set(ev.pointerId, { x: sx, y: sy });
      (ev.target as Element).setPointerCapture?.(ev.pointerId);

      if (pointersRef.current.size >= 2) {
        // Second finger down → enter pinch. Snapshot the gesture start and
        // cancel any single-pointer drag/tap so the leftover finger neither
        // pans nor fires a click when the gesture ends (D1).
        multiTouchRef.current = true;
        const geo = twoPointerGeometry();
        if (geo) {
          pinchRef.current = { ...geo, view: { ...viewRef.current } };
        }
        if (dragRef.current) dragRef.current.moved = true; // consume the tap
        cancelPendingTap(); // a deferred single-tap is void once 2 fingers land
        return;
      }

      // First pointer → begin a potential drag/tap (unchanged single-pointer
      // path).
      dragRef.current = {
        startX: sx,
        startY: sy,
        origTx: viewRef.current.tx,
        origTy: viewRef.current.ty,
        moved: false,
      };
    },
    [twoPointerGeometry, cancelPendingTap],
  );

  const handlePointerMove = useCallback(
    (ev: React.PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;

      // Keep the tracked point fresh (only if this pointer is down — a hover
      // move from a mouse has no entry and must fall through to hit-testing).
      if (pointersRef.current.has(ev.pointerId)) {
        pointersRef.current.set(ev.pointerId, { x: sx, y: sy });
      }

      // Two-finger pinch (D1, Q2=a): scale by the live/start distance ratio and
      // pan so the graph point under the start midpoint tracks the live
      // midpoint (map-like combined zoom + move).
      const pinch = pinchRef.current;
      if (pinch) {
        const geo = twoPointerGeometry();
        if (geo) {
          viewRef.current = pinchTransform(pinch, geo);
          scheduleRender();
        }
        return;
      }

      const drag = dragRef.current;
      if (drag) {
        const dx = sx - drag.startX;
        const dy = sy - drag.startY;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.moved) {
          viewRef.current = {
            ...viewRef.current,
            tx: drag.origTx + dx,
            ty: drag.origTy + dy,
          };
          scheduleRender();
        }
        return;
      }
      // Hover hit-test.
      const g = screenToGraph(sx, sy);
      const hit = hitTest(g.x, g.y);
      const nextHover = hit ? hit.id : null;
      setHoverId((prev) => (prev === nextHover ? prev : nextHover));
    },
    [hitTest, screenToGraph, scheduleRender, twoPointerGeometry],
  );

  // Zoom in centered on a tapped screen point (double-tap, D2). Reuses the
  // wheel anchor math with the tap as the focus so the tapped point stays put.
  const zoomInAt = useCallback(
    (sx: number, sy: number) => {
      const v = viewRef.current;
      const fit = fitTransformFor(layout, dims);
      const target = Math.min(
        SCALE_MAX,
        (fit?.scale ?? v.scale) * DOUBLE_TAP_ZOOM_FACTOR,
      );
      const gx = (sx - v.tx) / v.scale;
      const gy = (sy - v.ty) / v.scale;
      viewRef.current = {
        scale: target,
        tx: sx - gx * target,
        ty: sy - gy * target,
      };
      scheduleRender();
    },
    [layout, dims, scheduleRender],
  );

  const handlePointerUp = useCallback(
    (ev: React.PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      // Drop this pointer from the active set.
      pointersRef.current.delete(ev.pointerId);
      (ev.target as Element).releasePointerCapture?.(ev.pointerId);
      // Any pointer lift ends a pinch; the remaining finger (if any) must NOT
      // resume a pan mid-gesture, so clear the drag start (D1).
      if (pointersRef.current.size < 2) pinchRef.current = null;
      // A multi-touch sequence (2+ fingers seen) consumes the WHOLE gesture:
      // neither the second finger's up nor the final finger's up becomes a tap.
      // Cleared only once every finger has lifted.
      if (multiTouchRef.current) {
        dragRef.current = null;
        if (pointersRef.current.size === 0) multiTouchRef.current = false;
        return;
      }

      const drag = dragRef.current;
      dragRef.current = null;
      if (!rect) return;
      // A pan (moved) consumes the gesture; only a clean tap is a click.
      if (drag?.moved) return;

      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;

      // Double-tap detection (D2): a second clean tap within the time + distance
      // window is a zoom toggle, NOT a node click. Toggle = zoom in on the tap
      // point if we're at (approximately) the fit scale, else reset to fit.
      const now = performance.now();
      const prevTap = lastTapRef.current;
      if (
        prevTap &&
        now - prevTap.t <= DOUBLE_TAP_MS &&
        Math.hypot(sx - prevTap.x, sy - prevTap.y) <= DOUBLE_TAP_DIST
      ) {
        lastTapRef.current = null; // consume; a triple-tap starts fresh
        cancelPendingTap(); // drop the first tap's deferred node click
        const fit = fitTransformFor(layout, dims);
        const atFit =
          fit !== null && Math.abs(viewRef.current.scale - fit.scale) < 0.01;
        if (atFit) {
          zoomInAt(sx, sy);
        } else if (fit) {
          viewRef.current = fit;
          scheduleRender();
        }
        return; // double-tap consumed — no node click
      }
      lastTapRef.current = { x: sx, y: sy, t: now };

      const g = screenToGraph(sx, sy);
      const hit = hitTest(g.x, g.y);
      if (!hit) return;

      // +/- button hit-test: the right BTN_W strip of the card, same geometry
      // the painter uses (mirrors the old screen2GraphCoords affordance check).
      let onAff = false;
      if (hit.hasAffordance) {
        const center = renderedRef.current.get(hit.id);
        if (center) {
          const right = center.x + CARD_W / 2;
          if (
            g.x >= right - BTN_W &&
            Math.abs(g.y - center.y) <= CARD_H / 2
          ) {
            onAff = true;
          }
        }
      }
      // Touch taps defer the click by DOUBLE_TAP_MS so a follow-up tap can
      // cancel it (turning the pair into a zoom). Mouse/pen fire immediately —
      // desktop click stays instant and unchanged. An affordance (+/-) tap also
      // fires immediately: expand/collapse is not a double-tap target.
      if (ev.pointerType === "touch" && !onAff) {
        cancelPendingTap();
        const { id, type } = hit;
        pendingTapRef.current = setTimeout(() => {
          pendingTapRef.current = null;
          onNodeClick(id, type, false);
        }, DOUBLE_TAP_MS);
        return;
      }
      onNodeClick(hit.id, hit.type, onAff);
    },
    [
      hitTest,
      screenToGraph,
      onNodeClick,
      layout,
      dims,
      zoomInAt,
      scheduleRender,
      cancelPendingTap,
    ],
  );

  // A cancelled pointer (OS gesture takeover, etc.) must clean up the same way
  // an up does, or a stuck pointer would leave the canvas wedged in pinch mode.
  const handlePointerCancel = useCallback((ev: React.PointerEvent) => {
    pointersRef.current.delete(ev.pointerId);
    (ev.target as Element).releasePointerCapture?.(ev.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) {
      dragRef.current = null;
      multiTouchRef.current = false;
    }
  }, []);

  // Zoom by a scale factor while keeping the graph point under (sx, sy) fixed
  // (cursor/viewport anchor). Shared by the wheel-zoom path and the on-screen
  // zoom buttons (Tech Design D1/D2). Clamps to [SCALE_MIN, SCALE_MAX].
  const zoomAround = useCallback(
    (scaleFactor: number, sx: number, sy: number) => {
      const v = viewRef.current;
      const nextScale = Math.min(
        SCALE_MAX,
        Math.max(SCALE_MIN, v.scale * scaleFactor),
      );
      const gx = (sx - v.tx) / v.scale;
      const gy = (sy - v.ty) / v.scale;
      viewRef.current = {
        scale: nextScale,
        tx: sx - gx * nextScale,
        ty: sy - gy * nextScale,
      };
      scheduleRender();
    },
    [scheduleRender],
  );
  // Keep a live ref to zoomAround so the native (non-React) wheel listener below
  // can call the latest closure without re-attaching on every render.
  const zoomAroundRef = useRef(zoomAround);
  zoomAroundRef.current = zoomAround;

  // Native, NON-PASSIVE wheel listener. React's onWheel is passive in some
  // browsers, so preventDefault() there is ignored (and warns). Attaching
  // manually with { passive: false } lets us stop the page from scrolling while
  // the cursor is over the canvas.
  //
  // Wheel model (idea 9d326265, elaboration round 3 — "protect mouse-wheel
  // zoom"): a wheel over the canvas ALWAYS zooms around the cursor, at any
  // speed, with no modifier required. No device inference, no pan-on-wheel —
  // panning is via drag (see handlePointerMove). A trackpad pinch arrives as a
  // synthetic ctrlKey wheel with fine pixel deltas, so it uses the finer
  // ZOOM_PINCH_SENSITIVITY; a plain mouse notch uses ZOOM_WHEEL_SENSITIVITY.
  // Scrolling up (negative deltaY) yields a factor > 1 (zoom in).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (ev: WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
      // Stop the page from scrolling under the canvas.
      ev.preventDefault();
      const sensitivity = ev.ctrlKey
        ? ZOOM_PINCH_SENSITIVITY
        : ZOOM_WHEEL_SENSITIVITY;
      zoomAroundRef.current(Math.exp(-ev.deltaY * sensitivity), sx, sy);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [scheduleRender]);

  // --- On-screen zoom / fit controls (Tech Design D2, Q4=a) -----------------
  // A fallback zoom entry point that needs no gesture, wheel, or modifier key.
  // The +/- buttons step the zoom centered on the viewport (reusing zoomAround);
  // fit re-frames the whole tree via the same fitTransformFor the first-load fit
  // and double-tap reset use. Hidden while the layout is empty (nothing to zoom).
  const zoomInByButton = useCallback(() => {
    zoomAround(ZOOM_BUTTON_STEP, dims.width / 2, dims.height / 2);
  }, [zoomAround, dims.width, dims.height]);
  const zoomOutByButton = useCallback(() => {
    zoomAround(1 / ZOOM_BUTTON_STEP, dims.width / 2, dims.height / 2);
  }, [zoomAround, dims.width, dims.height]);
  const fitByButton = useCallback(() => {
    const next = fitTransformFor(layout, dims);
    if (next) {
      viewRef.current = next;
      scheduleRender();
    }
  }, [layout, dims, scheduleRender]);
  const hasNodes = layout.positions.size > 0;

  return (
    <div ref={containerRef} className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none"
        style={{ width: dims.width, height: dims.height, cursor: hoverId ? "pointer" : "grab" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={() => setHoverId(null)}
      />
      {/* Hover tooltip — a DOM overlay above the canvas (Tech Design D3).
          Title-only: shows the hovered node's FULL untruncated title (the one
          thing the card can't show after its own truncation). Mounts only while
          a node is hovered AND its anchor is resolved; mouse-out (hoverId →
          null) unmounts it. pointer-events-none lives on the tooltip root so it
          never intercepts a canvas click. */}
      {hoveredNode && tooltipAnchor && (
        <NodeTooltip
          title={hoveredNode.title}
          x={tooltipAnchor.x}
          y={tooltipAnchor.y}
        />
      )}
      {/* On-screen zoom / fit control cluster (Tech Design D2, Q4=a). A DOM
          overlay in the bottom-left (opposite the top-right search card),
          giving a gesture-free zoom/reframe fallback. Hidden while the graph
          is empty. All labels are i18n-driven (graph.zoom.*). */}
      {hasNodes && (
        <TooltipProvider delayDuration={300}>
          <div className="absolute bottom-3 left-3 flex flex-col gap-1 rounded-lg border border-border bg-card/95 p-1 shadow-sm backdrop-blur-sm">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={zoomInByButton}
                  aria-label={t("graph.zoom.in")}
                  data-testid="graph-zoom-in"
                  className="text-muted-foreground"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{t("graph.zoom.in")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={zoomOutByButton}
                  aria-label={t("graph.zoom.out")}
                  data-testid="graph-zoom-out"
                  className="text-muted-foreground"
                >
                  <Minus className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{t("graph.zoom.out")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={fitByButton}
                  aria-label={t("graph.zoom.fit")}
                  data-testid="graph-zoom-fit"
                  className="text-muted-foreground"
                >
                  <Maximize className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{t("graph.zoom.fit")}</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      )}
    </div>
  );
}

// Backwards-compatible alias: the parent's dynamic import historically resolved
// `m.ForceGraphCanvas`. Keep that name pointing at the new component so the
// import site only needs its module path updated, not the member name.
export const ForceGraphCanvas = MindMapCanvas;

// ============================================================================
// Painters
// ============================================================================

interface PaintNodeOpts {
  /** Theme-dependent surface colors (card fill/border/divider/title). */
  surface: SurfacePalette;
  opacity: number;
  scale: number;
  hoverId: string | null;
  selectedId: string | null;
  focusLineage: Set<string> | null;
  /** Active search match set (null = not searching); drives the non-match dim. */
  matchIds: ReadonlySet<string> | null;
  /** The current-match cursor id (distinct ring; never feeds focus/lineage). */
  currentMatchId: string | null;
  getPresence: ReturnType<typeof usePresence>["getPresence"];
  /** Localized type-eyebrow labels, resolved via t() in the component. */
  typeLabels: Record<NodeType, string>;
  /**
   * Per-node status pill resolver — returns the raw hex pair + the already-
   * translated label, or null when no status is set on the node. Resolved
   * upstream in the component so the painter stays pure and i18n-driven.
   */
  resolveStatusPill: (
    node: ForceNode,
  ) => { bg: string; fg: string; label: string } | null;
}

function paintNode(
  ctx: CanvasRenderingContext2D,
  node: ForceNode,
  center: { x: number; y: number },
  opts: PaintNodeOpts,
) {
  const {
    surface,
    opacity,
    scale,
    hoverId,
    selectedId,
    focusLineage,
    matchIds,
    currentMatchId,
    getPresence,
    typeLabels,
    resolveStatusPill,
  } = opts;
  const type = node.type;
  // Type hue — lifted variant under `.dark` (Canvas 2D can't honor `dark:`;
  // read the class live, matching resolveSurface / resolveStatusPill).
  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");
  const color = (isDark ? TYPE_COLOR_DARK : TYPE_COLOR)[type];

  // Per-node opacity composes hover/selection lineage focus with the search
  // match set, in priority order (Tech Design D4 / Q3=a): a live lineage dims by
  // lineage (hover takes over), else a non-empty match set dims non-matches,
  // else everyone is opaque. The current-match cursor never affects opacity.
  const focusAlpha = resolveFocusAlpha(node.id, focusLineage, matchIds);
  const alpha = opacity * focusAlpha;

  const isSelected = node.id === selectedId;
  const isHovered = node.id === hoverId;
  // Current-match cursor — drives ONLY the distinct ring below; deliberately
  // does not set selection or feed focusLineage (stepping never lights lineage).
  const isCurrentMatch = currentMatchId != null && node.id === currentMatchId;

  ctx.save();
  ctx.globalAlpha = alpha;

  // Enter/exit scale: grow from the card center so the fade-in feels anchored.
  if (scale !== 1) {
    ctx.translate(center.x, center.y);
    ctx.scale(scale, scale);
    ctx.translate(-center.x, -center.y);
  }

  const left = center.x - CARD_W / 2;
  const top = center.y - CARD_H / 2;

  // Presence ring (view = dashed, mutate = solid) — same convention as
  // PresenceIndicator. Painted first so the card sits on top of its glow.
  const presence = getPresence(type, node.id);
  const mutating = presence.find((p) => p.action === "mutate");
  const primary = mutating ?? presence[presence.length - 1];
  if (primary) {
    const ringColor = getAgentColor(primary.agentName);
    ctx.save();
    ctx.shadowColor = ringColor;
    ctx.shadowBlur = 18;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = ringColor;
    if (!mutating) ctx.setLineDash([5, 4]);
    roundRect(ctx, left - 4, top - 4, CARD_W + 8, CARD_H + 8, CARD_R + 3);
    ctx.stroke();
    ctx.restore();

    // Identify the acting agent (spec: presence highlight "SHALL identify the
    // acting agent") — the canvas paints the agent's name on a colored chip
    // above the card.
    ctx.save();
    ctx.setLineDash([]);
    ctx.font = "600 9px ui-sans-serif, system-ui";
    const label = primary.agentName;
    const padX = 6;
    const labelW = ctx.measureText(label).width + padX * 2;
    const pillH = 15;
    const pillX = left;
    const pillY = top - 4 - pillH - 3;
    ctx.fillStyle = ringColor;
    roundRect(ctx, pillX, pillY, labelW, pillH, 5);
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, pillX + padX, pillY + pillH / 2 + 0.5);
    ctx.restore();
  }

  // Soft type-colored glow behind the card on hover/selection.
  if (isHovered || isSelected) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = isHovered ? 26 : 16;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0; // shadow only, no visible fill
    roundRect(ctx, left, top, CARD_W, CARD_H, CARD_R);
    ctx.fill();
    ctx.restore();
  }

  // Card body.
  ctx.fillStyle = surface.cardFill;
  ctx.strokeStyle = isSelected ? color : surface.cardBorder;
  ctx.lineWidth = isSelected ? 2 : 1;
  roundRect(ctx, left, top, CARD_W, CARD_H, CARD_R);
  ctx.fill();
  ctx.stroke();

  // Current-match ring (Tech Design D5) — a distinct outset ring on the prev/
  // next cursor, visually separate from the selection ring (which recolors the
  // card border in the node's type color) and from a plain match (full opacity,
  // no ring). It is the only thing the current-match cursor draws; it does not
  // change the dim composition above or trigger any lineage highlight. Painted
  // at full alpha (ignoring the match dim) so the cursor always reads clearly.
  if (isCurrentMatch) {
    ctx.save();
    ctx.globalAlpha = opacity; // ignore focus dim; keep only enter/exit fade
    ctx.strokeStyle = CURRENT_MATCH_RING_COLOR;
    ctx.lineWidth = 2.5;
    roundRect(ctx, left - 3, top - 3, CARD_W + 6, CARD_H + 6, CARD_R + 2);
    ctx.stroke();
    ctx.restore();
  }

  // Type chip. In LIGHT mode it's a saturated hue block with a white icon. In
  // DARK mode that solid block reads heavy/glaring on the charcoal card, so we
  // soften it to match the status-badge idiom: a deep hue-tinted background
  // (the hue at low alpha over the card) with the icon stroked in the hue
  // itself rather than white. Reads calmer and more clearly "themed".
  const chipX = left + 8;
  const chipY = center.y - CHIP / 2;
  if (isDark) {
    ctx.fillStyle = hexWithAlpha(color, 0.22); // deep hue-tinted fill
    roundRect(ctx, chipX, chipY, CHIP, CHIP, 9);
    ctx.fill();
    paintLucideIcon(ctx, TYPE_ICON_PATHS[type], chipX, chipY, CHIP, color);
  } else {
    ctx.fillStyle = color;
    roundRect(ctx, chipX, chipY, CHIP, CHIP, 9);
    ctx.fill();
    // Lucide icon inside the chip (stroked white), replacing the old emoji glyph.
    paintLucideIcon(ctx, TYPE_ICON_PATHS[type], chipX, chipY, CHIP);
  }

  // Text column. Reserve the right BTN_W strip for the +/- button on hubs.
  const hasBtn = !!node.hasAffordance;
  const textX = chipX + CHIP + 10;
  const contentRight = left + CARD_W - (hasBtn ? BTN_W : 12);
  const textW = contentRight - textX;

  // Eyebrow row composition (Tech Design D2): left-aligned localized type label
  // (`graph.nodeType.<type>`, so a zh user sees 想法/提案/任务/文档) PLUS a
  // right-aligned status pill (idea badgeHint / proposal status / task status /
  // document type) painted from the shared `node-status.ts` `{ bg, fg }` hex +
  // its translated label. The pill is ellipsis-truncated to whatever width
  // remains beside the type label so a long badgeHint (e.g. "Review Proposal")
  // never overflows the ~200px card or collides with the title below.
  const EYEBROW_Y = center.y - 8;
  const PILL_GAP = 6; // gap between the type label and the status pill
  const PILL_PAD_X = 5; // horizontal padding inside the pill
  const PILL_H = 12; // pill height (eyebrow row is ~9px text + breathing room)
  const PILL_R = 5; // pill corner radius
  const PILL_FONT = "600 9px ui-sans-serif, system-ui";

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = "600 9px ui-monospace, monospace";
  ctx.fillStyle = color;
  ctx.fillText(typeLabels[type], textX, EYEBROW_Y);
  const typeLabelW = ctx.measureText(typeLabels[type]).width;

  // Status pill — paint AFTER the type label so the type label always wins for
  // space; the pill claims whatever's left and is ellipsis-truncated to fit.
  const pill = resolveStatusPill(node);
  if (pill) {
    const pillSlotLeft = textX + typeLabelW + PILL_GAP;
    const pillSlotRight = contentRight;
    const pillSlotW = pillSlotRight - pillSlotLeft;
    // Render the pill only when there's enough room for at least the ellipsis
    // glyph plus padding — otherwise hiding it cleanly is better than painting
    // a 4px sliver.
    if (pillSlotW >= PILL_PAD_X * 2 + 6) {
      const maxTextW = pillSlotW - PILL_PAD_X * 2;
      ctx.font = PILL_FONT;
      const truncated = truncate(ctx, pill.label, maxTextW);
      const textWMeasured = ctx.measureText(truncated).width;
      const pillW = Math.min(pillSlotW, textWMeasured + PILL_PAD_X * 2);
      // Right-align the pill within its slot so it sits flush against the
      // content-right edge (just to the left of the +/- button strip on hubs).
      const pillX = pillSlotRight - pillW;
      const pillY = EYEBROW_Y - PILL_H + 2; // align baseline-ish with eyebrow text
      ctx.fillStyle = pill.bg;
      roundRect(ctx, pillX, pillY, pillW, PILL_H, PILL_R);
      ctx.fill();
      ctx.fillStyle = pill.fg;
      ctx.textBaseline = "middle";
      ctx.fillText(truncated, pillX + PILL_PAD_X, pillY + PILL_H / 2 + 0.5);
      ctx.textBaseline = "alphabetic";
    }
  }

  // Title (truncated to the text column width). Painted AFTER the eyebrow so it
  // sits on its own row below — no interference with the type label / pill.
  ctx.fillStyle = surface.title;
  ctx.font = "500 12px ui-sans-serif, system-ui";
  ctx.textAlign = "left";
  ctx.fillText(truncate(ctx, node.title, textW - 4), textX, center.y + 7);

  // Expand/collapse button — a dedicated, easy-to-hit control on the right.
  if (hasBtn) {
    const btnLeft = left + CARD_W - BTN_W;
    // Divider.
    ctx.strokeStyle = surface.divider;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(btnLeft, top + 7);
    ctx.lineTo(btnLeft, top + CARD_H - 7);
    ctx.stroke();
    // Tinted hit-zone background (subtle; brighter on hover).
    ctx.fillStyle = hexWithAlpha(color, isHovered ? 0.16 : 0.08);
    roundRect(ctx, btnLeft + 4, top + 6, BTN_W - 10, CARD_H - 12, 8);
    ctx.fill();
    const bx = btnLeft + BTN_W / 2 - 1;
    const collapsed = !node.expanded;
    const count = node.childCount ?? 0;
    // +/- glyph, drawn as strokes (crisp at any zoom).
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    const gy = collapsed && count > 0 ? center.y - 4 : center.y;
    const arm = 5;
    ctx.beginPath();
    ctx.moveTo(bx - arm, gy);
    ctx.lineTo(bx + arm, gy);
    if (collapsed) {
      ctx.moveTo(bx, gy - arm);
      ctx.lineTo(bx, gy + arm);
    }
    ctx.stroke();
    // Child count under the "+" when collapsed.
    if (collapsed && count > 0) {
      ctx.fillStyle = color;
      ctx.font = "600 9px ui-sans-serif, system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${count}`, bx, center.y + 9);
    }
  }

  ctx.restore();
}

interface PaintLinksOpts {
  links: readonly ForceLink[];
  /** Layout's resolved tree-spine parent per child id (single source of truth). */
  treeParentById: Map<string, string>;
  rendered: Map<string, { x: number; y: number }>;
  anims: Map<string, NodeAnim>;
  hoverId: string | null;
  selectedId: string | null;
  focusLineage: Set<string> | null;
}

function paintLinks(ctx: CanvasRenderingContext2D, opts: PaintLinksOpts) {
  const { links, treeParentById, rendered, anims, hoverId, selectedId, focusLineage } =
    opts;
  const focusId = hoverId ?? selectedId;

  // An edge `source -> target` is a SOLID tree-spine connector iff it is the
  // very edge the layout used to position `target` — i.e.
  // treeParentById.get(target) === source. This covers lineage (idea→idea),
  // derive (idea→proposal, proposal→doc/root-task), AND the `depends` edge that
  // nested a dependent task under its prerequisite (so the task DAG draws as an
  // ordinary left→right chain, not a dashed overlay). Everything else — a
  // multi-source proposal's secondary derive edge, or a multi-prerequisite
  // task's secondary `depends` edge — is a non-spine cross-link drawn in Pass 2.
  const isSpine = (l: ForceLink) => treeParentById.get(l.target) === l.source;

  // Two passes so non-spine cross-links sit visually above the solid spine when
  // both share an endpoint.
  // Pass 1: solid spine connectors. Direction source → target (toward the
  // derived/child/dependent node). Right-angle-ish bezier elbow + arrowhead.
  for (const l of links) {
    if (!isSpine(l)) continue;
    const a = rendered.get(l.source);
    const b = rendered.get(l.target);
    if (!a || !b) continue;
    // Skip a connector whose endpoint is mid-exit (the card is fading out).
    if (anims.get(l.source)?.exit || anims.get(l.target)?.exit) continue;

    // A spine connector is "in focus" when it lies on the focused node's
    // lineage path — i.e. BOTH endpoints are in the lineage set (an ancestor→
    // descendant edge). A spine edge into a dimmed sibling/cousin branch has
    // only one endpoint in the lineage and stays dimmed.
    const inFocus = !focusId || isOnLineage(focusLineage, l);
    const base = EDGE_COLOR[l.kind];
    ctx.save();
    ctx.strokeStyle = inFocus ? base : hexWithAlpha(base, 0.35);
    ctx.lineWidth =
      focusId && (l.source === focusId || l.target === focusId) ? 2.4 : 1.5;
    drawElbow(ctx, a, b);
    ctx.stroke();
    // Arrowhead toward the derived node (target).
    drawArrowHead(ctx, a, b, ctx.strokeStyle as string);
    ctx.restore();
  }

  // Pass 2: dashed low-opacity overlay — non-spine cross-links only. A
  // multi-source proposal's secondary source→proposal `derive` edge and a
  // task's secondary `depends` prerequisites land here. Does NOT affect layout.
  // Quiet by default; raised to full opacity only when an endpoint is the
  // focused node or anywhere on its lineage.
  for (const l of links) {
    if (isSpine(l)) continue;
    const a = rendered.get(l.source);
    const b = rendered.get(l.target);
    if (!a || !b) continue;
    if (anims.get(l.source)?.exit || anims.get(l.target)?.exit) continue;

    const emphasized =
      !!focusId &&
      (l.source === focusId ||
        l.target === focusId ||
        (focusLineage != null &&
          (focusLineage.has(l.source) || focusLineage.has(l.target))));
    const base = EDGE_COLOR[l.kind] ?? "#E8833A";
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = emphasized ? 2 : 1.2;
    ctx.strokeStyle = emphasized ? base : hexWithAlpha(base, 0.18);
    drawCurve(ctx, a, b);
    ctx.stroke();
    if (emphasized) drawArrowHead(ctx, a, b, base);
    ctx.restore();
  }
}

// A spine edge lies ON the focused node's lineage path iff BOTH endpoints are in
// the lineage set (a parent→child edge along the ancestor chain or within the
// descendant subtree). An edge with only one endpoint in the lineage leads into
// a dimmed sibling/cousin branch and is not highlighted.
function isOnLineage(focusLineage: Set<string> | null, l: ForceLink): boolean {
  if (!focusLineage) return false;
  return focusLineage.has(l.source) && focusLineage.has(l.target);
}

// ============================================================================
// Geometry helpers
// ============================================================================

// Solid tree connector: leaves the right edge of the source card and enters the
// left edge of the target card with a horizontal bezier elbow (left → right
// mind-map). Falls back to a plain curve if the target is to the left.
function drawElbow(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  const sx = a.x + CARD_W / 2;
  const sy = a.y;
  const tx = b.x - CARD_W / 2;
  const ty = b.y;
  const midX = sx + (tx - sx) / 2;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.bezierCurveTo(midX, sy, midX, ty, tx, ty);
}

// Paint a lucide icon (stroke-based, 24×24 viewBox) into a square chip via
// Path2D. Canvas 2D can't mount a React component, so we stroke the icon's raw
// SVG path data — a faithful vector render. The icon is centered in the chip
// with a small inset (round cap/join, matching lucide's default 2px stroke
// scaled to the chip). `stroke` defaults to white (the solid light chip); the
// dark chip passes the type hue so the glyph sits on a deep tinted fill.
function paintLucideIcon(
  ctx: CanvasRenderingContext2D,
  paths: string[],
  chipX: number,
  chipY: number,
  chip: number,
  stroke = "#FFFFFF",
) {
  const inset = chip * 0.22; // padding inside the chip
  const drawn = chip - inset * 2; // glyph box edge
  const scale = drawn / 24; // lucide viewBox is 24×24
  ctx.save();
  ctx.translate(chipX + inset, chipY + inset);
  ctx.scale(scale, scale);
  ctx.strokeStyle = stroke; // white on the solid light chip; the hue on the deep dark chip
  ctx.lineWidth = 2; // lucide default stroke-width (in 24-unit space)
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const d of paths) {
    ctx.stroke(new Path2D(d));
  }
  ctx.restore();
}

// Dashed overlay connector: a center-to-center quadratic curve, bowed so it
// reads as separate from the straight tree elbows.
function drawCurve(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2 - Math.min(40, Math.abs(b.x - a.x) * 0.15);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.quadraticCurveTo(cx, cy, b.x, b.y);
}

// Arrowhead pointing toward the derived/target node. For solid tree edges the
// tip lands on the target card's left edge; for dashed overlays, near the
// target center. Angle is taken from the incoming segment.
function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  color: string,
) {
  const tipX = b.x - CARD_W / 2;
  const tipY = b.y;
  const angle = Math.atan2(tipY - a.y, tipX - a.x);
  const len = 6;
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(
    tipX - len * Math.cos(angle - Math.PI / 6),
    tipY - len * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    tipX - len * Math.cos(angle + Math.PI / 6),
    tipY - len * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function truncate(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

function hexWithAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

// True when any visible node currently has active presence (drives the steady
// repaint loop so the presence glow stays live without a permanent rAF).
function hasActivePresence(
  getPresence: ReturnType<typeof usePresence>["getPresence"],
  nodes: readonly ForceNode[],
): boolean {
  for (const n of nodes) {
    if (getPresence(n.type, n.id).length > 0) return true;
  }
  return false;
}

// --- Camera fit -------------------------------------------------------------
//
// One-time: frame the whole forest with a small margin, centered. Writes into
// the shared viewRef. Never called again on expand/collapse (Tech Design:
// "do not auto-refit").
/**
 * The view transform that frames the WHOLE tree in `dims` (the one-time
 * first-load fit, and the double-tap reset target). Pure — returns the
 * transform or null when the layout is empty — so the double-tap toggle can
 * read the fit transform without mutating the view. `fitToView` writes it into
 * the ref for the first-load fit path.
 */
export function fitTransformFor(
  layout: ReturnType<typeof computeTreeLayout>,
  dims: { width: number; height: number },
): ViewTransform | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pos of layout.positions.values()) {
    if (pos.x - CARD_W / 2 < minX) minX = pos.x - CARD_W / 2;
    if (pos.x + CARD_W / 2 > maxX) maxX = pos.x + CARD_W / 2;
    if (pos.y - CARD_H / 2 < minY) minY = pos.y - CARD_H / 2;
    if (pos.y + CARD_H / 2 > maxY) maxY = pos.y + CARD_H / 2;
  }
  if (!Number.isFinite(minX)) return null;
  const margin = 60;
  const contentW = maxX - minX || 1;
  const contentH = maxY - minY || 1;
  const scale = Math.min(
    2,
    Math.max(
      0.2,
      Math.min(
        (dims.width - margin * 2) / contentW,
        (dims.height - margin * 2) / contentH,
      ),
    ),
  );
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    scale,
    tx: dims.width / 2 - cx * scale,
    ty: dims.height / 2 - cy * scale,
  };
}

function fitToView(
  layout: ReturnType<typeof computeTreeLayout>,
  dims: { width: number; height: number },
  viewRef: React.MutableRefObject<ViewTransform>,
) {
  const next = fitTransformFor(layout, dims);
  if (next) viewRef.current = next;
}
