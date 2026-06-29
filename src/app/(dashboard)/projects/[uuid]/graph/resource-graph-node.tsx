"use client";

// Custom @xyflow/react node renderer for the Project Resource Graph.
//
// Modeled on TaskNode in src/components/task-dag.tsx (NodeProps + Handle +
// Position from @xyflow/react 12) but adapted to the four-type resource
// graph: each node is a colored chip + lucide icon + IBM Plex Mono eyebrow
// type label + entity title, with NO status badge (q5 = type-only encoding).
//
// Per-Idea expand/collapse affordance:
//   - Idea collapsed → "N ›" pill (N = direct hidden derivative count).
//   - Idea expanded  → chevron-down icon.
//   - Task / Document / Proposal → no affordance (leaf w.r.t. the
//     expand model — only Ideas are hubs).
//
// The affordance is the WHOLE node click-zone: ReactFlow surfaces the click
// through `onNodeClick` on the parent canvas, so this component doesn't
// register its own handler — it just renders the right visual state. The
// parent decides whether to toggle expand or open a panel (e.g. a future
// node-click side-panel task may make idea clicks dual-purpose).
//
// Visual tokens come from docs/design.pen "Chorus - Project Graph View":
//   Idea     #7C4DFF / lightbulb
//   Proposal #2563EB / clipboard-list
//   Task     #E8833A / check-square
//   Document #00897B / file-text

import { useMemo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Lightbulb,
  ClipboardList,
  CheckSquare,
  FileText,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

export type ResourceGraphNodeType = "idea" | "proposal" | "task" | "document";

export interface ResourceGraphNodeData {
  type: ResourceGraphNodeType;
  title: string;
  /** Localized eyebrow label, e.g. "IDEA". */
  typeLabel: string;
  /**
   * Idea-only. `true` = the Idea is currently expanded (shows chevron-down);
   * `false` = collapsed (shows "N ›" pill). Ignored for non-Idea nodes.
   */
  expanded?: boolean;
  /**
   * Idea-only. Number of direct derivatives currently HIDDEN. Used in the
   * collapsed-pill label. Ignored for non-Idea nodes.
   */
  derivativeCount?: number;
  // Catch-all: @xyflow/react's Node<TData> requires `data` to be assignable
  // to Record<string, unknown>.
  [key: string]: unknown;
}

interface NodeTypeStyle {
  /** Background of the colored type-chip (full color, design.pen palette). */
  chipBg: string;
  /** Eyebrow text + icon color (full color). */
  accent: string;
  /** Icon component. */
  Icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}

const NODE_STYLES: Record<ResourceGraphNodeType, NodeTypeStyle> = {
  idea: { chipBg: "#7C4DFF", accent: "#7C4DFF", Icon: Lightbulb },
  proposal: { chipBg: "#2563EB", accent: "#2563EB", Icon: ClipboardList },
  task: { chipBg: "#E8833A", accent: "#E8833A", Icon: CheckSquare },
  document: { chipBg: "#00897B", accent: "#00897B", Icon: FileText },
};

const NODE_WIDTH = 220;

/**
 * Pure helper: should this node render an expand/collapse affordance?
 * Only Idea nodes with at least one direct derivative qualify. Exported so
 * the visible-set tests can assert leaf-detection symmetry with the
 * renderer.
 */
export function shouldShowExpandAffordance(
  type: ResourceGraphNodeType,
  derivativeCount: number | undefined,
): boolean {
  return type === "idea" && (derivativeCount ?? 0) > 0;
}

export function ResourceGraphNode({
  data,
  selected,
}: NodeProps<Node<ResourceGraphNodeData>>) {
  const style = NODE_STYLES[data.type];
  const Icon = style.Icon;

  const showAffordance = useMemo(
    () => shouldShowExpandAffordance(data.type, data.derivativeCount),
    [data.type, data.derivativeCount],
  );

  // The selection ring is rendered as a CSS outline so it doesn't shift
  // the node's layout when toggled. Mirrors how PresenceIndicator handles
  // the same problem in src/components/ui/presence-indicator.tsx.
  const outline = selected
    ? { outline: `2px solid ${style.accent}`, outlineOffset: "2px" }
    : undefined;

  return (
    <div
      className="rounded-[12px] bg-white px-3 py-2.5 shadow-sm flex items-center gap-2.5 border border-[#EAE4DB]"
      style={{ width: NODE_WIDTH, ...outline }}
      data-node-type={data.type}
      data-testid={`resource-node-${data.type}`}
    >
      {/* d3-force lays out nodes by their centers; the handle UI itself is
          invisible — xyflow just needs source/target anchors to draw edges
          between. Mirrors the pattern Wave 2's placeholder renderer used. */}
      <Handle
        type="target"
        position={Position.Top}
        className="!opacity-0 !pointer-events-none"
      />

      <div
        className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px]"
        style={{ backgroundColor: style.chipBg }}
      >
        <Icon className="h-4 w-4 text-white" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className="font-mono text-[10px] uppercase tracking-wider"
          style={{ color: style.accent }}
        >
          {data.typeLabel}
        </span>
        <span className="truncate text-xs font-medium text-[#2C2C2C]">
          {data.title}
        </span>
      </div>

      {showAffordance ? (
        data.expanded ? (
          <ChevronDown
            className="h-4 w-4 shrink-0"
            style={{ color: style.accent }}
            aria-label="expanded"
            data-testid="affordance-expanded"
          />
        ) : (
          // Collapsed pill: "N ›" — uses the type's accent color, set in a
          // small chip so it reads as a tappable affordance, not a label.
          <span
            className="inline-flex shrink-0 items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
            style={{ backgroundColor: `${style.accent}1A`, color: style.accent }}
            aria-label={`collapsed-${data.derivativeCount ?? 0}`}
            data-testid="affordance-collapsed"
          >
            {data.derivativeCount ?? 0}
            <ChevronRight className="h-3 w-3" aria-hidden />
          </span>
        )
      ) : null}

      <Handle
        type="source"
        position={Position.Bottom}
        className="!opacity-0 !pointer-events-none"
      />
    </div>
  );
}

// Stable node-types map (reference identity matters to ReactFlow — passing
// a fresh object on each render tears down node instances).
export const resourceGraphNodeTypes = { resource: ResourceGraphNode };

export const RESOURCE_GRAPH_NODE_WIDTH = NODE_WIDTH;
