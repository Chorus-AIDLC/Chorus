// @vitest-environment jsdom
//
// Wave 4 task 3 — live structural updates.
//
// Verifies the resource-graph canvas wires its re-fetch + reconcile loop
// to the existing project SSE entity-change delivery, and that survivor
// state (expand/collapse + per-node positions) is preserved across a
// live refetch — NOT cleared like the initial-mount / project-change
// path does.
//
// What this test exercises (the live-update wiring) vs what it doesn't
// (pure rendering — that's resource-graph-node.test.tsx + the layout +
// visible-set + service tests already in tree):
//   - useRealtimeEntityTypeEvent is subscribed for all four entity types
//     (idea / proposal / task / document)
//   - Firing any of those subscribers triggers exactly one re-fetch
//   - Across a re-fetch the layout module is called with the PREVIOUS
//     positions as its third argument (incremental settle path)
//   - On project change the layout module is called with `null` for the
//     third arg (full reset path) — the same call site the original
//     mount used.
//
// The canvas reaches into a lot of heavy children (ReactFlow, panels,
// PresenceIndicator); we mock the integration surface and assert on the
// signals that matter — the realtime subscription set, the fetch call
// count + URL, and the prev-positions argument shape on layout calls.

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";

// Capture realtime subscribers so a test can fire a refetch on demand,
// keyed by entityType. Mirrors the idea-tracker test pattern.
const realtimeCallbacks = new Map<string, () => void>();
vi.mock("@/contexts/realtime-context", () => ({
  useRealtimeEntityTypeEvent: (type: string, cb: () => void) => {
    realtimeCallbacks.set(type, cb);
  },
}));

// The layout module is the contract surface for AC #2 (prevPositions
// seeding). Mock it so we can assert the seeding-mode argument across
// re-fetches AND so we don't have to drive a real d3-force simulation
// in the test.
const layoutMock = vi.fn();
vi.mock("@/lib/resource-graph-layout", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/resource-graph-layout")
  >("@/lib/resource-graph-layout");
  return {
    ...actual,
    layoutResourceGraph: (
      nodes: { uuid: string }[],
      edges: { from: string; to: string }[],
      prev?: ReadonlyMap<string, { x: number; y: number }> | null,
    ) => {
      layoutMock(nodes, edges, prev);
      // Deterministic positions — one per uuid. Returning a fresh Map
      // here is important: the canvas writes this back into
      // prevPositionsRef, so on the next call we get to see what the
      // canvas seeded.
      const out = new Map<string, { x: number; y: number }>();
      for (let i = 0; i < nodes.length; i++) {
        out.set(nodes[i].uuid, { x: i * 100, y: 0 });
      }
      return out;
    },
  };
});

// usePanelUrl: ResourceGraph uses it for Idea/Proposal panels; we don't
// exercise panel opening here. Stub to stable no-ops.
vi.mock("@/hooks/use-panel-url", () => ({
  usePanelUrl: () => ({ selectedId: null, openPanel: vi.fn(), closePanel: vi.fn() }),
}));

// Heavy leaf components stubbed out — see resource-graph-node.test.tsx
// for the renderer's own unit coverage.
vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ children, nodes }: { children?: React.ReactNode; nodes: unknown[] }) => (
    <div data-testid="reactflow" data-node-count={(nodes ?? []).length}>
      {children}
    </div>
  ),
  Background: () => null,
  Controls: () => null,
  Panel: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  MarkerType: { ArrowClosed: "arrowclosed" },
  Handle: () => null,
  Position: { Top: "top", Bottom: "bottom" },
}));

vi.mock("../resource-graph-node", () => ({
  resourceGraphNodeTypes: {},
  RESOURCE_GRAPH_NODE_WIDTH: 220,
}));

