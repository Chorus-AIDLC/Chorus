// @vitest-environment jsdom
//
// Mobile vertical indented outline + responsive renderer switch (Tech Design
// D3). Verifies that:
//   - a NARROW viewport renders the DOM vertical indented outline; a WIDE
//     viewport renders the canvas (AC #1);
//   - outline rows reuse the type chip/title + show the +/- affordance with a
//     child count for hubs, built with shadcn/ui Button (AC #2);
//   - outline expand + node activation use the SAME shared expand state and
//     onNodeClick contract as the canvas, so expansion is preserved across a
//     viewport-size change (AC #3);
//   - the presence highlight applies to outline rows AND identifies the acting
//     agent (AC #4).
//
// jsdom lacks matchMedia + ResizeObserver. We polyfill matchMedia per the
// pattern in resource-graph-live.test.tsx (here parameterized so a test can
// pick narrow vs wide) and stub ResizeObserver for the canvas path.

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor, act, fireEvent, within } from "@testing-library/react";

// Realtime context: the parent subscribes via useRealtimeEntityTypeEvent; the
// outline's usePresence subscribes via usePresenceSubscription. Stub both —
// presence is driven directly through the presence store's injectPresence below.
const realtimeCallbacks = new Map<string, () => void>();
vi.mock("@/contexts/realtime-context", () => ({
  useRealtimeEntityTypeEvent: (type: string, cb: () => void) => {
    realtimeCallbacks.set(type, cb);
  },
  usePresenceSubscription: () => {},
}));

// next/dynamic — the parent does dynamic(() => import("./mindmap-canvas")...).
// Return a stub canvas synchronously so the WIDE path is observable headless.
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>) => {
    void loader;
    return MockCanvas;
  },
}));
function MockCanvas({ nodes }: { nodes: { id: string }[] }) {
  return <div data-testid="force-canvas" data-node-count={nodes.length} />;
}

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
vi.mock("@/components/animated-empty-state", () => ({
  AnimatedEmptyState: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

// Stable translator: interpolate {count} so the expand aria-label is assertable;
// otherwise echo the key. A fresh closure per render would churn `t` identity
// and re-run the parent's fetch effect, so keep this module-level.
const stableTranslator = (key: string, vars?: Record<string, unknown>) => {
  if (vars && "count" in vars) return `${key}:${vars.count}`;
  return key;
};
vi.mock("next-intl", () => ({
  useTranslations: () => stableTranslator,
}));

import { ResourceGraph } from "../resource-graph";
import {
  injectPresence,
  _resetPresenceStore,
} from "@/hooks/use-presence";

const PROJECT = "p-0000-0000-0000-000000000001";
const USER = "u-0000-0000-0000-000000000001";

// One idea with one proposal child (so the idea is a hub with childCount 1) and
// one standalone task. Edges: idea -> proposal (derive). The proposal carries
// sourceIdeaUuids so the visible-set + outline can root it under the idea.
const PAYLOAD = {
  nodes: [
    { uuid: "idea-1", type: "idea", title: "Idea one" },
    {
      uuid: "prop-1",
      type: "proposal",
      title: "Proposal one",
      sourceIdeaUuids: ["idea-1"],
    },
    { uuid: "task-1", type: "task", title: "Task A", proposalUuid: null },
  ],
  edges: [{ from: "idea-1", to: "prop-1", kind: "derive" }],
};

// Polyfill matchMedia with a controllable `matches`. useIsMobile reads the
// `(max-width: 767px)` query on mount AND subscribes to its `change` event, so
// we capture the live MediaQueryList(s) to flip `matches` mid-instance (a real
// resize) and dispatch the change.
interface FakeMql {
  matches: boolean;
  listeners: ((e: { matches: boolean }) => void)[];
}
const liveMqls: FakeMql[] = [];
function setViewport(narrow: boolean) {
  liveMqls.length = 0;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const mql: FakeMql = { matches: narrow, listeners: [] };
      liveMqls.push(mql);
      return {
        get matches() {
          return mql.matches;
        },
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: (_: string, cb: (e: { matches: boolean }) => void) =>
          mql.listeners.push(cb),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}
// Flip every live MediaQueryList to the given match state and fire `change`.
function resizeViewport(narrow: boolean) {
  for (const mql of liveMqls) {
    mql.matches = narrow;
    for (const cb of mql.listeners) cb({ matches: narrow });
  }
}

// ResizeObserver isn't in jsdom — the canvas path constructs one at mount.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  realtimeCallbacks.clear();
  _resetPresenceStore();
  vi.restoreAllMocks();
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: PAYLOAD }),
      }),
    ),
  );
});

