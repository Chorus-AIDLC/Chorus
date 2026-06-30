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
import { useNodeDetail } from "./use-node-detail";
import { NodeTooltip } from "./node-tooltip";

// --- Public data shapes (Tech Design D5) ------------------------------------
//
// Preserved historical names. They alias the layout module's input types so
// `resource-graph.tsx` and the live-update test keep importing
// `{ ForceNode, ForceLink } from "./mindmap-canvas"` unchanged.
export type ForceNode = TreeLayoutNode;
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
}

// --- Visual tokens (design.pen "Chorus - Project Graph View") ---------------

const TYPE_COLOR: Record<NodeType, string> = {
  idea: "#7C4DFF",
  proposal: "#2563EB",
  task: "#E8833A",
  document: "#00897B",
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

// Canvas paint geometry (graph-space units; the view transform scales them).
const CARD_W = 200;
const CARD_H = 46;
const CARD_R = 12;
const CHIP = 30;
// The expand/collapse control occupies the right BTN_W strip of the card —
// a big, easy-to-hit target. The click hit-test uses the same value.
const BTN_W = 40;

const TWEEN_MS = 300; // coordinate tween + fade duration (Tech Design D2)
const BG = "#FAF8F4";

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
}: MindMapCanvasProps) {
  const { getPresence } = usePresence();
  const t = useTranslations();

  // Localized type-eyebrow labels (e.g. zh 想法/提案/任务/文档). The painter is a
  // plain function and can't call the t() hook, so resolve the four labels here
  // and pass them down — keeps the canvas eyebrow on the same i18n contract as
  // the mobile outline (which uses t(`graph.nodeType.${type}`)).
  const typeLabels = useMemo<Record<NodeType, string>>(
    () => ({
      idea: t("graph.nodeType.idea"),
      proposal: t("graph.nodeType.proposal"),
      task: t("graph.nodeType.task"),
      document: t("graph.nodeType.document"),
    }),
    [t],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState({ width: 800, height: 600 });

  const [hoverId, setHoverId] = useState<string | null>(null);

  // --- Hover tooltip (Tech Design D1/D2/D4) ---------------------------------
  // Additive overlay: the hovered node's full title + a status/type badge,
  // fetched on demand via useNodeDetail (debounced + cached). The anchor is a
  // screen-pixel position recomputed from the live rendered center + the view
  // transform on each paint while a node is hovered (see renderFrame). Stored as
  // state so the DOM tooltip re-renders as the camera/card moves. This is purely
  // additive — it does NOT touch hoverId-driven focusLineage below.
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

  // The hovered node + its type drive the tooltip's fetch-on-hover detail. The
  // hook is debounced + cached + abort-safe; passing null when nothing is
  // hovered clears it. The title shown comes straight from the node payload.
  const hoveredNode = hoverId ? nodeById.get(hoverId) ?? null : null;
  const { detail: hoverDetail, loading: hoverLoading } = useNodeDetail(
    hoverId,
    hoveredNode?.type ?? null,
  );

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

    // Clear.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG;
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
        opacity,
        scale,
        hoverId,
        selectedId,
        focusLineage,
        getPresence,
        typeLabels,
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
  }, [dims, links, treeParentById, hoverId, selectedId, focusLineage, getPresence, nodes, typeLabels]);

  const renderFrameRef = useRef(renderFrame);
  renderFrameRef.current = renderFrame;
  const scheduleRender = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => renderFrameRef.current());
  }, []);
  // expose to the layout effect (declared before it via hoisting of the const)

  // Repaint when presence / hover / selection / size change (these alter the
  // painted frame even when no tween is running).
  useEffect(() => {
    scheduleRender();
  }, [hoverId, selectedId, focusLineage, dims, getPresence, scheduleRender]);

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

  const handlePointerDown = useCallback((ev: React.PointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    dragRef.current = {
      startX: sx,
      startY: sy,
      origTx: viewRef.current.tx,
      origTy: viewRef.current.ty,
      moved: false,
    };
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (ev: React.PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
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
    [hitTest, screenToGraph, scheduleRender],
  );

  const handlePointerUp = useCallback(
    (ev: React.PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const drag = dragRef.current;
      dragRef.current = null;
      if (!rect) return;
      // A pan (moved) consumes the gesture; only a clean tap is a click.
      if (drag?.moved) return;

      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
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
      onNodeClick(hit.id, hit.type, onAff);
    },
    [hitTest, screenToGraph, onNodeClick],
  );

  const handleWheel = useCallback(
    (ev: React.WheelEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
      const v = viewRef.current;
      const factor = Math.exp(-ev.deltaY * 0.0015);
      const nextScale = Math.min(2.5, Math.max(0.2, v.scale * factor));
      // Zoom around the cursor: keep the graph point under the cursor fixed.
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

  return (
    <div ref={containerRef} className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none"
        style={{ width: dims.width, height: dims.height, cursor: hoverId ? "pointer" : "grab" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => setHoverId(null)}
        onWheel={handleWheel}
      />
      {/* Hover tooltip — a DOM overlay above the canvas (Tech Design D1).
          Mounts only while a node is hovered AND its anchor is resolved; the
          hook's debounce gives the short appear-delay, and a mouse-out
          (hoverId → null) unmounts it. pointer-events-none lives on the tooltip
          root so it never intercepts a canvas click. */}
      {hoveredNode && tooltipAnchor && (
        <NodeTooltip
          title={hoveredNode.title}
          type={hoveredNode.type}
          detail={hoverDetail}
          loading={hoverLoading}
          x={tooltipAnchor.x}
          y={tooltipAnchor.y}
        />
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
  opacity: number;
  scale: number;
  hoverId: string | null;
  selectedId: string | null;
  focusLineage: Set<string> | null;
  getPresence: ReturnType<typeof usePresence>["getPresence"];
  /** Localized type-eyebrow labels, resolved via t() in the component. */
  typeLabels: Record<NodeType, string>;
}

function paintNode(
  ctx: CanvasRenderingContext2D,
  node: ForceNode,
  center: { x: number; y: number },
  opts: PaintNodeOpts,
) {
  const {
    opacity,
    scale,
    hoverId,
    selectedId,
    focusLineage,
    getPresence,
    typeLabels,
  } = opts;
  const type = node.type;
  const color = TYPE_COLOR[type];

  // Lineage focus: when a node is focused, only its up/down-stream (ancestors to
  // the root + descendants + itself) stays fully opaque; everyone else dims. No
  // focus → everyone opaque.
  const inLineage = focusLineage ? focusLineage.has(node.id) : true;
  const focusAlpha = inLineage ? 1 : 0.18;
  const alpha = opacity * focusAlpha;

  const isSelected = node.id === selectedId;
  const isHovered = node.id === hoverId;

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
    // acting agent" in BOTH renderers — the mobile outline shows a name pill,
    // so the canvas paints the agent's name on a colored chip above the card).
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
  ctx.fillStyle = "#FFFFFF";
  ctx.strokeStyle = isSelected ? color : "#EAE4DB";
  ctx.lineWidth = isSelected ? 2 : 1;
  roundRect(ctx, left, top, CARD_W, CARD_H, CARD_R);
  ctx.fill();
  ctx.stroke();

  // Type chip.
  const chipX = left + 8;
  const chipY = center.y - CHIP / 2;
  ctx.fillStyle = color;
  roundRect(ctx, chipX, chipY, CHIP, CHIP, 9);
  ctx.fill();
  // Lucide icon inside the chip (stroked white), replacing the old emoji glyph.
  paintLucideIcon(ctx, TYPE_ICON_PATHS[type], chipX, chipY, CHIP);

  // Text column. Reserve the right BTN_W strip for the +/- button on hubs.
  const hasBtn = !!node.hasAffordance;
  const textX = chipX + CHIP + 10;
  const contentRight = left + CARD_W - (hasBtn ? BTN_W : 12);
  const textW = contentRight - textX;
  // Eyebrow (localized type label — matches the mobile outline's
  // t(`graph.nodeType.${type}`), so a zh user sees 想法/提案/任务/文档).
  ctx.textAlign = "left";
  ctx.fillStyle = color;
  ctx.font = "600 9px ui-monospace, monospace";
  ctx.fillText(typeLabels[type], textX, center.y - 8);
  // Title (truncated to the text column width).
  ctx.fillStyle = "#2C2C2C";
  ctx.font = "500 12px ui-sans-serif, system-ui";
  ctx.fillText(truncate(ctx, node.title, textW - 4), textX, center.y + 7);

  // Expand/collapse button — a dedicated, easy-to-hit control on the right.
  if (hasBtn) {
    const btnLeft = left + CARD_W - BTN_W;
    // Divider.
    ctx.strokeStyle = "#EFEAE2";
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
// with a small inset and stroked white (round cap/join, matching lucide's
// default 2px stroke scaled to the chip).
function paintLucideIcon(
  ctx: CanvasRenderingContext2D,
  paths: string[],
  chipX: number,
  chipY: number,
  chip: number,
) {
  const inset = chip * 0.22; // padding inside the chip
  const drawn = chip - inset * 2; // glyph box edge
  const scale = drawn / 24; // lucide viewBox is 24×24
  ctx.save();
  ctx.translate(chipX + inset, chipY + inset);
  ctx.scale(scale, scale);
  ctx.strokeStyle = "#FFFFFF";
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
function fitToView(
  layout: ReturnType<typeof computeTreeLayout>,
  dims: { width: number; height: number },
  viewRef: React.MutableRefObject<ViewTransform>,
) {
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
  if (!Number.isFinite(minX)) return;
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
  viewRef.current = {
    scale,
    tx: dims.width / 2 - cx * scale,
    ty: dims.height / 2 - cy * scale,
  };
}
