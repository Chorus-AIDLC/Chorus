// @vitest-environment jsdom
//
// Node-search state + control UI in resource-graph.tsx. Verifies the parent's
// search orchestration end-to-end through the real visible-set pipeline (the
// helpers themselves are unit-tested in
// src/lib/__tests__/resource-graph-search.test.ts):
//   - typing a query updates the current/total count (AC #3) and auto-expands
//     the ancestor hubs of a DEEP match so it becomes visible (AC #1);
//   - prev/next step the cursor with wrap-around (AC #3);
//   - a zero-hit query shows the localized no-matches hint + disables stepping
//     and dims nothing (AC #3);
//   - clearing the query (clear button / Esc) restores the PRE-search expand
//     snapshot, collapsing search-forced expansion while preserving the user's
//     manual expansion (AC #2);
//   - the Esc-to-clear handler is IME-guarded (no clear while composing) (AC #1).
//
// The graph now renders the Canvas-2D mind-map on EVERY viewport (the mobile
// vertical outline was removed). The canvas is a Canvas-2D painter, not DOM, so
// this test drives search through a MockCanvas that surfaces the visible node
// set + the shared search props as data attributes, and exposes a per-node
// expand trigger (mirroring an affordance tap → onNodeClick(id, type, true)).

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor, act, fireEvent } from "@testing-library/react";

const realtimeCallbacks = new Map<string, () => void>();
vi.mock("@/contexts/realtime-context", () => ({
  useRealtimeEntityTypeEvent: (type: string, cb: () => void) => {
    realtimeCallbacks.set(type, cb);
  },
  usePresenceSubscription: () => {},
}));

vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>) => {
    void loader;
    return MockCanvas;
  },
}));