describe("ResourceGraph — mobile vertical outline & responsive switch", () => {
  it("renders the DOM outline on a narrow viewport and the canvas on a wide one (AC #1)", async () => {
    setViewport(true);
    const narrow = render(
      <ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />,
    );
    await waitFor(() =>
      expect(narrow.queryByTestId("mindmap-outline")).not.toBeNull(),
    );
    expect(narrow.queryByTestId("force-canvas")).toBeNull();
    narrow.unmount();

    setViewport(false);
    const wide = render(
      <ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />,
    );
    await waitFor(() =>
      expect(wide.queryByTestId("force-canvas")).not.toBeNull(),
    );
    expect(wide.queryByTestId("mindmap-outline")).toBeNull();
  });

  it("outline rows show the type label + title and a +/- affordance with child count for hubs (AC #2)", async () => {
    setViewport(true);
    const { getByTestId, getByText, getByRole } = render(
      <ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />,
    );
    await waitFor(() => getByTestId("mindmap-outline"));

    // Type label (eyebrow) + title rendered for the idea hub.
    expect(getByText("graph.nodeType.idea")).toBeTruthy();
    expect(getByText("Idea one")).toBeTruthy();

    // The collapsed idea hub (1 child proposal) exposes an expand control whose
    // aria-label carries the child count — proving the +/- affordance + count.
    const expandBtn = getByRole("button", { name: "graph.outline.expand:1" });
    expect(expandBtn).toBeTruthy();
    // It is a real <button> (shadcn Button), not a div-as-control.
    expect(expandBtn.tagName).toBe("BUTTON");
    expect(expandBtn.getAttribute("aria-expanded")).toBe("false");
  });

  it("outline expand uses the shared onNodeClick contract; expansion survives a resize to the canvas (AC #3)", async () => {
    // Start narrow: expand the idea hub via the outline.
    setViewport(true);
    const view = render(
      <ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />,
    );
    await waitFor(() => view.getByTestId("mindmap-outline"));

    // Collapsed by default: only idea + standalone task render; the proposal
    // child is NOT yet a row.
    expect(view.queryByText("Proposal one")).toBeNull();

    const expandBtn = view.getByRole("button", {
      name: "graph.outline.expand:1",
    });
    await act(async () => {
      fireEvent.click(expandBtn);
    });

    // Expanded: the proposal child now appears as an outline row, and the
    // affordance flipped to the collapse state.
    await waitFor(() => expect(view.queryByText("Proposal one")).not.toBeNull());
    expect(
      view.getByRole("button", { name: "graph.outline.collapse" }),
    ).toBeTruthy();

    // Resize the SAME instance to a WIDE viewport (real matchMedia `change`).
    // Expand state lives in the parent, NOT in either renderer, so the canvas
    // now receives the SAME expanded set: idea + revealed proposal + standalone
    // task = 3 nodes. If expansion were lost on the swap this would be 2.
    await act(async () => {
      resizeViewport(false);
    });
    await waitFor(() => view.getByTestId("force-canvas"));
    expect(view.queryByTestId("mindmap-outline")).toBeNull();
    expect(
      view.getByTestId("force-canvas").getAttribute("data-node-count"),
    ).toBe("3");
  });

  it("orders rows by pre-order DFS and indents each by its derivation depth (AC #2/#3)", async () => {
    // Narrow viewport → outline. Expand the idea hub so its proposal child
    // becomes a row nested DIRECTLY under it (between the idea and the
    // standalone task) — that ordering is the pre-order DFS signal.
    setViewport(true);
    const view = render(
      <ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />,
    );
    const outline = await waitFor(() => view.getByTestId("mindmap-outline"));

    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: "graph.outline.expand:1" }),
      );
    });
    await waitFor(() => expect(view.queryByText("Proposal one")).not.toBeNull());

    // Each visible node renders as one <li> row, in document order. The forest
    // is: idea-1 (root) → prop-1 (its derive child); task-1 is a standalone
    // root. Pre-order DFS over roots-in-input-order then each subtree yields:
    //   idea-1 (depth 0), prop-1 (depth 1), task-1 (depth 0)
    // i.e. the proposal child sits IMMEDIATELY after its parent idea, NOT after
    // the unrelated standalone task — that adjacency is the DFS contract.
    const rows = Array.from(outline.querySelectorAll("li"));
    const titleOf = (li: Element) =>
      li.textContent?.includes("Idea one")
        ? "Idea one"
        : li.textContent?.includes("Proposal one")
          ? "Proposal one"
          : li.textContent?.includes("Task A")
            ? "Task A"
            : "?";
    expect(rows.map(titleOf)).toEqual(["Idea one", "Proposal one", "Task A"]);

    // Depth indentation: the outline indents a row by `depth * INDENT_STEP`
    // (22px). Root nodes (idea + standalone task) sit at margin 0; the proposal
    // child (depth 1) is indented one step. The mind-map's left→right depth thus
    // maps to top→bottom indentation, keeping the two renderers in sync.
    const marginOf = (li: Element) =>
      (li as HTMLElement).style.marginLeft;
    expect(marginOf(rows[0])).toBe("0px"); // Idea one — depth 0
    expect(marginOf(rows[1])).toBe("22px"); // Proposal one — depth 1
    expect(marginOf(rows[2])).toBe("0px"); // Task A — depth 0
  });

  it("applies a presence highlight to outline rows and identifies the acting agent (AC #4)", async () => {
    setViewport(true);
    const { getByTestId } = render(
      <ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />,
    );
    await waitFor(() => getByTestId("mindmap-outline"));

    // A mutating agent operates on the idea entity.
    await act(async () => {
      injectPresence({
        entityType: "idea",
        entityUuid: "idea-1",
        subEntityType: "",
        subEntityUuid: "",
        agentUuid: "agent-9",
        agentName: "Builder Bot",
        action: "mutate",
      });
    });

    // The acting agent is named on the row (identify the acting agent).
    await waitFor(() => {
      const badge = getByTestId("outline-presence-agent");
      expect(within(badge).getByText("Builder Bot")).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// T3 — status Badge per row
//
// The outline row renders a shadcn <Badge> driven by the SHARED
// node-status.ts resolver, so its color+label match the canvas pill for the
// same (type, statusValue). We test MindMapOutline DIRECTLY here (rather than
// through ResourceGraph) to control `node.status` precisely and to isolate
// from the parent's reconciliation pipeline.
//
// Coverage:
//   - AC #1: every row renders a Badge with the correct per-type label
//            (idea badgeHint / proposal / task / document type)
//   - AC #1/#4: badge uses the shadcn <Badge> primitive (data-slot="badge"),
//            not a raw HTML element
//   - AC #2: the badge does not break the row's title, expand affordance,
//            presence pill, or tap-to-open-panel behavior
//   - AC #3: a status change in the node payload updates the row's badge
//            (the outline renders from the reconciled payload — re-rendering
//            with a new `status` swaps the label without remount)
// ---------------------------------------------------------------------------

import { MindMapOutline } from "../mindmap-outline";
import type { ForceNode, ForceLink } from "../mindmap-canvas";

// `ForceNode` does not yet carry `status` in its exported type (the canvas
// renderer's plumbing for that is the sibling task); the runtime payload from
// resource-graph.tsx will set it. We attach it via a structural widen so the
// test can drive the field today.
type OutlineNode = ForceNode & { status?: string };
function makeNode(n: OutlineNode): ForceNode {
  return n as ForceNode;
}

describe("MindMapOutline — per-row status Badge", () => {
  // Make sure no leftover presence colors the row from a prior test.
  beforeEach(() => {
    _resetPresenceStore();
  });

  it("renders a shadcn Badge with the correct localized label for each node type (AC #1)", () => {
    // One node per type, each carrying a representative concrete status. All
    // four nodes are flat roots (no edges), so each gets its own outline row.
    const nodes: ForceNode[] = [
      makeNode({ id: "idea-1", type: "idea", title: "Idea one", status: "building" }),
      makeNode({
        id: "prop-1",
        type: "proposal",
        title: "Proposal one",
        status: "pending",
      }),
      makeNode({
        id: "task-1",
        type: "task",
        title: "Task A",
        status: "in_progress",
      }),
      makeNode({
        id: "doc-1",
        type: "document",
        title: "Doc one",
        status: "prd",
      }),
    ];
    const links: ForceLink[] = [];

    const { getAllByTestId } = render(
      <MindMapOutline
        nodes={nodes}
        links={links}
        selectedId={null}
        onNodeClick={vi.fn()}
      />,
    );

    const badges = getAllByTestId("outline-status-badge");
    expect(badges).toHaveLength(4);

    // Labels: idea → ideaTracker.badge.*, proposal/task → status.*, doc → documents.type*.
    expect(badges[0].textContent).toBe("ideaTracker.badge.building");
    expect(badges[1].textContent).toBe("status.pendingReview");
    expect(badges[2].textContent).toBe("status.inProgress");
    expect(badges[3].textContent).toBe("documents.typePrd");

    // Each row's badge carries a Tailwind `bg-[#..] text-[#..]` color pair —
    // that's the same shape the canvas pill uses, so the two surfaces stay
    // visually consistent.
    for (const b of badges) {
      expect(b.className).toMatch(/bg-\[#/);
      expect(b.className).toMatch(/text-\[#/);
    }
  });

  it("renders the badge with the shadcn <Badge> primitive (data-slot=\"badge\"), not a raw element (AC #4)", () => {
    const nodes: ForceNode[] = [
      makeNode({ id: "task-1", type: "task", title: "T", status: "done" }),
    ];
    const { getByTestId } = render(
      <MindMapOutline
        nodes={nodes}
        links={[]}
        selectedId={null}
        onNodeClick={vi.fn()}
      />,
    );
    const badge = getByTestId("outline-status-badge");
    // The shadcn Badge primitive stamps `data-slot="badge"` on its root.
    expect(badge.getAttribute("data-slot")).toBe("badge");
  });

  it("an unknown/missing status resolves to the neutral fallback label (no crash)", () => {
    const nodes: ForceNode[] = [
      // No status — simulates a stale or pre-foundation payload.
      makeNode({ id: "task-x", type: "task", title: "T" }),
      // Bogus status value — simulates a server we haven't taught yet.
      makeNode({
        id: "task-y",
        type: "task",
        title: "U",
        status: "definitely_not_a_real_value",
      }),
    ];
    const { getAllByTestId } = render(
      <MindMapOutline
        nodes={nodes}
        links={[]}
        selectedId={null}
        onNodeClick={vi.fn()}
      />,
    );
    const badges = getAllByTestId("outline-status-badge");
    expect(badges).toHaveLength(2);
    for (const b of badges) {
      expect(b.textContent).toBe("graph.status.unknown");
    }
  });

  it("does not break the row's title, tap-to-open-panel, or expand affordance (AC #2)", () => {
    // An idea hub with one proposal child — the hub gets the +/- affordance.
    const onNodeClick = vi.fn();
    const nodes: ForceNode[] = [
      makeNode({
        id: "idea-1",
        type: "idea",
        title: "Idea one",
        status: "building",
        childCount: 1,
        expanded: false,
        hasAffordance: true,
      }),
    ];

    const { getByText, getByRole, getByTestId } = render(
      <MindMapOutline
        nodes={nodes}
        links={[]}
        selectedId={null}
        onNodeClick={onNodeClick}
      />,
    );

    // Title is still rendered and readable (i.e. the badge did not displace it).
    expect(getByText("Idea one")).toBeTruthy();

    // Status badge is present alongside the title region.
    expect(getByTestId("outline-status-badge").textContent).toBe(
      "ideaTracker.badge.building",
    );

    // Expand affordance is still there, with its existing aria-label intact.
    const expandBtn = getByRole("button", { name: "graph.outline.expand:1" });
    expect(expandBtn).toBeTruthy();

    // Tapping the row body still routes through the SAME onNodeClick contract
    // (id, type, onAffordance=false) — adding the badge did not regress that.
    fireEvent.click(getByText("Idea one"));
    expect(onNodeClick).toHaveBeenCalledWith("idea-1", "idea", false);

    // Tapping the expand affordance still routes the SAME way (onAffordance=true).
    fireEvent.click(expandBtn);
    expect(onNodeClick).toHaveBeenCalledWith("idea-1", "idea", true);
  });

  it("a status change in the node payload updates the row's badge label without remount (AC #3)", () => {
    // Drive the badge from `status` on the same id across a rerender — this
    // mirrors the live-reconcile path where SSE refetches the aggregation and
    // the outline receives the SAME id with a NEW status string.
    const initial: ForceNode[] = [
      makeNode({ id: "task-1", type: "task", title: "Task A", status: "open" }),
    ];
    const { getByTestId, rerender } = render(
      <MindMapOutline
        nodes={initial}
        links={[]}
        selectedId={null}
        onNodeClick={vi.fn()}
      />,
    );
    expect(getByTestId("outline-status-badge").textContent).toBe("status.open");

    // Same id, new status — the reconciled payload from the live refetch.
    const next: ForceNode[] = [
      makeNode({
        id: "task-1",
        type: "task",
        title: "Task A",
        status: "in_progress",
      }),
    ];
    rerender(
      <MindMapOutline
        nodes={next}
        links={[]}
        selectedId={null}
        onNodeClick={vi.fn()}
      />,
    );
    // Badge label flipped to the new status, no manual refresh needed.
    expect(getByTestId("outline-status-badge").textContent).toBe(
      "status.inProgress",
    );
  });
});
