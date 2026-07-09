// @vitest-environment jsdom
//
// Regression guard for the interactive ReactFlow task-dependency DAG's wheel
// behavior (Spec Delta "task-dag-navigation", idea 9d326265 elaboration round 3
// — "protect mouse-wheel zoom"). All three DAG mounts now use ReactFlow's
// default wheel-zoom: a plain wheel zooms around the cursor, a pinch zooms, and
// drag pans. There is no device inference, no pan-on-scroll, and no custom wheel
// listener — the classifier layer (dag-wheel-nav.tsx / wheel-gesture.ts) was
// removed.
//
// Checks:
//   1. The readonly dashboard-preview <ReactFlow> in TaskDag uses zoomOnScroll
//      (its long-standing config, now shared by all mounts).
//   2. The two interactive mounts (dag-view.tsx, proposal-editor.tsx) pass inline
//      zoomOnScroll:true + panOnDrag:true, and render neither <DagWheelNav/> nor
//      any panOnScroll / DAG_INTERACTIVE_PAN_ZOOM_PROPS.

import React from "react";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

// Capture the props handed to <ReactFlow> so we can assert the readonly
// TaskDag preview's wheel/drag config.
const reactFlowProps: Array<Record<string, unknown>> = [];

vi.mock("@xyflow/react", () => ({
  ReactFlow: (props: Record<string, unknown>) => {
    reactFlowProps.push(props);
    return React.createElement("div", { "data-testid": "reactflow" }, props.children as React.ReactNode);
  },
  Background: () => null,
  Controls: () => React.createElement("div", { "data-testid": "controls" }),
  Handle: () => null,
  Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
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

import { TaskDag } from "../task-dag";

describe("TaskDag readonly dashboard preview — default wheel-zoom", () => {
  it("uses zoomOnScroll and does not adopt pan-on-scroll", () => {
    render(
      <TaskDag
        readonly
        tasks={[{ uuid: "t1", title: "T1", status: "open", priority: "high" }]}
        edges={[]}
      />,
    );
    expect(reactFlowProps).toHaveLength(1);
    const props = reactFlowProps[0];
    expect(props.zoomOnScroll).toBe(true);
    expect(props.panOnScroll).toBeUndefined();
  });
});

describe("the two interactive mounts use ReactFlow default wheel-zoom", () => {
  const mounts = [
    "app/(dashboard)/projects/[uuid]/tasks/dag-view.tsx",
    "app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/proposal-editor.tsx",
  ];
  for (const rel of mounts) {
    it(`${rel} passes zoomOnScroll+panOnDrag and no custom wheel nav`, () => {
      const src = fs.readFileSync(path.join(process.cwd(), "src", rel), "utf8");
      expect(src).toContain("zoomOnScroll={true}");
      expect(src).toContain("panOnDrag={true}");
      // The classifier layer + the pan-on-scroll config are gone.
      expect(src).not.toContain("DagWheelNav");
      expect(src).not.toContain("DAG_INTERACTIVE_PAN_ZOOM_PROPS");
      expect(src).not.toContain("panOnScroll");
    });
  }
});
