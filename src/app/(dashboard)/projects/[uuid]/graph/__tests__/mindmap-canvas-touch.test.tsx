// @vitest-environment jsdom
//
// Touch-gesture coverage for MindMapCanvas (Task A / Spec Delta requirement
// "Touch pinch, double-tap, and drag gestures on the canvas"). Two layers:
//
//   1. Pure math — `pinchTransform` and `fitTransformFor` are exported pure
//      helpers (like `centerTransformFor`), so the zoom/anchor math is asserted
//      directly without a canvas: midpoint-anchored scale, [0.2, 2.5] clamp,
//      and pan-to-follow-the-midpoint (map feel, Q2=a).
//
//   2. Behavior — a mounted canvas is driven with pointer events to prove a
//      two-finger gesture and a double-tap do NOT fire onNodeClick, while a
//      single touch tap on a node DOES (after the deferred-tap window).
//
// Canvas 2D is mocked the same way as mindmap-canvas.test.tsx.

import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, cleanup } from "@testing-library/react";

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
// the live view scale. Lets a behavioral test observe the double-tap zoom
// mutating the view transform (not just the pure helper math).
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
  // rAF drains synchronously via the fake timers (renderFrame is a no-op paint
  // against the stub ctx; we only care about the view math / click contract).
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    return setTimeout(() => cb(0), 0) as unknown as number;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  // getBoundingClientRect → origin at (0,0) so clientX/Y map 1:1 to canvas px.
  HTMLCanvasElement.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  // jsdom reports clientWidth/clientHeight as 0, which would collapse the
  // canvas `dims` state to {1,1} and make fitTransformFor's scale degenerate.
  // Give the container a real size so dims (and thus fit/zoom scale) is
  // deterministic across the behavioral tests.
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
  // Pointer capture APIs jsdom lacks.
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

afterEach(() => {
  // Unmount mounted components while the fake timers + rAF/caf stubs are still
  // installed — the canvas' unmount cleanup calls cancelAnimationFrame, which
  // would be gone if we restored real timers first.
  cleanup();
  vi.useRealTimers();
});

import {
  MindMapCanvas,
  pinchTransform,
  fitTransformFor,
  type ForceNode,
} from "../mindmap-canvas";

describe("pinchTransform (pure) — Q2=a midpoint anchor + pan-follow", () => {
  const startView = { scale: 1, tx: 0, ty: 0 };

  it("spreading the fingers zooms in by the distance ratio", () => {
    const out = pinchTransform(
      { midpoint: { x: 400, y: 300 }, dist: 100, view: startView },
      { midpoint: { x: 400, y: 300 }, dist: 200 },
    );
    expect(out.scale).toBeCloseTo(2, 5); // 1 * 200/100
    // Midpoint unchanged → the graph point under it stays fixed.
    expect(out.tx).toBeCloseTo(400 - 400 * 2, 5);
    expect(out.ty).toBeCloseTo(300 - 300 * 2, 5);
  });

  it("pinching the fingers together zooms out", () => {
    const out = pinchTransform(
      { midpoint: { x: 400, y: 300 }, dist: 200, view: startView },
      { midpoint: { x: 400, y: 300 }, dist: 100 },
    );
    expect(out.scale).toBeCloseTo(0.5, 5);
  });

  it("clamps scale to [0.2, 2.5] like the wheel path", () => {
    const zoomedWayIn = pinchTransform(
      { midpoint: { x: 0, y: 0 }, dist: 10, view: startView },
      { midpoint: { x: 0, y: 0 }, dist: 1000 },
    );
    expect(zoomedWayIn.scale).toBe(2.5);
    const zoomedWayOut = pinchTransform(
      { midpoint: { x: 0, y: 0 }, dist: 1000, view: startView },
      { midpoint: { x: 0, y: 0 }, dist: 1 },
    );
    expect(zoomedWayOut.scale).toBe(0.2);
  });

  it("pans to follow the midpoint (map feel) — moving fingers at constant distance translates the view", () => {
    const out = pinchTransform(
      { midpoint: { x: 400, y: 300 }, dist: 100, view: startView },
      { midpoint: { x: 500, y: 350 }, dist: 100 }, // same dist → scale 1, pure pan
    );
    expect(out.scale).toBeCloseTo(1, 5);
    // Graph point (400,300) under start midpoint should now sit under (500,350).
    expect(out.tx).toBeCloseTo(100, 5); // 500 - 400*1
    expect(out.ty).toBeCloseTo(50, 5); // 350 - 300*1
  });
});

describe("fitTransformFor (pure)", () => {
  it("returns null for an empty layout and a finite transform otherwise", () => {
    expect(fitTransformFor({ positions: new Map() } as never, { width: 800, height: 600 })).toBeNull();
    const t = fitTransformFor(
      { positions: new Map([["a", { x: 0, y: 0 }]]) } as never,
      { width: 800, height: 600 },
    );
    expect(t).not.toBeNull();
    expect(Number.isFinite(t!.scale)).toBe(true);
  });
});

