"use client";

// Project Resource Graph — the *rendering* layer.
//
// This replaces the earlier static @xyflow/react + one-shot-d3-force canvas
// (which pre-solved positions with sim.tick(300) and never moved) with a
// LIVE, animated force-directed knowledge graph powered by
// `react-force-graph-2d` (Canvas 2D + d3-force-3d).
//
// What this layer owns (purely visual):
//   - the live force simulation + zoom/pan/drag
//   - custom node painting: rounded card, type-colored chip + icon glyph,
//     title, expand affordance ("N ›" / "⌄"), selection ring, and the
//     agent-presence ring (view = dashed, mutate = solid) reusing usePresence
//   - three edge kinds distinguished by color + arrowhead + an animated
//     directional particle (the "alive" flow)
//   - hover-to-focus: hovering a node highlights it + its direct neighbours
//     and dims the rest
//
// What it does NOT own (delegated up to ResourceGraph): data fetching, the
// expand/collapse visible-set, the four side panels, the type filter, and the
// SSE live-reconcile. It receives ready-to-render nodes/links + callbacks.
//
// SSR: react-force-graph-2d touches `window`/`document` at import time, so the
// PARENT (resource-graph.tsx) imports THIS module via next/dynamic with
// ssr:false. That lets us static-import ForceGraph2D here and keep a normal
// ref for imperative calls (zoomToFit, d3Force tuning).

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ForceGraph2D, {
  type ForceGraphMethods,
  type NodeObject,
  type LinkObject,
} from "react-force-graph-2d";
import { forceX, forceY, forceCollide } from "d3-force";

import { usePresence } from "@/hooks/use-presence";
import { getAgentColor } from "@/lib/agent-color";
import type {
  ResourceGraphNodeType as NodeType,
  ResourceGraphEdgeKind as EdgeKind,
} from "@/services/resource-graph.service";

// --- Visual tokens (design.pen "Chorus - Project Graph View") ---------------

const TYPE_COLOR: Record<NodeType, string> = {
  idea: "#7C4DFF",
  proposal: "#2563EB",
  task: "#E8833A",
  document: "#00897B",
};

// Single-glyph icon per type, drawn with the Material Symbols / emoji-free
// approach: we paint a simple unicode glyph in the chip. Canvas can't mount
// lucide React components, so we use compact vector-ish glyphs that read at a
// glance and match the lucide choices conceptually.
const TYPE_GLYPH: Record<NodeType, string> = {
  idea: "💡",
  proposal: "📋",
  task: "✓",
  document: "📄",
};

const EDGE_COLOR: Record<EdgeKind, string> = {
  derive: "#CFC6B6",
  lineage: "#7C4DFF",
  depends: "#E8833A",
};

// Canvas paint geometry (graph-space units; zoom scales them).
const CARD_W = 200;
const CARD_H = 46;
const CARD_R = 12;
const CHIP = 30;
// The expand/collapse control is a dedicated button occupying the right
// portion of the card — a big, easy-to-hit target (the small chevron was
// unclickable). BTN_W is its width; the click hit-test uses the same value.
const BTN_W = 40;

// --- Public data shapes (what ResourceGraph hands us) -----------------------

export interface ForceNode {
  id: string;
  type: NodeType;
  title: string;
  /** Hub-only (Idea or Proposal): number of direct children. */
  childCount?: number;
  /** Hub-only: whether currently expanded (drives +/− button glyph). */
  expanded?: boolean;
  /** True when this node should show an expand/collapse button. */
  hasAffordance?: boolean;
  /**
   * Nesting parent for the cluster force: a proposal's owner is its source
   * idea; a task/document's owner is its proposal. Idea hubs (+ orphans) have
   * none. Drives the per-tick tether that groups each idea's resources
   * around it so multiple expanded ideas don't blur together.
   */
  ownerId?: string;
}

export interface ForceLink {
  source: string;
  target: string;
  kind: EdgeKind;
}

interface ForceGraphCanvasProps {
  nodes: ForceNode[];
  links: ForceLink[];
  /** UUID of the currently-selected node (keeps a ring while a panel is open). */
  selectedId: string | null;
  /**
   * Click router. `onAffordance` is true when the pointer landed on the
   * expand/collapse pill/chevron region of an Idea hub (→ toggle) rather than
   * the card body (→ open panel).
   */
  onNodeClick: (id: string, type: NodeType, onAffordance: boolean) => void;
}

