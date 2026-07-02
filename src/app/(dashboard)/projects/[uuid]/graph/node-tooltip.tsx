"use client";

// Resource-graph hover tooltip overlay (desktop). Tech Design D3.
//
// Title-only contract: a DOM element absolutely positioned over the canvas
// container that renders the hovered node's FULL (untruncated) title.
//
// Previously this overlay also showed a lifecycle-status badge (idea/proposal/
// task) or a document-type badge (document), fed by a debounced fetch-on-hover
// hook. Per Tech Design D3 the status now lives on the card itself (painted as
// a pill on the eyebrow row by the canvas painter), so the badge slot here is
// redundant. The tooltip is reduced to the one thing the card cannot already
// show — the full title — so a long, truncated card title can still be read in
// full on hover. There is no longer a per-entity fetch, no NodeDetail, and no
// loading state.
//
// Accessibility / behavior preserved from the previous revision:
//   - role="tooltip"
//   - pointer-events-none on the root (never intercepts a canvas click)
//   - absolute z-20, anchored beside the card via inline left/top
//   - the canvas only mounts this component while a node is hovered; on
//     mouse-out the canvas unmounts it, which clears the tooltip.

import type { ResourceGraphNodeType } from "@/services/resource-graph.service";

export type NodeType = ResourceGraphNodeType;

export interface NodeTooltipProps {
  /** The hovered node's full (untruncated) title — already known from the node payload. */
  title: string;
  /** Absolute screen position of the tooltip's top-left, in container pixels. */
  x: number;
  y: number;
}

export function NodeTooltip({ title, x, y }: NodeTooltipProps) {
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
    </div>
  );
}
