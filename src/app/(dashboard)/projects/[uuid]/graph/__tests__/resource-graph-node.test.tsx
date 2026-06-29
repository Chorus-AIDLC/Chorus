// @vitest-environment jsdom
//
// Component tests for the resource-graph custom node renderer.
//
// Covers AC #1 (type→color/icon/eyebrow + no status badge) and the
// per-Idea affordance state from AC #2 (collapsed pill vs chevron vs none).
//
// @xyflow/react's <Handle/> needs ReactFlowProvider context to mount, so we
// mock the two surfaces we touch (Handle, Position) and let everything else
// render as plain DOM. This mirrors the agent-presence-pill test's approach
// of mocking out the data/context spines.

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock @xyflow/react: Handle becomes a no-op span, Position is a tiny enum
// constants object. Anything else this test reaches into would error loud,
// which is what we want.
vi.mock("@xyflow/react", () => ({
  Handle: ({ type }: { type: string }) => (
    <span data-testid={`handle-${type}`} hidden />
  ),
  Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
}));

import {
  ResourceGraphNode,
  type ResourceGraphNodeData,
} from "../resource-graph-node";

// Build a minimal NodeProps payload. Most fields are unused by the renderer
// (xyflow passes a lot of metadata); we only fill the surface we touch.
function makeProps(data: ResourceGraphNodeData, selected = false) {
  return {
    id: "n1",
    type: "resource",
    data,
    selected,
    isConnectable: false,
    xPos: 0,
    yPos: 0,
    dragging: false,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    // @xyflow/react's NodeProps signature is permissive; cast at the call
    // site to dodge the noisy intersection-type surface.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("ResourceGraphNode renderer", () => {
  it("renders an Idea with a chip + eyebrow label + title and no status badge", () => {
    render(
      <ResourceGraphNode
        {...makeProps({
          type: "idea",
          title: "Build a graph view",
          typeLabel: "IDEA",
          expanded: false,
          derivativeCount: 0,
        })}
      />,
    );

    expect(screen.getByText("IDEA")).toBeTruthy();
    expect(screen.getByText("Build a graph view")).toBeTruthy();
    // No status badge — only Ideas/Proposals/Tasks/Documents have a TYPE
    // label, never a status label. Any of these terms appearing on this
    // node would mean the renderer leaked status into the visual.
    expect(screen.queryByText(/open|in_progress|done|to_verify|assigned/i)).toBeNull();
  });

  it("Idea collapsed (count > 0) → 'N' pill + right chevron, no expanded chevron", () => {
    render(
      <ResourceGraphNode
        {...makeProps({
          type: "idea",
          title: "Idea X",
          typeLabel: "IDEA",
          expanded: false,
          derivativeCount: 3,
        })}
      />,
    );

    const pill = screen.getByTestId("affordance-collapsed");
    expect(pill).toBeTruthy();
    expect(pill.textContent).toContain("3");
    expect(screen.queryByTestId("affordance-expanded")).toBeNull();
  });

  it("Idea expanded → chevron-down, no collapsed pill", () => {
    render(
      <ResourceGraphNode
        {...makeProps({
          type: "idea",
          title: "Idea X",
          typeLabel: "IDEA",
          expanded: true,
          derivativeCount: 3,
        })}
      />,
    );

    expect(screen.getByTestId("affordance-expanded")).toBeTruthy();
    expect(screen.queryByTestId("affordance-collapsed")).toBeNull();
  });

  it("leaf Idea (count = 0) shows no affordance — pill nor chevron", () => {
    render(
      <ResourceGraphNode
        {...makeProps({
          type: "idea",
          title: "Lonely idea",
          typeLabel: "IDEA",
          expanded: false,
          derivativeCount: 0,
        })}
      />,
    );

    expect(screen.queryByTestId("affordance-collapsed")).toBeNull();
    expect(screen.queryByTestId("affordance-expanded")).toBeNull();
  });

  it("Task / Document / Proposal nodes show no affordance regardless of derivativeCount", () => {
    const types: Array<ResourceGraphNodeData["type"]> = ["task", "document", "proposal"];
    for (const type of types) {
      const { unmount } = render(
        <ResourceGraphNode
          {...makeProps({
            type,
            title: `${type} node`,
            typeLabel: type.toUpperCase(),
            // Even with a non-zero count smuggled in, non-Idea nodes
            // ignore it — only Ideas are hubs.
            derivativeCount: 5,
          })}
        />,
      );
      expect(screen.queryByTestId("affordance-collapsed")).toBeNull();
      expect(screen.queryByTestId("affordance-expanded")).toBeNull();
      expect(screen.getByText(type.toUpperCase())).toBeTruthy();
      unmount();
    }
  });

  it("encodes the entity type on the DOM (data-node-type) for each of the four kinds", () => {
    const cases: Array<{
      type: ResourceGraphNodeData["type"];
      label: string;
    }> = [
      { type: "idea", label: "IDEA" },
      { type: "proposal", label: "PROPOSAL" },
      { type: "task", label: "TASK" },
      { type: "document", label: "DOCUMENT" },
    ];
    for (const { type, label } of cases) {
      const { container, unmount } = render(
        <ResourceGraphNode
          {...makeProps({
            type,
            title: `${label} title`,
            typeLabel: label,
          })}
        />,
      );
      const node = container.querySelector(`[data-node-type="${type}"]`);
      expect(node).not.toBeNull();
      unmount();
    }
  });
});