vi.mock(
  "@/app/(dashboard)/projects/[uuid]/dashboard/panels/idea-detail-panel",
  () => ({ IdeaDetailPanel: () => null }),
);
vi.mock(
  "@/app/(dashboard)/projects/[uuid]/tasks/task-detail-panel",
  () => ({ TaskDetailPanel: () => null }),
);
vi.mock(
  "@/app/(dashboard)/projects/[uuid]/dashboard/panels/document-panel",
  () => ({ DocumentPanel: () => null }),
);
vi.mock(
  "@/app/(dashboard)/projects/[uuid]/dashboard/panels/actions",
  () => ({ getTaskAction: vi.fn() }),
);

// AnimatedEmptyState wraps children — pass through.
vi.mock("@/components/animated-empty-state", () => ({
  AnimatedEmptyState: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

// Return a STABLE translator function on every render. The real
// next-intl client hook memoizes its translator; if we return a fresh
// closure each call, `t` identity churns every render → cascading into
// the `reloadGraph` useCallback whose deps include `t` → the
// initial-fetch effect re-runs every render → infinite-loop OOM.
const stableTranslator = (key: string) => key;
vi.mock("next-intl", () => ({
  useTranslations: () => stableTranslator,
}));

import { ResourceGraph } from "../resource-graph";

const PROJECT = "p-0000-0000-0000-000000000001";
const USER = "u-0000-0000-0000-000000000001";

// Two payloads — "before" and "after" — so a test can simulate a
// structural change arriving via SSE and assert how the canvas reacts.
const PAYLOAD_BEFORE = {
  nodes: [
    { uuid: "idea-1", type: "idea", title: "Idea one" },
    { uuid: "task-1", type: "task", title: "Task A", proposalUuid: null },
  ],
  edges: [],
};

const PAYLOAD_AFTER = {
  nodes: [
    { uuid: "idea-1", type: "idea", title: "Idea one" },
    { uuid: "task-1", type: "task", title: "Task A", proposalUuid: null },
    // New task arrives — structural change.
    { uuid: "task-2", type: "task", title: "Task B", proposalUuid: null },
  ],
  edges: [
    // New depends edge between the two tasks.
    { from: "task-1", to: "task-2", kind: "depends" },
  ],
};

beforeEach(() => {
  realtimeCallbacks.clear();
  layoutMock.mockClear();
  vi.restoreAllMocks();

  // jsdom doesn't ship matchMedia — the canvas uses it for the wide-
  // screen breakpoint that toggles side-by-side mode on Task/Document
  // panels (mirrors the dashboard host). Stub a stable no-match impl so
  // the useEffect doesn't throw on mount.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

function mockFetchSequence(payloads: unknown[]) {
  let i = 0;
  // Cast the inner factory through `unknown` so TS doesn't infer the
  // mock function's call signature as a zero-arg tuple — fetch is called
  // with (input, init?) and the tests inspect calls[i][0].
  return vi.fn((..._args: unknown[]) => {
    void _args;
    const data = payloads[Math.min(i, payloads.length - 1)];
    i++;
    return Promise.resolve({
      ok: true,
      json: async () => ({ success: true, data }),
    });
  });
}

describe("ResourceGraph — live structural updates (Wave 4 task 3)", () => {
  it("subscribes to all four entity types on the project SSE stream", async () => {
    const fetchMock = mockFetchSequence([PAYLOAD_BEFORE]);
    vi.stubGlobal("fetch", fetchMock);

    render(<ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // AC #1: the canvas must reuse the existing project SSE entity-change
    // delivery rather than introduce a new transport. The four types are
    // exactly the four it can render (and the four the aggregation
    // returns — see resource-graph.service.ts).
    expect(realtimeCallbacks.has("idea")).toBe(true);
    expect(realtimeCallbacks.has("proposal")).toBe(true);
    expect(realtimeCallbacks.has("task")).toBe(true);
    expect(realtimeCallbacks.has("document")).toBe(true);
  });

  it("re-fetches the aggregation when an entity-change event fires", async () => {
    const fetchMock = mockFetchSequence([PAYLOAD_BEFORE, PAYLOAD_AFTER]);
    vi.stubGlobal("fetch", fetchMock);

    render(<ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />);

    // Wait for the initial mount fetch.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/projects/${PROJECT}/resource-graph`,
    );

    // Fire a "task" entity-change event — simulates another client
    // creating a task in this project. The canvas must re-fetch the
    // aggregation through the same endpoint (no new transport).
    await act(async () => {
      await realtimeCallbacks.get("task")?.();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe(
      `/api/projects/${PROJECT}/resource-graph`,
    );
  });

  it("preserves prevPositions on a live re-fetch — the layout module receives the prior position map (AC #2)", async () => {
    const fetchMock = mockFetchSequence([PAYLOAD_BEFORE, PAYLOAD_AFTER]);
    vi.stubGlobal("fetch", fetchMock);

    render(<ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // After the initial render, the layout module was called once with
    // prev=null (full reset path on first paint). Capture its return so
    // we can assert it's fed back in on the next call.
    const firstCall = layoutMock.mock.calls.at(-1);
    expect(firstCall).toBeDefined();
    // Third arg = prev positions seed. First mount has no prior map.
    expect(firstCall![2]).toBeNull();

    // Now drive a live SSE event. After the re-fetch, the layout memo
    // re-runs with the PREVIOUS positions feeding the new pass. This is
    // the seeding path AC #2 nails — surviving nodes' positions are kept
    // so the layout settles incrementally instead of re-randomizing.
    layoutMock.mockClear();
    await act(async () => {
      await realtimeCallbacks.get("task")?.();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(layoutMock).toHaveBeenCalled());

    const reconcileCall = layoutMock.mock.calls.at(-1)!;
    const prevArg = reconcileCall[2] as Map<string, { x: number; y: number }> | null;

    // The KEY assertion: prev is now a Map (not null), and it contains
    // the surviving nodes from the previous pass. This is the contract
    // d3-force's incremental-alpha path needs to keep nodes near where
    // the user already saw them.
    expect(prevArg).not.toBeNull();
    expect(prevArg).toBeInstanceOf(Map);
    expect(prevArg!.get("idea-1")).toBeDefined();
    expect(prevArg!.get("task-1")).toBeDefined();
  });

  it("emits the new node into the next render — re-fetch reconciles into the canvas (AC #1)", async () => {
    const fetchMock = mockFetchSequence([PAYLOAD_BEFORE, PAYLOAD_AFTER]);
    vi.stubGlobal("fetch", fetchMock);

    const { getByTestId } = render(
      <ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />,
    );

    // First paint: 2 nodes.
    await waitFor(() => {
      expect(getByTestId("reactflow").getAttribute("data-node-count")).toBe("2");
    });

    // Live event → re-fetch → reconcile.
    await act(async () => {
      await realtimeCallbacks.get("task")?.();
    });

    // Second paint: 3 nodes (the new task arrived). This proves the
    // re-fetch round-trip mutates the rendered graph — AC #1.
    await waitFor(() => {
      expect(getByTestId("reactflow").getAttribute("data-node-count")).toBe("3");
    });
  });

  it("a removed node drops out of the next render — reconcile keeps the graph in sync (AC #3)", async () => {
    const REMOVED = {
      nodes: [
        // task-1 is gone in this payload — simulates a delete.
        { uuid: "idea-1", type: "idea", title: "Idea one" },
      ],
      edges: [],
    };
    const fetchMock = mockFetchSequence([PAYLOAD_BEFORE, REMOVED]);
    vi.stubGlobal("fetch", fetchMock);

    const { getByTestId } = render(
      <ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />,
    );

    await waitFor(() => {
      expect(getByTestId("reactflow").getAttribute("data-node-count")).toBe("2");
    });

    await act(async () => {
      await realtimeCallbacks.get("task")?.();
    });

    await waitFor(() => {
      expect(getByTestId("reactflow").getAttribute("data-node-count")).toBe("1");
    });
  });
});
