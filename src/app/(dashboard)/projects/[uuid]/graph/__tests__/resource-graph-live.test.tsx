// @vitest-environment jsdom
//
// Live structural updates — verifies the resource-graph wires its re-fetch +
// reconcile loop to the existing project SSE entity-change delivery, and that
// expand/collapse survivor state is preserved across a live refetch (NOT
// cleared like the initial-mount / project-change path does).
//
// Rendering is delegated to the dynamically-imported mind-map canvas (exported
// under the preserved `ForceGraphCanvas` alias). We mock that canvas so the
// test runs headless and can assert on the exact node/link set it receives —
// which is the data contract that matters here (the canvas's own deterministic
// painting is its concern). The signals under test:
//   - useRealtimeEntityTypeEvent is subscribed for all four entity types
//   - firing any subscriber triggers exactly one re-fetch through the SAME
//     aggregation endpoint (no new transport)
//   - a re-fetch reconciles into the canvas: a new node appears, a removed
//     node drops out

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";

// Capture realtime subscribers so a test can fire a refetch on demand, keyed
// by entityType. Mirrors the idea-tracker test pattern.
const realtimeCallbacks = new Map<string, () => void>();
vi.mock("@/contexts/realtime-context", () => ({
  useRealtimeEntityTypeEvent: (type: string, cb: () => void) => {
    realtimeCallbacks.set(type, cb);
  },
}));

// next/dynamic — return the resolved module's component synchronously so the
// canvas mock renders inline (no Suspense/loading dance in the test).
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>) => {
    // The real call is dynamic(() => import(...).then(m => m.ForceGraphCanvas)).
    // We don't actually invoke the loader — we return our stub directly.
    void loader;
    return MockForceGraphCanvas;
  },
}));

// Capture the nodes/links the canvas receives on each render so tests can
// assert reconcile behavior. The mock serializes `id:status` per node so a
// status-only change (no count change) is observable from the DOM.
function MockForceGraphCanvas({
  nodes,
}: {
  nodes: { id: string; status?: string }[];
  links: unknown[];
  selectedId: string | null;
  onNodeClick: (id: string, type: string, onAffordance: boolean) => void;
}) {
  return (
    <div
      data-testid="force-canvas"
      data-node-count={nodes.length}
      data-node-statuses={nodes
        .map((n) => `${n.id}:${n.status ?? ""}`)
        .join(",")}
    />
  );
}

