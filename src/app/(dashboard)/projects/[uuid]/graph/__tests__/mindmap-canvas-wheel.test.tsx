// @vitest-environment jsdom
//
// Trackpad wheel-gesture coverage for MindMapCanvas (Task: "Canvas: trackpad
// wheel classifier + non-passive listener", Spec Delta "Trackpad two-finger pan
// and pinch-zoom on the canvas"). Two layers, mirroring mindmap-canvas-touch:
//
//   1. Pure math — `classifyWheel` is an exported pure helper, so the
//      pan/pinch/mouse-zoom heuristic is asserted directly without a canvas:
//      ctrl+wheel → zoom, horizontal wheel → pan, fine pixel vertical → pan,
//      coarse/line vertical → zoom, and the zoom scaleFactor sign.
//
//   2. Behavior — a mounted canvas is driven with a native (non-passive) wheel
//      event to prove (a) the listener calls preventDefault so the page does not
//      scroll, and (b) a ctrl+wheel zoom mutates the view transform scale.
//
// Canvas 2D is mocked the same way as mindmap-canvas-touch.test.tsx.

import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";

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

// Records the horizontal scale of every setTransform(a, …) call — the painter
// writes `dpr * view.scale` as `a`, so with dpr=1 the last recorded value is
// the live view scale.
const setTransformScales: number[] = [];

function stubCanvas2D(): CanvasRenderingContext2D {
  const ctx = {
    setTransform: (a?: number) => {
      if (typeof a === "number") setTransformScales.push(a);
    },
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
  vi.useFakeTimers();
  setTransformScales.length = 0;
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
    return setTimeout(() => cb(0), 0) as unknown as number;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  HTMLCanvasElement.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 800;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return 600;
    },
  });
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

import {
  MindMapCanvas,
  classifyWheel,
  type ForceNode,
} from "../mindmap-canvas";

describe("classifyWheel (pure) — Q2=a / Q3=a pan vs zoom heuristic", () => {
  it("ctrl+wheel (trackpad pinch OR Ctrl/⌘+wheel) → zoom", () => {
    const g = classifyWheel({ ctrlKey: true, deltaX: 0, deltaY: -10, deltaMode: 0 });
    expect(g.kind).toBe("zoom");
    if (g.kind === "zoom") expect(g.scaleFactor).toBeGreaterThan(1); // scroll up = zoom in
  });

  it("a wheel event with a horizontal component → pan", () => {
    const g = classifyWheel({ ctrlKey: false, deltaX: 40, deltaY: 5, deltaMode: 0 });
    expect(g).toEqual({ kind: "pan", dx: 40, dy: 5 });
  });

  it("a fine pixel-mode vertical wheel (below the mouse-notch threshold) → pan", () => {
    const g = classifyWheel({ ctrlKey: false, deltaX: 0, deltaY: 12, deltaMode: 0 });
    expect(g).toEqual({ kind: "pan", dx: 0, dy: 12 });
  });

  it("a coarse pixel-mode vertical wheel (at/above the threshold) → zoom (mouse notch)", () => {
    const g = classifyWheel({ ctrlKey: false, deltaX: 0, deltaY: 120, deltaMode: 0 });
    expect(g.kind).toBe("zoom");
    if (g.kind === "zoom") expect(g.scaleFactor).toBeLessThan(1); // scroll down = zoom out
  });

  it("a line-mode vertical wheel → zoom (classic mouse wheel)", () => {
    const g = classifyWheel({ ctrlKey: false, deltaX: 0, deltaY: -3, deltaMode: 1 });
    expect(g.kind).toBe("zoom");
    if (g.kind === "zoom") expect(g.scaleFactor).toBeGreaterThan(1);
  });

  it("zoom scaleFactor sign matches scroll direction", () => {
    const inGesture = classifyWheel({ ctrlKey: true, deltaX: 0, deltaY: -20, deltaMode: 0 });
    const outGesture = classifyWheel({ ctrlKey: true, deltaX: 0, deltaY: 20, deltaMode: 0 });
    if (inGesture.kind === "zoom") expect(inGesture.scaleFactor).toBeGreaterThan(1);
    if (outGesture.kind === "zoom") expect(outGesture.scaleFactor).toBeLessThan(1);
  });
});

function buildNodes(): ForceNode[] {
  return [{ id: "idea-1", type: "idea", title: "Idea one", status: "building" }];
}