// MockCanvas mirrors the real canvas' prop contract and exposes what the tests
// need to observe: the visible node ids (so auto-expand / collapse is
// observable without a DOM tree), the shared search props, and a per-node
// expand trigger that calls onNodeClick with the affordance flag set (an
// expandable hub's +/- tap).
function MockCanvas({
  nodes,
  matchIds,
  currentMatchId,
  centerNodeId,
  onNodeClick,
}: {
  nodes: { id: string; type: string; title: string; hasAffordance?: boolean }[];
  matchIds?: ReadonlySet<string> | null;
  currentMatchId?: string | null;
  centerNodeId?: string | null;
  onNodeClick: (id: string, type: string, onAffordance: boolean) => void;
}) {
  return (
    <div
      data-testid="force-canvas"
      data-node-count={nodes.length}
      data-visible-ids={nodes.map((n) => n.id).join(",")}
      data-match-count={matchIds ? matchIds.size : "null"}
      data-current-match={currentMatchId ?? ""}
      data-center-node={centerNodeId ?? ""}
    >
      {nodes.map((n) => (
        <button
          key={n.id}
          data-testid={`expand-${n.id}`}
          onClick={() => onNodeClick(n.id, n.type, true)}
        >
          {n.title}
        </button>
      ))}
    </div>
  );
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

// Stable translator: interpolate {current}/{total} for the search count;
// otherwise echo the key. Kept at module scope so `t` identity is stable.
const stableTranslator = (key: string, vars?: Record<string, unknown>) => {
  if (vars && "current" in vars && "total" in vars) {
    return `${vars.current} / ${vars.total}`;
  }
  if (vars && "count" in vars) return `${key}:${vars.count}`;
  return key;
};
vi.mock("next-intl", () => ({
  useTranslations: () => stableTranslator,
}));

import { ResourceGraph } from "../resource-graph";

const PROJECT = "p-0000-0000-0000-000000000001";
const USER = "u-0000-0000-0000-000000000001";

// idea-1 ─derive→ prop-1 ─derive→ task-1, task-2     (deep, collapsed by default)
// task-solo : standalone (no proposal) — always visible.
// Both deep tasks' titles contain "find me"; nothing else does.
const PAYLOAD = {
  nodes: [
    { uuid: "idea-1", type: "idea", title: "Alpha idea" },
    { uuid: "prop-1", type: "proposal", title: "Alpha proposal", sourceIdeaUuids: ["idea-1"] },
    { uuid: "task-1", type: "task", title: "Find me one", proposalUuid: "prop-1" },
    { uuid: "task-2", type: "task", title: "Find me two", proposalUuid: "prop-1" },
    { uuid: "task-solo", type: "task", title: "Unrelated standalone", proposalUuid: null },
  ],
  edges: [
    { from: "idea-1", to: "prop-1", kind: "derive" },
    { from: "prop-1", to: "task-1", kind: "derive" },
    { from: "prop-1", to: "task-2", kind: "derive" },
  ],
};

// The canvas renders on all viewports now; matchMedia is polyfilled to a stable
// (desktop) value so useIsMobile is inert — search behavior is viewport-agnostic.
function setViewport(narrow: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: narrow,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  realtimeCallbacks.clear();
  vi.restoreAllMocks();
  setViewport(false); // desktop → full control panel is always shown
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
    function () {};
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

function renderGraph() {
  return render(<ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />);
}

// Convenience: the comma-joined visible node ids the canvas received.
function visibleIds(view: ReturnType<typeof render>): string[] {
  const attr = view.getByTestId("force-canvas").getAttribute("data-visible-ids") ?? "";
  return attr === "" ? [] : attr.split(",");
}

describe("ResourceGraph — node search state + controls", () => {
  it("renders the search box on the control card once the graph loads (AC #1)", async () => {
    const view = renderGraph();
    await waitFor(() => view.getByTestId("force-canvas"));
    const input = view.getByTestId("graph-search-input");
    // It is a real shadcn <input> (data-slot), not a raw element.
    expect(input.getAttribute("data-slot")).toBe("input");
    // No count/nav while the query is blank (not searching).
    expect(view.queryByTestId("graph-search-nav")).toBeNull();
  });

  it("typing a deep query auto-expands ancestor hubs and shows current/total count (AC #1, #3)", async () => {
    const view = renderGraph();
    await waitFor(() => view.getByTestId("force-canvas"));

    // Collapsed by default: the deep matches are hidden under collapsed hubs.
    expect(visibleIds(view)).not.toContain("task-1");
    expect(visibleIds(view)).not.toContain("prop-1");

    await act(async () => {
      fireEvent.change(view.getByTestId("graph-search-input"), {
        target: { value: "find me" },
      });
    });

    // Auto-expand reveals both deep matches; count settles at "1 / 2".
    await waitFor(() => {
      expect(visibleIds(view)).toContain("task-1");
      expect(visibleIds(view)).toContain("task-2");
      expect(view.getByTestId("graph-search-count").textContent).toBe("1 / 2");
    });
  });

  it("prev/next step the current-match cursor with wrap-around (AC #3)", async () => {
    const view = renderGraph();
    await waitFor(() => view.getByTestId("force-canvas"));

    await act(async () => {
      fireEvent.change(view.getByTestId("graph-search-input"), {
        target: { value: "find me" },
      });
    });
    await waitFor(() =>
      expect(view.getByTestId("graph-search-count").textContent).toBe("1 / 2"),
    );

    const count = () => view.getByTestId("graph-search-count").textContent;
    const next = view.getByTestId("graph-search-next");
    const prev = view.getByTestId("graph-search-prev");

    await act(async () => fireEvent.click(next));
    expect(count()).toBe("2 / 2");
    // next past the last wraps to the first.
    await act(async () => fireEvent.click(next));
    expect(count()).toBe("1 / 2");
    // prev before the first wraps to the last.
    await act(async () => fireEvent.click(prev));
    expect(count()).toBe("2 / 2");
  });

  it("a zero-hit query shows the no-matches hint and disables stepping (AC #3)", async () => {
    const view = renderGraph();
    await waitFor(() => view.getByTestId("force-canvas"));

    await act(async () => {
      fireEvent.change(view.getByTestId("graph-search-input"), {
        target: { value: "zzz-nothing-matches" },
      });
    });

    await waitFor(() =>
      expect(view.queryByTestId("graph-search-no-matches")).not.toBeNull(),
    );
    expect(view.queryByTestId("graph-search-count")).toBeNull();
    expect(
      (view.getByTestId("graph-search-prev") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (view.getByTestId("graph-search-next") as HTMLButtonElement).disabled,
    ).toBe(true);
    // No auto-expand on a zero-hit query: the deep hub stays collapsed.
    expect(visibleIds(view)).not.toContain("prop-1");
  });

  it("clearing restores the pre-search snapshot, preserving manual expansion (AC #2)", async () => {
    const view = renderGraph();
    await waitFor(() => view.getByTestId("force-canvas"));

    // Manually expand idea-1 BEFORE searching (reveals its proposal, level 1).
    await act(async () => {
      fireEvent.click(view.getByTestId("expand-idea-1"));
    });
    await waitFor(() => expect(visibleIds(view)).toContain("prop-1"));
    // prop-1 is NOT manually expanded — its tasks stay hidden.
    expect(visibleIds(view)).not.toContain("task-1");

    // Search: auto-expands prop-1 (level 2) so the deep tasks appear.
    await act(async () => {
      fireEvent.change(view.getByTestId("graph-search-input"), {
        target: { value: "find me" },
      });
    });
    await waitFor(() => expect(visibleIds(view)).toContain("task-1"));

    // Clear via the X button → restore snapshot { ideas: [idea-1], proposals: [] }.
    await act(async () => {
      fireEvent.click(view.getByTestId("graph-search-clear"));
    });

    await waitFor(() => {
      // search-forced level-2 expansion collapsed again.
      expect(visibleIds(view)).not.toContain("task-1");
      // manual level-1 expansion preserved.
      expect(visibleIds(view)).toContain("prop-1");
    });
    // The search session is over: count/nav gone, query cleared.
    expect(view.queryByTestId("graph-search-nav")).toBeNull();
    expect(
      (view.getByTestId("graph-search-input") as HTMLInputElement).value,
    ).toBe("");
  });

  it("Enter steps to the next match (wrap-around), but is IME-guarded while composing", async () => {
    const view = renderGraph();
    await waitFor(() => view.getByTestId("force-canvas"));
    const input = view.getByTestId("graph-search-input") as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { value: "find me" } });
    });
    await waitFor(() =>
      expect(view.getByTestId("graph-search-count").textContent).toBe("1 / 2"),
    );

    // Enter WHILE COMPOSING (IME) must NOT advance — the guard short-circuits.
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    });
    expect(view.getByTestId("graph-search-count").textContent).toBe("1 / 2");

    // Enter when NOT composing advances to the next match.
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(view.getByTestId("graph-search-count").textContent).toBe("2 / 2");

    // Enter on the last match wraps back to the first.
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(view.getByTestId("graph-search-count").textContent).toBe("1 / 2");

    // Shift+Enter steps to the PREVIOUS match (wrap-around to the last).
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    });
    expect(view.getByTestId("graph-search-count").textContent).toBe("2 / 2");

    // Enter with a query but zero matches is a no-op (no throw, no count).
    await act(async () => {
      fireEvent.change(input, { target: { value: "zzz-nothing" } });
    });
    await waitFor(() =>
      expect(view.queryByTestId("graph-search-no-matches")).not.toBeNull(),
    );
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(view.queryByTestId("graph-search-count")).toBeNull();
  });

  it("Esc clears the query when not composing, but is IME-guarded while composing (AC #1, #2)", async () => {
    const view = renderGraph();
    await waitFor(() => view.getByTestId("force-canvas"));
    const input = view.getByTestId("graph-search-input") as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { value: "find me" } });
    });
    await waitFor(() =>
      expect(view.getByTestId("graph-search-count").textContent).toBe("1 / 2"),
    );

    // Esc WHILE COMPOSING (IME) must NOT clear — the guard short-circuits.
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    });
    expect(input.value).toBe("find me");
    expect(view.queryByTestId("graph-search-nav")).not.toBeNull();

    // Esc when NOT composing clears the query and ends the session.
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    await waitFor(() => {
      expect(input.value).toBe("");
      expect(view.queryByTestId("graph-search-nav")).toBeNull();
    });
  });
});

