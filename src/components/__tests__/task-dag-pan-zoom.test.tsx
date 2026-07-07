// @vitest-environment jsdom
//
// Regression guard for the shared trackpad pan/zoom config on the ReactFlow
// task-dependency DAG (Task: "ReactFlow DAG: shared trackpad pan-on-scroll
// config on the two full-canvas mounts", Spec Delta "task-dag-navigation").
//
// Three checks, matching the tech design's "no behavioral ReactFlow simulation
// — assert the shared props are applied" strategy (Decision 4 / D3.0):
//   1. DAG_PAN_ZOOM_PROPS has the exact intended shape (Figma model).
//   2. The readonly dashboard-preview <ReactFlow> in TaskDag does NOT receive
//      the pan-on-scroll props — it keeps its own inline zoomOnScroll (the
//      BLOCKER-fix regression guard: applying zoomOnScroll=false to a mount
//      that hides <Controls> would strip its only zoom path).
//   3. The two in-scope mounts (dag-view.tsx, proposal-editor.tsx) spread
//      {...DAG_PAN_ZOOM_PROPS} into their <ReactFlow> (guards a future edit
//      dropping the shared spread).

import React from "react";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

// Capture the props handed to <ReactFlow> so we can assert what the readonly
// TaskDag preview passes (and does not pass).
const reactFlowProps: Array<Record<string, unknown>> = [];

vi.mock("@xyflow/react", () => ({
  // ReactFlow records its props and renders its children so <Controls> gating
  // stays observable if needed.
  ReactFlow: (props: Record<string, unknown>) => {
    reactFlowProps.push(props);
    return React.createElement("div", { "data-testid": "reactflow" }, props.children as React.ReactNode);
  },
  Background: () => null,
  Controls: () => React.createElement("div", { "data-testid": "controls" }),
  Handle: () => null,
  Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
  PanOnScrollMode: { Free: "free", Vertical: "vertical", Horizontal: "horizontal" },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

beforeEach(() => {
  reactFlowProps.length = 0;
});

afterEach(() => {
  cleanup();
});

import { TaskDag, DAG_PAN_ZOOM_PROPS } from "../task-dag";

describe("DAG_PAN_ZOOM_PROPS — shared Figma-model config", () => {
  it("has the exact intended shape", () => {
    expect(DAG_PAN_ZOOM_PROPS).toEqual({
      panOnScroll: true,
      panOnScrollMode: "free",
      zoomOnScroll: false,
      zoomOnPinch: true,
      zoomActivationKeyCode: ["Meta", "Control"],
      panOnDrag: true,
    });
  });
});

describe("TaskDag readonly dashboard preview — excluded from pan-on-scroll", () => {
  it("does NOT receive panOnScroll and keeps its own inline zoomOnScroll=true", () => {
    render(
      <TaskDag
        readonly
        tasks={[{ uuid: "t1", title: "T1", status: "open", priority: "high" }]}
        edges={[]}
      />,
    );
    expect(reactFlowProps).toHaveLength(1);
    const props = reactFlowProps[0];
    // The BLOCKER-fix invariant: the readonly preview must NOT be switched to
    // pan-on-scroll (it hides <Controls>, so it would lose its only zoom path).
    expect(props.panOnScroll).toBeUndefined();
    expect(props.zoomOnScroll).toBe(true); // its own inline value, unchanged
  });
});

describe("the two in-scope mounts spread {...DAG_PAN_ZOOM_PROPS}", () => {
  const mounts = [
    "app/(dashboard)/projects/[uuid]/tasks/dag-view.tsx",
    "app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/proposal-editor.tsx",
  ];
  for (const rel of mounts) {
    it(`${rel} imports and spreads the shared config`, () => {
      const src = fs.readFileSync(path.join(process.cwd(), "src", rel), "utf8");
      expect(src).toContain("DAG_PAN_ZOOM_PROPS");
      expect(src).toContain("{...DAG_PAN_ZOOM_PROPS}");
    });
  }

  it("task-dag.tsx does NOT spread the config into its own preview ReactFlow", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "task-dag.tsx"),
      "utf8",
    );
    // It exports the const…
    expect(src).toContain("export const DAG_PAN_ZOOM_PROPS");
    // …but never spreads it (the readonly preview keeps its own inline props).
    expect(src).not.toContain("{...DAG_PAN_ZOOM_PROPS}");
  });
});
