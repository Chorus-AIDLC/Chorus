// @vitest-environment jsdom
//
// Wheel-zoom coverage for MindMapCanvas (Spec Delta "Trackpad two-finger pan and
// pinch-zoom on the canvas", idea 9d326265 elaboration round 3 — "protect
// mouse-wheel zoom"). The canvas ALWAYS zooms on wheel — no device inference, no
// pan-on-wheel; panning is via drag. This file drives a native (non-passive)
// wheel event and asserts:
//   (a) a plain vertical mouse wheel ZOOMS (view scale changes) + preventDefaults,
//   (b) a ctrl+wheel (pinch / Ctrl-⌘) also zooms,
//   (c) scroll up zooms in / scroll down zooms out,
//   (d) a plain wheel does NOT pan (no translate-only change).
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
  type ForceNode,
} from "../mindmap-canvas";

function buildNodes(): ForceNode[] {
  return [{ id: "idea-1", type: "idea", title: "Idea one", status: "building" }];
}

function dispatchWheel(
  canvas: HTMLCanvasElement,
  init: Partial<WheelEventInit>,
): WheelEvent {
  const ev = new WheelEvent("wheel", {
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    ctrlKey: false,
    clientX: 400,
    clientY: 300,
    cancelable: true,
    bubbles: true,
    ...init,
  });
  act(() => {
    canvas.dispatchEvent(ev);
    vi.advanceTimersByTime(50); // let the repaint run
  });
  return ev;
}

describe("MindMapCanvas — wheel always zooms (protect mouse-wheel zoom)", () => {
  it("a plain vertical mouse wheel zooms (scale changes) and preventDefaults", () => {
    const { container } = render(
      <MindMapCanvas nodes={buildNodes()} links={[]} selectedId={null} onNodeClick={vi.fn()} />,
    );
    const canvas = container.querySelector("canvas")!;
    act(() => {
      vi.advanceTimersByTime(50); // settle the one-time fit
    });
    const scaleBefore = setTransformScales.at(-1)!;
    const ev = dispatchWheel(canvas, { deltaY: -100 }); // scroll up → zoom in
    expect(ev.defaultPrevented).toBe(true);
    expect(setTransformScales.at(-1)!).toBeGreaterThan(scaleBefore); // zoomed, not panned
  });

  it("a small, fractional vertical wheel still zooms (never pans)", () => {
    // A hi-res/smooth-scroll mouse reports small, fractional vertical deltas.
    // Under the always-zoom model that is unambiguously a zoom — the view SCALE
    // changes rather than translating.
    const { container } = render(
      <MindMapCanvas nodes={buildNodes()} links={[]} selectedId={null} onNodeClick={vi.fn()} />,
    );
    const canvas = container.querySelector("canvas")!;
    act(() => {
      vi.advanceTimersByTime(50);
    });
    const scaleBefore = setTransformScales.at(-1)!;
    const ev = dispatchWheel(canvas, { deltaY: -6.7 }); // small + fractional
    expect(ev.defaultPrevented).toBe(true);
    expect(setTransformScales.at(-1)!).toBeGreaterThan(scaleBefore);
  });

  it("a ctrl+wheel (pinch / Ctrl-⌘) also zooms", () => {
    const { container } = render(
      <MindMapCanvas nodes={buildNodes()} links={[]} selectedId={null} onNodeClick={vi.fn()} />,
    );
    const canvas = container.querySelector("canvas")!;
    act(() => {
      vi.advanceTimersByTime(50);
    });
    const scaleBefore = setTransformScales.at(-1)!;
    const ev = dispatchWheel(canvas, { deltaY: -100, ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(setTransformScales.at(-1)!).toBeGreaterThan(scaleBefore);
  });

  it("scroll up zooms in and scroll down zooms out", () => {
    const { container } = render(
      <MindMapCanvas nodes={buildNodes()} links={[]} selectedId={null} onNodeClick={vi.fn()} />,
    );
    const canvas = container.querySelector("canvas")!;
    act(() => {
      vi.advanceTimersByTime(50);
    });
    const scaleFit = setTransformScales.at(-1)!;
    dispatchWheel(canvas, { deltaY: -120 }); // up → in
    const scaleIn = setTransformScales.at(-1)!;
    expect(scaleIn).toBeGreaterThan(scaleFit);
    dispatchWheel(canvas, { deltaY: 120 }); // down → out
    const scaleOut = setTransformScales.at(-1)!;
    expect(scaleOut).toBeLessThan(scaleIn);
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
