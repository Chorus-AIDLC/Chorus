// @vitest-environment jsdom
//
// Canvas-level coverage for MindMapCanvas (Tech Design D2/D3 / AC #3 + AC #5).
//
// The canvas is a Canvas-2D painter, not a DOM renderer, so the test cannot
// directly assert on painted pixels. What it CAN — and must — assert is the
// contract that distinguishes T2's canvas from the previous revision:
//
//   1. No fetch-on-hover. Hovering a node previously triggered a per-entity
//      REST request (via the now-deleted useNodeDetail hook). With status on
//      the card payload, hover must issue zero network requests. (AC #3.)
//
//   2. The painter resolves status labels through the t() translator. Per
//      Tech Design D2, the painter receives a pure `statusLabels` resolver so
//      it stays i18n-driven — observable here as a t() call for each visible
//      node's `node-status.ts` labelKey.
//
// Canvas 2D is mocked: `HTMLCanvasElement.getContext` returns a recording stub
// whose methods are all no-ops (the painter only reads `measureText` for
// truncation; we return a constant width so the truncate loop terminates).

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, fireEvent, act, waitFor, screen } from "@testing-library/react";
import type { AgentPresenceValue, ActiveIdeaSession } from "@/contexts/agent-presence-context";

// usePresence: the canvas calls getPresence per node; stub to an empty array so
// the presence ring branch is inert and the steady-repaint loop short-circuits.
vi.mock("@/hooks/use-presence", () => ({
  usePresence: () => ({ getPresence: () => [] }),
}));

const agentPresence = vi.hoisted(() => ({
  value: null as AgentPresenceValue | null,
}));
vi.mock("@/contexts/agent-presence-context", () => ({
  useAgentPresenceOptional: () => agentPresence.value,
}));

// next-intl: capture every t(key) call so the test can assert the painter
// resolves the `node-status.ts` labelKey for the node being painted. Returns
// the key verbatim — the test asserts on call args, not the rendered label.
const tCalls: string[] = [];
function tStub(key: string) {
  tCalls.push(key);
  return key;
}
vi.mock("next-intl", () => ({
  useTranslations: () => tStub,
}));