// react-force-graph mutates node objects in place (adds x/y/vx/vy). We keep a
// stable object identity per id across renders so the simulation doesn't reset
// positions when only derived fields (expanded/count) change.
type SimNode = NodeObject<ForceNode>;
type SimLink = LinkObject<ForceNode, { kind: EdgeKind }>;

export function ForceGraphCanvas({
  nodes,
  links,
  selectedId,
  onNodeClick,
}: ForceGraphCanvasProps) {
  const { getPresence } = usePresence();
  const fgRef = useRef<ForceGraphMethods<SimNode, SimLink> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 800, height: 600 });
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Persist sim node objects across renders, keyed by id, so positions are
  // retained when the node set changes (expand/collapse, live updates).
  const nodeObjsRef = useRef(new Map<string, SimNode>());

  const graphData = useMemo(() => {
    const map = nodeObjsRef.current;
    const aliveIds = new Set(nodes.map((n) => n.id));
    for (const key of Array.from(map.keys())) {
      if (!aliveIds.has(key)) map.delete(key);
    }
    const simNodes: SimNode[] = nodes.map((n) => {
      const existing = map.get(n.id);
      if (existing) {
        // Refresh derived display fields but keep x/y/vx/vy identity.
        existing.type = n.type;
        existing.title = n.title;
        existing.childCount = n.childCount;
        existing.expanded = n.expanded;
        existing.hasAffordance = n.hasAffordance;
        existing.ownerId = n.ownerId;
        return existing;
      }
      const created: SimNode = { ...n };
      map.set(n.id, created);
      return created;
    });
    const simLinks: SimLink[] = links.map((l) => ({
      source: l.source,
      target: l.target,
      kind: l.kind,
    }));
    return { nodes: simNodes, links: simLinks };
  }, [nodes, links]);

  // Neighbour adjacency for hover-focus (id → set of directly linked ids).
  const adjacency = useMemo(() => {
    const adj = new Map<string, Set<string>>();
    for (const n of nodes) adj.set(n.id, new Set());
    for (const l of links) {
      adj.get(l.source)?.add(l.target);
      adj.get(l.target)?.add(l.source);
    }
    return adj;
  }, [nodes, links]);

  // Track container size so the canvas fills the panel responsively.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setDims({ width: Math.floor(r.width), height: Math.floor(r.height) });
    });
    ro.observe(el);
    setDims({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Tune the live force simulation for an airy, non-overlapping, CLUSTERED
  // layout. The defining structural force is the per-tick "cluster tether"
  // (see clusterForce): every resource is gently pulled toward its owner hub
  // (task/doc → proposal → idea), so each idea's resources group around it.
  // Cross-cluster separation then falls out of the global charge for free —
  // two groups that drift together get pushed apart.
  //
  //  - moderate repulsion (too strong scatters disconnected components off
  //    to infinity; too weak lets clusters overlap)
  //  - per-kind link distance: lineage (idea→idea) is LONG so blood-related
  //    idea clusters sit adjacent, not merged; derive/depends are short so a
  //    cluster's own resources stay tight
  //  - rectangular collision (cards are wide) so nothing overlaps
  //  - cluster tether — the grouping force (owner-following, see below)
  //  - gentle x/y centering so the whole constellation stays framed (weaker
  //    now that clustering provides most of the cohesion)
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force("charge")?.strength(-480).distanceMax(700);
    fg.d3Force("link")
      ?.distance((l: SimLink) => (l.kind === "lineage" ? 260 : 120))
      .strength((l: SimLink) => (l.kind === "lineage" ? 0.12 : 0.35));
    fg.d3Force("collide", forceCollide(CARD_W * 0.6));
    fg.d3Force("cluster", clusterForce(0.85));
    fg.d3Force("x", forceX(0).strength(0.035));
    fg.d3Force("y", forceY(0).strength(0.045));
    fg.d3ReheatSimulation();
  }, [graphData]);

  // Frame the whole graph once it settles, and whenever the node count changes.
  const handleEngineStop = useCallback(() => {
    fgRef.current?.zoomToFit(500, 90);
  }, []);

  // Also fit shortly after the data changes (expand/collapse adds/removes
  // nodes) — engine-stop alone can lag a frame behind a fresh node set.
  useEffect(() => {
    const id = setTimeout(() => fgRef.current?.zoomToFit(500, 90), 900);
    return () => clearTimeout(id);
  }, [graphData, dims]);

  // --- Node painter ---------------------------------------------------------
  const paintNode = useCallback(
    (node: SimNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const type = node.type;
      const color = TYPE_COLOR[type];

      // Hover focus: when something is hovered, the hovered node + its
      // neighbours are fully opaque; everyone else dims.
      const focused = hoverId
        ? node.id === hoverId || adjacency.get(hoverId)?.has(node.id)
        : true;
      const alpha = focused ? 1 : 0.18;
      const isSelected = node.id === selectedId;
      const isHovered = node.id === hoverId;

      const left = x - CARD_W / 2;
      const top = y - CARD_H / 2;

      ctx.save();
      ctx.globalAlpha = alpha;

      // Presence ring (reuse the same view=dashed / mutate=solid convention as
      // PresenceIndicator). Painted as an outer glowing stroke so it reads on
      // the canvas. Drawn first so the card sits on top of its glow.
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
      }

      // Soft type-colored glow behind the card on hover/selection — the
      // "emotional value" lift.
      if (isHovered || isSelected) {
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = isHovered ? 26 : 16;
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha * 0.0; // shadow only, no visible fill
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
      const chipY = y - CHIP / 2;
      ctx.fillStyle = color;
      roundRect(ctx, chipX, chipY, CHIP, CHIP, 9);
      ctx.fill();
      // Glyph inside chip.
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `${type === "task" ? 16 : 14}px ui-sans-serif, system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(TYPE_GLYPH[type], chipX + CHIP / 2, chipY + CHIP / 2 + 0.5);

      // Text column. When the node is an expandable hub, reserve the right
      // BTN_W strip for the +/- button so the title never runs under it.
      const hasBtn = !!node.hasAffordance;
      const textX = chipX + CHIP + 10;
      const contentRight = left + CARD_W - (hasBtn ? BTN_W : 12);
      const textW = contentRight - textX;
      // Eyebrow (type label).
      ctx.textAlign = "left";
      ctx.fillStyle = color;
      ctx.font = "600 9px ui-monospace, monospace";
      ctx.fillText(type.toUpperCase(), textX, y - 8);
      // Title (truncated to the text column width).
      ctx.fillStyle = "#2C2C2C";
      ctx.font = "500 12px ui-sans-serif, system-ui";
      ctx.fillText(truncate(ctx, node.title, textW - 4), textX, y + 7);

      // Expand/collapse button — a dedicated, easy-to-hit control occupying the
      // right BTN_W of the card (the old tiny chevron was unclickable). A
      // hairline divider separates it from the text; a tinted square holds a
      // big +/- glyph and, when collapsed, the child count below it.
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
        roundRect(
          ctx,
          btnLeft + 4,
          top + 6,
          BTN_W - 10,
          CARD_H - 12,
          8,
        );
        ctx.fill();
        const bx = btnLeft + BTN_W / 2 - 1;
        const collapsed = !node.expanded;
        const count = node.childCount ?? 0;
        // +/- glyph, drawn as strokes (crisp at any zoom).
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        const gy = collapsed && count > 0 ? y - 4 : y; // lift glyph to make room for count
        const arm = 5;
        ctx.beginPath();
        ctx.moveTo(bx - arm, gy);
        ctx.lineTo(bx + arm, gy);
        if (collapsed) {
          // vertical stroke → "+"
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
          ctx.fillText(`${count}`, bx, y + 9);
        }
      }

      ctx.restore();
      void globalScale;
    },
    [hoverId, adjacency, selectedId, getPresence],
  );

  // Pointer hit area = the full card rectangle.
  const paintPointerArea = useCallback(
    (node: SimNode, paintColor: string, ctx: CanvasRenderingContext2D) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      ctx.fillStyle = paintColor;
      roundRect(ctx, x - CARD_W / 2, y - CARD_H / 2, CARD_W, CARD_H, CARD_R);
      ctx.fill();
    },
    [],
  );

  const handleClick = useCallback(
    (node: SimNode, event: MouseEvent) => {
      // Determine whether the click landed on the +/- button (the right BTN_W
      // strip of the card). Translate the screen click into graph coords and
      // test against the button zone — the same geometry the painter uses.
      let onAff = false;
      if (node.hasAffordance && fgRef.current) {
        const gc = fgRef.current.screen2GraphCoords(event.offsetX, event.offsetY);
        const right = (node.x ?? 0) + CARD_W / 2;
        if (
          gc.x >= right - BTN_W &&
          Math.abs(gc.y - (node.y ?? 0)) <= CARD_H / 2
        ) {
          onAff = true;
        }
      }
      onNodeClick(node.id, node.type, onAff);
    },
    [onNodeClick],
  );

  return (
    <div ref={containerRef} className="absolute inset-0">
      <ForceGraph2D<ForceNode, { kind: EdgeKind }>
        ref={fgRef}
        graphData={graphData}
        width={dims.width}
        height={dims.height}
        backgroundColor="#FAF8F4"
        nodeRelSize={1}
        nodeVal={() => 40}
        nodeCanvasObject={paintNode}
        nodePointerAreaPaint={paintPointerArea}
        onNodeClick={handleClick}
        onNodeHover={(n) => setHoverId(n ? (n as SimNode).id : null)}
        onNodeDragEnd={(n) => {
          // Pin the node where the user dropped it (sticky layout).
          (n as SimNode).fx = (n as SimNode).x;
          (n as SimNode).fy = (n as SimNode).y;
        }}
        linkColor={(l) => {
          const kind = (l as SimLink).kind;
          const base = EDGE_COLOR[kind];
          if (!hoverId) return base;
          const s = linkEndId((l as SimLink).source);
          const t = linkEndId((l as SimLink).target);
          const touches = s === hoverId || t === hoverId;
          return touches ? base : hexWithAlpha(base, 0.12);
        }}
        linkWidth={(l) => {
          const s = linkEndId((l as SimLink).source);
          const t = linkEndId((l as SimLink).target);
          return hoverId && (s === hoverId || t === hoverId) ? 2.5 : 1.4;
        }}
        linkDirectionalArrowLength={5}
        linkDirectionalArrowRelPos={1}
        linkDirectionalArrowColor={(l) => EDGE_COLOR[(l as SimLink).kind]}
        linkDirectionalParticles={(l) => {
          const s = linkEndId((l as SimLink).source);
          const t = linkEndId((l as SimLink).target);
          return hoverId && (s === hoverId || t === hoverId) ? 3 : 1;
        }}
        linkDirectionalParticleWidth={2.5}
        linkDirectionalParticleColor={(l) => EDGE_COLOR[(l as SimLink).kind]}
        linkDirectionalParticleSpeed={0.006}
        cooldownTicks={120}
        onEngineStop={handleEngineStop}
        d3VelocityDecay={0.32}
      />
    </div>
  );
}

// --- cluster tether force ---------------------------------------------------
//
// A custom d3-force that, each tick, nudges every node with an `ownerId`
// toward its owner node's CURRENT position. Because d3-force's built-in
// forceX/forceY take a fixed target (sampled once), they can't follow a
// moving owner — so grouping around a live, drifting idea hub needs this
// hand-written force. Owners resolve transitively: a task tethers to its
// proposal, which itself tethers to its idea, yielding nested two-level
// clusters. Strength scales with alpha (standard d3 idiom) so it relaxes as
// the simulation cools.
type SimNodeWithVel = NodeObject<ForceNode> & {
  vx?: number;
  vy?: number;
};

function clusterForce(strength: number) {
  let nodes: SimNodeWithVel[] = [];
  let byId = new Map<string, SimNodeWithVel>();

  const force = (alpha: number) => {
    const k = strength * alpha;
    for (const n of nodes) {
      const ownerId = n.ownerId;
      if (!ownerId) continue;
      const owner = byId.get(ownerId);
      if (!owner || owner === n) continue;
      const ox = owner.x ?? 0;
      const oy = owner.y ?? 0;
      n.vx = (n.vx ?? 0) + (ox - (n.x ?? 0)) * k;
      n.vy = (n.vy ?? 0) + (oy - (n.y ?? 0)) * k;
    }
  };

  force.initialize = (ns: SimNodeWithVel[]) => {
    nodes = ns;
    byId = new Map(ns.map((n) => [n.id, n]));
  };

  return force;
}

// --- canvas helpers ---------------------------------------------------------

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

function truncate(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
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

// react-force-graph replaces link.source/target with the node OBJECT after the
// first tick; before that they're id strings. Normalize to an id.
function linkEndId(
  end: string | number | NodeObject<ForceNode> | undefined,
): string | undefined {
  if (end == null) return undefined;
  return typeof end === "object" ? end.id : String(end);
}