function buildNodes(): ForceNode[] {
  return [{ id: "idea-1", type: "idea", title: "Idea one", status: "building" }];
}

describe("MindMapCanvas — touch gesture click contract", () => {
  it("a two-finger gesture does not fire onNodeClick", () => {
    const onNodeClick = vi.fn();
    const { container } = render(
      <MindMapCanvas nodes={buildNodes()} links={[]} selectedId={null} onNodeClick={onNodeClick} />,
    );
    const canvas = container.querySelector("canvas")!;
    act(() => {
      fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: "touch", clientX: 380, clientY: 300 });
      fireEvent.pointerDown(canvas, { pointerId: 2, pointerType: "touch", clientX: 420, clientY: 300 });
      // Spread the two fingers.
      fireEvent.pointerMove(canvas, { pointerId: 2, pointerType: "touch", clientX: 520, clientY: 300 });
      fireEvent.pointerUp(canvas, { pointerId: 2, pointerType: "touch", clientX: 520, clientY: 300 });
      fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: "touch", clientX: 380, clientY: 300 });
      vi.advanceTimersByTime(400); // flush any deferred tap
    });
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it("a double-tap does not fire onNodeClick (zoom instead)", () => {
    const onNodeClick = vi.fn();
    const { container } = render(
      <MindMapCanvas nodes={buildNodes()} links={[]} selectedId={null} onNodeClick={onNodeClick} />,
    );
    const canvas = container.querySelector("canvas")!;
    // Tap twice at the same spot within the double-tap window.
    act(() => {
      fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: "touch", clientX: 400, clientY: 300 });
      fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: "touch", clientX: 400, clientY: 300 });
    });
    act(() => {
      vi.advanceTimersByTime(100); // still inside DOUBLE_TAP_MS (300)
      fireEvent.pointerDown(canvas, { pointerId: 2, pointerType: "touch", clientX: 400, clientY: 300 });
      fireEvent.pointerUp(canvas, { pointerId: 2, pointerType: "touch", clientX: 400, clientY: 300 });
      vi.advanceTimersByTime(400); // flush — the first tap's deferred click must have been cancelled
    });
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it("a double-tap in empty space zooms the view in, then a second double-tap resets it (view transform changes)", () => {
    const onNodeClick = vi.fn();
    const { container } = render(
      <MindMapCanvas nodes={buildNodes()} links={[]} selectedId={null} onNodeClick={onNodeClick} />,
    );
    const canvas = container.querySelector("canvas")!;
    // Settle the one-time fit so the view is at the fit scale.
    act(() => {
      vi.advanceTimersByTime(50);
    });
    const scaleAfterFit = setTransformScales.at(-1)!;
    expect(Number.isFinite(scaleAfterFit)).toBe(true);

    // Double-tap in an empty corner (away from the centered node) → zoom IN.
    const tap = (id: number) => {
      fireEvent.pointerDown(canvas, { pointerId: id, pointerType: "touch", clientX: 60, clientY: 60 });
      fireEvent.pointerUp(canvas, { pointerId: id, pointerType: "touch", clientX: 60, clientY: 60 });
    };
    act(() => {
      tap(1);
      vi.advanceTimersByTime(80);
      tap(2);
      vi.advanceTimersByTime(50); // let the repaint run
    });
    const scaleAfterZoomIn = setTransformScales.at(-1)!;
    expect(scaleAfterZoomIn).toBeGreaterThan(scaleAfterFit);

    // A second double-tap (now zoomed in) resets back toward the fit scale.
    act(() => {
      tap(3);
      vi.advanceTimersByTime(80);
      tap(4);
      vi.advanceTimersByTime(50);
    });
    const scaleAfterReset = setTransformScales.at(-1)!;
    expect(scaleAfterReset).toBeCloseTo(scaleAfterFit, 5);
    // No node click fired from any of the double-taps.
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it("a single touch tap on a node fires onNodeClick after the deferred window", () => {
    const onNodeClick = vi.fn();
    const { container } = render(
      <MindMapCanvas nodes={buildNodes()} links={[]} selectedId={null} onNodeClick={onNodeClick} />,
    );
    const canvas = container.querySelector("canvas")!;
    // Let the layout/anim settle so the node has a rendered rect to hit-test.
    act(() => {
      vi.advanceTimersByTime(50);
    });
    // Tap at the canvas center. The single root idea lays out at the fit center,
    // so a tap at (400,300) hits it. (The one-time fit centers content.)
    act(() => {
      fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: "touch", clientX: 400, clientY: 300 });
      fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: "touch", clientX: 400, clientY: 300 });
    });
    // Before the window elapses, the click is still deferred.
    expect(onNodeClick).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(350); // > DOUBLE_TAP_MS
    });
    expect(onNodeClick).toHaveBeenCalledTimes(1);
    expect(onNodeClick.mock.calls[0][0]).toBe("idea-1");
  });
});