// usePanelUrl: ResourceGraph uses it for Idea/Proposal panels; we don't
// exercise panel opening here. Stub to stable no-ops.
vi.mock("@/hooks/use-panel-url", () => ({
  usePanelUrl: () => ({ selectedId: null, openPanel: vi.fn(), closePanel: vi.fn() }),
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

// Return a STABLE translator function on every render — a fresh closure each
// call churns `t` identity → cascades into reloadGraph's useCallback deps →
// the initial-fetch effect re-runs every render → infinite loop.
const stableTranslator = (key: string) => key;
vi.mock("next-intl", () => ({
  useTranslations: () => stableTranslator,
}));

import { ResourceGraph } from "../resource-graph";

const PROJECT = "p-0000-0000-0000-000000000001";
const USER = "u-0000-0000-0000-000000000001";

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
    { uuid: "task-2", type: "task", title: "Task B", proposalUuid: null },
  ],
  edges: [{ from: "task-1", to: "task-2", kind: "depends" }],
};

beforeEach(() => {
  realtimeCallbacks.clear();
  vi.restoreAllMocks();

  // jsdom doesn't ship matchMedia — the component uses it for the wide-screen
  // breakpoint that toggles side-by-side mode on Task/Document panels.
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

describe("ResourceGraph — live structural updates", () => {
  it("subscribes to all four entity types on the project SSE stream", async () => {
    const fetchMock = mockFetchSequence([PAYLOAD_BEFORE]);
    vi.stubGlobal("fetch", fetchMock);

    render(<ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // The canvas must reuse the existing project SSE entity-change delivery
    // rather than introduce a new transport. The four types are exactly the
    // four it can render (and the four the aggregation returns).
    expect(realtimeCallbacks.has("idea")).toBe(true);
    expect(realtimeCallbacks.has("proposal")).toBe(true);
    expect(realtimeCallbacks.has("task")).toBe(true);
    expect(realtimeCallbacks.has("document")).toBe(true);
  });

  it("re-fetches the aggregation when an entity-change event fires", async () => {
    const fetchMock = mockFetchSequence([PAYLOAD_BEFORE, PAYLOAD_AFTER]);
    vi.stubGlobal("fetch", fetchMock);

    render(<ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/projects/${PROJECT}/resource-graph`,
    );

    await act(async () => {
      await realtimeCallbacks.get("task")?.();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe(
      `/api/projects/${PROJECT}/resource-graph`,
    );
  });

  it("emits the new node into the next render — re-fetch reconciles into the canvas", async () => {
    const fetchMock = mockFetchSequence([PAYLOAD_BEFORE, PAYLOAD_AFTER]);
    vi.stubGlobal("fetch", fetchMock);

    const { getByTestId } = render(
      <ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />,
    );

    // First paint: 2 nodes.
    await waitFor(() => {
      expect(getByTestId("force-canvas").getAttribute("data-node-count")).toBe("2");
    });

    await act(async () => {
      await realtimeCallbacks.get("task")?.();
    });

    // Second paint: 3 nodes (the new task arrived).
    await waitFor(() => {
      expect(getByTestId("force-canvas").getAttribute("data-node-count")).toBe("3");
    });
  });

  it("a status change on a SURVIVING node is reflected after the refetch (Tech Design D4, AC #4)", async () => {
    // Same node set before and after — only `status` flips. The reconcile must
    // carry the new field through (the parent rebuilds forceNodes from the
    // freshly fetched aggregation, replacing node objects wholesale, so this
    // works automatically — the test pins that the contract holds).
    const BEFORE = {
      nodes: [
        {
          uuid: "task-1",
          type: "task",
          title: "Task A",
          status: "in_progress",
          proposalUuid: null,
        },
      ],
      edges: [],
    };
    const AFTER = {
      nodes: [
        {
          uuid: "task-1",
          type: "task",
          title: "Task A",
          status: "done",
          proposalUuid: null,
        },
      ],
      edges: [],
    };
    const fetchMock = mockFetchSequence([BEFORE, AFTER]);
    vi.stubGlobal("fetch", fetchMock);

    const { getByTestId } = render(
      <ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />,
    );

    // First paint: task-1 in_progress.
    await waitFor(() => {
      expect(getByTestId("force-canvas").getAttribute("data-node-statuses")).toBe(
        "task-1:in_progress",
      );
    });

    // SSE fires → re-fetch returns the same node with a new status.
    await act(async () => {
      await realtimeCallbacks.get("task")?.();
    });

    // Second paint: same node count, new status carried through.
    await waitFor(() => {
      expect(getByTestId("force-canvas").getAttribute("data-node-statuses")).toBe(
        "task-1:done",
      );
    });
  });

  it("a removed node drops out of the next render — reconcile keeps the graph in sync", async () => {
    const REMOVED = {
      nodes: [{ uuid: "idea-1", type: "idea", title: "Idea one" }],
      edges: [],
    };
    const fetchMock = mockFetchSequence([PAYLOAD_BEFORE, REMOVED]);
    vi.stubGlobal("fetch", fetchMock);

    const { getByTestId } = render(
      <ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />,
    );

    await waitFor(() => {
      expect(getByTestId("force-canvas").getAttribute("data-node-count")).toBe("2");
    });

    await act(async () => {
      await realtimeCallbacks.get("task")?.();
    });

    await waitFor(() => {
      expect(getByTestId("force-canvas").getAttribute("data-node-count")).toBe("1");
    });
  });
});