describe("MindMapCanvas — native non-passive wheel listener", () => {
  it("calls preventDefault so the page does not scroll during a gesture", () => {
    const { container } = render(
      <MindMapCanvas nodes={buildNodes()} links={[]} selectedId={null} onNodeClick={vi.fn()} />,
    );
    const canvas = container.querySelector("canvas")!;
    act(() => {
      vi.advanceTimersByTime(50); // settle the one-time fit
    });
    const ev = new WheelEvent("wheel", {
      deltaX: 30,
      deltaY: 0,
      ctrlKey: false,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      canvas.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
  });

  it("a ctrl+wheel zoom mutates the view transform scale", () => {
    const { container } = render(
      <MindMapCanvas nodes={buildNodes()} links={[]} selectedId={null} onNodeClick={vi.fn()} />,
    );
    const canvas = container.querySelector("canvas")!;
    act(() => {
      vi.advanceTimersByTime(50);
    });
    const scaleBefore = setTransformScales.at(-1)!;
    expect(Number.isFinite(scaleBefore)).toBe(true);
    act(() => {
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: 0,
          deltaY: -100, // scroll up with ctrl → zoom in
          ctrlKey: true,
          clientX: 400,
          clientY: 300,
          cancelable: true,
          bubbles: true,
        }),
      );
      vi.advanceTimersByTime(50); // let the repaint run
    });
    const scaleAfter = setTransformScales.at(-1)!;
    expect(scaleAfter).toBeGreaterThan(scaleBefore);
  });
});

describe("MindMapCanvas — on-screen zoom / fit control cluster (Q4=a)", () => {
  it("renders zoom-in / zoom-out / fit controls with accessible labels when there are nodes", () => {
    const { getByTestId } = render(
      <MindMapCanvas nodes={buildNodes()} links={[]} selectedId={null} onNodeClick={vi.fn()} />,
    );
    // The mocked useTranslations returns the key, so aria-label === the i18n key.
    expect(getByTestId("graph-zoom-in").getAttribute("aria-label")).toBe("graph.zoom.in");
    expect(getByTestId("graph-zoom-out").getAttribute("aria-label")).toBe("graph.zoom.out");
    expect(getByTestId("graph-zoom-fit").getAttribute("aria-label")).toBe("graph.zoom.fit");
  });

  it("hides the control cluster when the graph is empty", () => {
    const { queryByTestId } = render(
      <MindMapCanvas nodes={[]} links={[]} selectedId={null} onNodeClick={vi.fn()} />,
    );
    expect(queryByTestId("graph-zoom-in")).toBeNull();
    expect(queryByTestId("graph-zoom-fit")).toBeNull();
  });

  it("zoom-in raises the view scale and zoom-out lowers it (centered on the viewport)", () => {
    const { getByTestId } = render(
      <MindMapCanvas nodes={buildNodes()} links={[]} selectedId={null} onNodeClick={vi.fn()} />,
    );
    act(() => {
      vi.advanceTimersByTime(50); // settle the one-time fit
    });
    const scaleAfterFit = setTransformScales.at(-1)!;
    act(() => {
      fireEvent.click(getByTestId("graph-zoom-in"));
      vi.advanceTimersByTime(50);
    });
    const scaleAfterZoomIn = setTransformScales.at(-1)!;
    expect(scaleAfterZoomIn).toBeGreaterThan(scaleAfterFit);
    act(() => {
      fireEvent.click(getByTestId("graph-zoom-out"));
      fireEvent.click(getByTestId("graph-zoom-out"));
      vi.advanceTimersByTime(50);
    });
    const scaleAfterZoomOut = setTransformScales.at(-1)!;
    expect(scaleAfterZoomOut).toBeLessThan(scaleAfterZoomIn);
  });

  it("fit re-frames the tree back toward the first-load fit scale", () => {
    const { getByTestId } = render(
      <MindMapCanvas nodes={buildNodes()} links={[]} selectedId={null} onNodeClick={vi.fn()} />,
    );
    act(() => {
      vi.advanceTimersByTime(50);
    });
    const scaleAfterFit = setTransformScales.at(-1)!;
    // Zoom in a couple of times, then fit — the scale should return to the fit.
    act(() => {
      fireEvent.click(getByTestId("graph-zoom-in"));
      fireEvent.click(getByTestId("graph-zoom-in"));
      vi.advanceTimersByTime(50);
    });
    expect(setTransformScales.at(-1)!).toBeGreaterThan(scaleAfterFit);
    act(() => {
      fireEvent.click(getByTestId("graph-zoom-fit"));
      vi.advanceTimersByTime(50);
    });
    expect(setTransformScales.at(-1)!).toBeCloseTo(scaleAfterFit, 5);
  });
});
