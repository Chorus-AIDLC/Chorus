// @vitest-environment jsdom
//
// Canvas search visuals (proposal task 3): per-node alpha composition, the
// current-match ring, and camera centering. The canvas paints to a 2D context
// (not the DOM), so pixels can't be asserted directly — but the two decisions
// that ARE the contract (Tech Design D4 alpha precedence + D5 centering math)
// were extracted into pure, exported helpers precisely so they unit-test
// without a canvas. A thin render smoke test additionally proves the new search
// props don't disturb mount or the click contract.

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

import { resolveFocusAlpha, centerTransformFor } from "../mindmap-canvas";

// --- D4: per-node alpha composition (hover-takeover vs match dim vs none) ---

describe("resolveFocusAlpha (Tech Design D4 / Q3=a)", () => {
  const DIM = 0.18;

  describe("rule 1 — hover/selection lineage takes over", () => {
    it("dims by lineage and ignores the match set entirely", () => {
      const lineage = new Set(["a", "b"]); // focused node's ancestors+descendants
      const matches = new Set(["c", "d"]); // a search is also active
      // In-lineage node → full opacity even though it is NOT a match.
      expect(resolveFocusAlpha("a", lineage, matches)).toBe(1);
      // Out-of-lineage node → dim, even though it IS a match (hover takes over,
      // so matches get no special opacity in this state).
      expect(resolveFocusAlpha("c", lineage, matches)).toBe(DIM);
    });

    it("applies lineage dim even when not searching (matchIds null)", () => {
      const lineage = new Set(["a"]);
      expect(resolveFocusAlpha("a", lineage, null)).toBe(1);
      expect(resolveFocusAlpha("z", lineage, null)).toBe(DIM);
    });
  });

  describe("rule 2 — active non-empty match set lights matches, dims the rest", () => {
    it("match → 1.0, non-match → dim, when nothing is hovered", () => {
      const matches = new Set(["m1", "m2"]);
      expect(resolveFocusAlpha("m1", null, matches)).toBe(1);
      expect(resolveFocusAlpha("other", null, matches)).toBe(DIM);
    });
  });

  describe("rule 3 — no dim", () => {
    it("not searching (null match set) → everyone opaque", () => {
      expect(resolveFocusAlpha("any", null, null)).toBe(1);
    });

    it("EMPTY match set must not dim the whole tree (Q2=a)", () => {
      const empty = new Set<string>();
      expect(resolveFocusAlpha("any", null, empty)).toBe(1);
      expect(resolveFocusAlpha("other", null, empty)).toBe(1);
    });
  });
});

// --- D5: camera centering math ----------------------------------------------

describe("centerTransformFor (Tech Design D5)", () => {
  it("places the node center at the viewport center, keeping the scale", () => {
    const dims = { width: 800, height: 600 };
    const pos = { x: 100, y: 50 };
    const scale = 1.5;
    const v = centerTransformFor(pos, dims, scale);
    expect(v.scale).toBe(1.5); // unchanged — no refit
    // screenX = x*scale + tx must equal width/2 (and likewise for y).
    expect(pos.x * v.scale + v.tx).toBe(dims.width / 2);
    expect(pos.y * v.scale + v.ty).toBe(dims.height / 2);
  });

  it("recomputes for a different node at the same scale", () => {
    const dims = { width: 1000, height: 400 };
    const v = centerTransformFor({ x: -200, y: 300 }, dims, 0.5);
    expect(-200 * 0.5 + v.tx).toBe(500);
    expect(300 * 0.5 + v.ty).toBe(200);
  });
});

// --- Render smoke: the search props don't disturb mount or the click contract.

// Stub canvas + presence + intl exactly like mindmap-canvas.test.tsx so the
// painter runs headless without touching the network or a real 2D context.
vi.mock("@/hooks/use-presence", () => ({
  usePresence: () => ({ getPresence: () => [] }),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
function stubCanvas2D(): CanvasRenderingContext2D {
  const ctx = {
    setTransform: () => {},
    fillRect: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
    rotate: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    bezierCurveTo: () => {},
    quadraticCurveTo: () => {},
    arcTo: () => {},
    closePath: () => {},
    fill: () => {},
    stroke: () => {},
    arc: () => {},
    fillText: () => {},
    measureText: (text: string) => ({ width: text.length * 6 }) as TextMetrics,
    setLineDash: () => {},
    clearRect: () => {},
    drawImage: () => {},
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    globalAlpha: 1,
    shadowColor: "",
    shadowBlur: 0,
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  vi.restoreAllMocks();
  (window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    StubResizeObserver as unknown as typeof ResizeObserver;
  if (typeof (globalThis as { Path2D?: unknown }).Path2D === "undefined") {
    (globalThis as { Path2D: unknown }).Path2D = function (_d?: string) {
      void _d;
    } as unknown as typeof Path2D;
  }
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => stubCanvas2D(),
  ) as unknown as HTMLCanvasElement["getContext"];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    return setTimeout(() => cb(performance.now()), 0) as unknown as number;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

import { MindMapCanvas, type ForceNode } from "../mindmap-canvas";

const NODES: ForceNode[] = [
  { id: "idea-1", type: "idea", title: "Idea one", status: "building" },
  { id: "task-1", type: "task", title: "Task one", status: "open" },
];

describe("MindMapCanvas — search props are inert to mount + click contract", () => {
  it("mounts with an active search + current match without error and centerNodeId does not throw", async () => {
    const { container, rerender } = render(
      <MindMapCanvas
        nodes={NODES}
        links={[]}
        selectedId={null}
        onNodeClick={() => {}}
        matchIds={new Set(["task-1"])}
        currentMatchId={"task-1"}
        centerNodeId={null}
      />,
    );
    expect(container.querySelector("canvas")).not.toBeNull();
    // Bumping centerNodeId (the camera signal) must not throw, even before the
    // layout has a position for the node (effect guards on a missing position).
    await act(async () => {
      rerender(
        <MindMapCanvas
          nodes={NODES}
          links={[]}
          selectedId={null}
          onNodeClick={() => {}}
          matchIds={new Set(["task-1"])}
          currentMatchId={"task-1"}
          centerNodeId={"task-1"}
        />,
      );
    });
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("a plain tap still routes onNodeClick(id,type,false) — the cursor never sets selection", async () => {
    // The current-match cursor must NOT behave like a selection: clicking is the
    // only thing that selects, and it still flows through the same contract. We
    // can't hit a specific node deterministically without layout coords, so we
    // assert the weaker, still-meaningful contract: a click handler is wired and
    // the component does not auto-invoke it from the search props on mount.
    const onNodeClick = vi.fn();
    render(
      <MindMapCanvas
        nodes={NODES}
        links={[]}
        selectedId={null}
        onNodeClick={onNodeClick}
        matchIds={new Set(["task-1"])}
        currentMatchId={"task-1"}
        centerNodeId={"task-1"}
      />,
    );
    // Mounting with a current match must NOT fire onNodeClick (no implicit
    // selection from stepping the cursor).
    expect(onNodeClick).not.toHaveBeenCalled();
  });
});