// Polyfills for jsdom (the canvas mounts a ResizeObserver and reads matchMedia
// is not required here — only ResizeObserver + getContext + measureText).
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function stubCanvas2D(): CanvasRenderingContext2D {
  // Every method the painter calls — record nothing, return reasonable values
  // for the few reads (measureText). We don't assert on context method calls
  // because the painter's exact paint order is not the contract under test.
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
    stroke: (..._args: unknown[]) => {
      void _args;
    },
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
  tCalls.length = 0;
  vi.restoreAllMocks();
  agentPresence.value = null;

  // ResizeObserver shim.
  (window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    StubResizeObserver as unknown as typeof ResizeObserver;

  // Path2D shim — jsdom doesn't ship it; the painter uses `new Path2D(d)` to
  // stroke lucide icon paths into the canvas chip. A pass-through stub is
  // enough since the stubbed ctx.stroke() is also a no-op.
  if (typeof (globalThis as { Path2D?: unknown }).Path2D === "undefined") {
    (globalThis as { Path2D: unknown }).Path2D = function (_d?: string) {
      void _d;
    } as unknown as typeof Path2D;
  }

  // Canvas 2D shim — apply to the prototype so any <canvas> mounted by the
  // component picks it up automatically.
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => stubCanvas2D(),
  ) as unknown as HTMLCanvasElement["getContext"];

  // rAF: drain ONE pending callback per tick so the painter runs but a
  // re-schedule from inside the painter (steady presence loop) gets queued for
  // the next tick instead of recursing. The test only needs the first paint to
  // run through the painter, which is enough to capture t() calls and prove
  // no fetch was issued. setTimeout(0) defers callback execution off the
  // current call stack — exactly the property we need.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    return setTimeout(() => cb(performance.now()), 0) as unknown as number;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

import {
  graphActiveIndicatorGeometry,
  MindMapCanvas,
  type ForceNode,
} from "../mindmap-canvas";

function buildNodes(): ForceNode[] {
  return [
    {
      id: "task-1",
      type: "task",
      title: "Task one",
      status: "in_progress",
    },
    {
      id: "doc-1",
      type: "document",
      title: "Spec doc",
      status: "tech_design",
    },
    {
      id: "idea-1",
      type: "idea",
      title: "Idea one",
      status: "building",
    },
  ];
}

describe("MindMapCanvas — status pill + no fetch-on-hover", () => {
  it("does not issue any network request when a node is hovered (AC #3)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <MindMapCanvas
        nodes={buildNodes()}
        links={[]}
        selectedId={null}
        onNodeClick={() => {}}
      />,
    );

    // Move the pointer onto the canvas. We don't need to hit a specific node —
    // the contract under test is that hovering NEVER triggers a fetch, even if
    // a hit-test resolves to a node. Fire a series of pointer-move events at
    // arbitrary coords to exercise the hover code path.
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
    await act(async () => {
      for (let i = 0; i < 5; i++) {
        fireEvent.pointerMove(canvas!, {
          clientX: 100 + i * 20,
          clientY: 80 + i * 10,
        });
      }
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves status labels via t() during paint (painter is i18n-driven)", async () => {
    render(
      <MindMapCanvas
        nodes={buildNodes()}
        links={[]}
        selectedId={null}
        onNodeClick={() => {}}
      />,
    );

    // Per Tech Design D2 + node-status.ts, every visible node's status routes
    // through the shared resolver and its labelKey is fed to t(). The label
    // keys vary by type:
    //   task in_progress  → status.inProgress
    //   document tech_design → documents.typeTechDesign
    //   idea building     → ideaTracker.badge.building
    // We assert each of those three labelKeys is among the resolved t() calls,
    // which proves the painter received resolved status labels (not raw enum
    // values or undefined). The exact call count isn't load-bearing — the
    // statusLabels resolver runs through t() for every painted node.
    await waitFor(() => {
      expect(tCalls).toContain("status.inProgress");
      expect(tCalls).toContain("documents.typeTechDesign");
      expect(tCalls).toContain("ideaTracker.badge.building");
    });
  });
});

describe("MindMapCanvas — daemon activity indicator", () => {
  it.each([0.2, 0.5, 1, 2.5])(
    "keeps its entire hitbox beyond card, expand, lifecycle, and presence geometry at %sx zoom",
    (scale) => {
      const geometry = graphActiveIndicatorGeometry(
        { x: 300, y: 180 },
        { scale, tx: 17, ty: 23 },
      );

      expect(geometry.bounds.left).toBeGreaterThan(
        geometry.protectedCardBounds.right,
      );
      expect(geometry.scale).toBe(Math.min(1, scale));
    },
  );

  it("adds an isolated accessible hit target for an active Idea", async () => {
    const activeSession: ActiveIdeaSession = {
      sessionUuid: "session-1",
      ideaUuid: "idea-1",
      agentUuid: "agent-1",
      originConnectionUuid: "connection-1",
      activities: new Set(["activity-1"]),
      agentName: "Codex",
      host: "devbox",
      cwd: "/work/chorus",
      connectionAvailable: true,
      canOpen: true,
    };
    const openChatForActiveSession = vi.fn();
    agentPresence.value = {
      activeSessionsByIdea: new Map([["idea-1", [activeSession]]]),
      openChatForActiveSession,
    } as unknown as AgentPresenceValue;
    const onNodeClick = vi.fn();

    render(
      <MindMapCanvas
        nodes={buildNodes()}
        links={[]}
        selectedId={null}
        onNodeClick={onNodeClick}
      />,
    );

    const indicator = await waitFor(() =>
      screen.getByTestId("graph-active-session-indicator"),
    );
    fireEvent.click(indicator);

    expect(openChatForActiveSession).toHaveBeenCalledWith(activeSession);
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it("keeps card-body and expand-strip routing active beside the overlay", async () => {
    const activeSession: ActiveIdeaSession = {
      sessionUuid: "session-1",
      ideaUuid: "idea-1",
      agentUuid: "agent-1",
      originConnectionUuid: "connection-1",
      activities: new Set(["activity-1"]),
      agentName: "Codex",
      host: "devbox",
      cwd: "/work/chorus",
      connectionAvailable: true,
      canOpen: true,
    };
    agentPresence.value = {
      activeSessionsByIdea: new Map([["idea-1", [activeSession]]]),
      openChatForActiveSession: vi.fn(),
    } as unknown as AgentPresenceValue;
    const onNodeClick = vi.fn();
    const { container } = render(
      <MindMapCanvas
        nodes={[
          {
            id: "idea-1",
            type: "idea",
            title: "Idea one",
            status: "building",
            hasAffordance: true,
            childCount: 2,
          },
        ]}
        links={[]}
        selectedId={null}
        onNodeClick={onNodeClick}
      />,
    );
    await waitFor(() =>
      screen.getByTestId("graph-active-session-indicator"),
    );
    const canvas = container.querySelector("canvas")!;

    fireEvent.pointerDown(canvas, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 400,
      clientY: 300,
    });
    fireEvent.pointerUp(canvas, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 400,
      clientY: 300,
    });
    expect(onNodeClick).toHaveBeenLastCalledWith("idea-1", "idea", false);

    fireEvent.pointerDown(canvas, {
      pointerId: 2,
      pointerType: "mouse",
      clientX: 600,
      clientY: 300,
    });
    fireEvent.pointerUp(canvas, {
      pointerId: 2,
      pointerType: "mouse",
      clientX: 600,
      clientY: 300,
    });
    expect(onNodeClick).toHaveBeenLastCalledWith("idea-1", "idea", true);
  });

  it("covers zero/many sessions and removes the hit target after the final end", async () => {
    const first: ActiveIdeaSession = {
      sessionUuid: "session-1",
      ideaUuid: "idea-1",
      agentUuid: "agent-1",
      originConnectionUuid: "connection-1",
      activities: new Set(["activity-1"]),
      agentName: "Codex",
      host: "devbox",
      cwd: "/work/one",
      connectionAvailable: true,
      canOpen: true,
    };
    const second: ActiveIdeaSession = {
      ...first,
      sessionUuid: "session-2",
      agentName: "Claude",
      originConnectionUuid: "connection-2",
      cwd: "/work/two",
    };
    const openChatForActiveSession = vi.fn();
    agentPresence.value = {
      activeSessionsByIdea: new Map(),
      openChatForActiveSession,
    } as unknown as AgentPresenceValue;
    const onNodeClick = vi.fn();
    const props = {
      nodes: buildNodes(),
      links: [],
      selectedId: null,
      onNodeClick,
    };
    const { rerender } = render(<MindMapCanvas {...props} />);
    expect(
      screen.queryByTestId("graph-active-session-indicator"),
    ).toBeNull();

    agentPresence.value = {
      activeSessionsByIdea: new Map([["idea-1", [first, second]]]),
      openChatForActiveSession,
    } as unknown as AgentPresenceValue;
    rerender(<MindMapCanvas {...props} />);
    const indicator = await waitFor(() =>
      screen.getByTestId("graph-active-session-indicator"),
    );
    expect(indicator.textContent).toContain("2");
    fireEvent.click(indicator);
    fireEvent.click(screen.getByText("Claude"));
    expect(openChatForActiveSession).toHaveBeenCalledWith(second);
    expect(onNodeClick).not.toHaveBeenCalled();

    agentPresence.value = {
      activeSessionsByIdea: new Map(),
      openChatForActiveSession,
    } as unknown as AgentPresenceValue;
    rerender(<MindMapCanvas {...props} />);
    await waitFor(() => {
      expect(
        screen.queryByTestId("graph-active-session-indicator"),
      ).toBeNull();
    });
  });
});