// Integration convergence: the two spec scenarios that span more than one
// control — Q7=a type-filter exclusion through the live component, and the
// debounced camera centering on the CURRENT match.
describe("ResourceGraph — search integration (type filter + camera)", () => {
  it("excludes a filtered-out type from matches WITHOUT flipping the filter checkboxes (Q7=a)", async () => {
    const view = renderGraph();
    await waitFor(() => view.getByTestId("force-canvas"));

    // Baseline: "find me" matches the two deep TASK nodes → 1 / 2.
    await act(async () => {
      fireEvent.change(view.getByTestId("graph-search-input"), {
        target: { value: "find me" },
      });
    });
    await waitFor(() =>
      expect(view.getByTestId("graph-search-count").textContent).toBe("1 / 2"),
    );

    // Toggle the Task type OFF. shadcn's Checkbox is a Radix button exposing
    // aria-checked ("true"/"false"), not a native input.
    const taskCheckbox = view.getByLabelText("graph.filters.task");
    expect(taskCheckbox.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(taskCheckbox);
    });

    // Both matches were tasks → now zero hits → no-matches hint, count gone.
    await waitFor(() =>
      expect(view.queryByTestId("graph-search-no-matches")).not.toBeNull(),
    );
    expect(view.queryByTestId("graph-search-count")).toBeNull();

    // The search did NOT touch the OTHER checkboxes, and the one the user
    // toggled reflects only the user's action (unchecked), never flipped by search.
    expect(
      view.getByLabelText("graph.filters.task").getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      view.getByLabelText("graph.filters.idea").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      view.getByLabelText("graph.filters.proposal").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("debounced camera centers on the CURRENT match, not a stale first match, when stepping inside the debounce window", async () => {
    vi.useFakeTimers();
    try {
      const view = render(
        <ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />,
      );
      // Drain the mount fetch + effects under fake timers.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.change(view.getByTestId("graph-search-input"), {
          target: { value: "find me" },
        });
      });

      // Step to match #2 BEFORE the 200ms camera debounce fires (the race window).
      await act(async () => {
        fireEvent.click(view.getByTestId("graph-search-next"));
      });
      expect(view.getByTestId("graph-search-count").textContent).toBe("2 / 2");
      const currentAfterStep = view
        .getByTestId("force-canvas")
        .getAttribute("data-current-match");

      // Now let the debounce fire. It must recenter on the CURRENT match (#2),
      // not snap the camera back to the first match — otherwise the pink ring +
      // count (on #2) and the camera (on #1) desync.
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      const canvas = view.getByTestId("force-canvas");
      expect(canvas.getAttribute("data-center-node")).toBe(currentAfterStep);
      // And the count/ring did not move.
      expect(view.getByTestId("graph-search-count").textContent).toBe("2 / 2");
    } finally {
      vi.useRealTimers();
    }
  });
});
