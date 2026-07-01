// @vitest-environment jsdom
//
// Node-search state + control UI in resource-graph.tsx (proposal task 2).
// Verifies the parent's search orchestration end-to-end through the real
// visible-set → outline pipeline (the helpers themselves are unit-tested in
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
// jsdom mocking mirrors resource-graph-outline.test.tsx (matchMedia polyfill,
// ResizeObserver stub, next/dynamic + panel stubs, module-level translator).

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
function MockCanvas({
  nodes,
  matchIds,
  currentMatchId,
}: {
  nodes: { id: string }[];
  matchIds?: ReadonlySet<string> | null;
  currentMatchId?: string | null;
}) {
  // Expose the shared search props so a test can assert they survive the
  // outline→canvas swap on resize (the canvas reads the SAME parent state).
  return (
    <div
      data-testid="force-canvas"
      data-node-count={nodes.length}
      data-match-count={matchIds ? matchIds.size : "null"}
      data-current-match={currentMatchId ?? ""}
    />
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

// Stable translator: interpolate {current}/{total} for the search count and
// {count} for the outline expand aria-label; otherwise echo the key. Kept at
// module scope so `t` identity is stable (a fresh closure would churn the
// parent's fetch effect).
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

// matchMedia polyfill (narrow = mobile outline path so visible rows are DOM).
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

// Flip every live MediaQueryList to the given match state and fire `change`
// (a real viewport resize on the same mounted instance).
function resizeViewport(narrow: boolean) {
  for (const mql of liveMqls) {
    mql.matches = narrow;
    for (const cb of mql.listeners) cb({ matches: narrow });
  }
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  realtimeCallbacks.clear();
  vi.restoreAllMocks();
  // jsdom lacks scrollIntoView; the outline calls it for the current match.
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
  setViewport(true); // narrow → outline rows observable
  return render(<ResourceGraph projectUuid={PROJECT} currentUserUuid={USER} />);
}

describe("ResourceGraph — node search state + controls", () => {
  it("renders the search box on the control card once the graph loads (AC #1)", async () => {
    const view = renderGraph();
    await waitFor(() => view.getByTestId("mindmap-outline"));
    const input = view.getByTestId("graph-search-input");
    // It is a real shadcn <input> (data-slot), not a raw element.
    expect(input.getAttribute("data-slot")).toBe("input");
    // No count/nav while the query is blank (not searching).
    expect(view.queryByTestId("graph-search-nav")).toBeNull();
  });

  it("typing a deep query auto-expands ancestor hubs and shows current/total count (AC #1, #3)", async () => {
    const view = renderGraph();
    await waitFor(() => view.getByTestId("mindmap-outline"));

    // Collapsed by default: the deep matches are hidden under collapsed hubs.
    expect(view.queryByText("Find me one")).toBeNull();
    expect(view.queryByText("Alpha proposal")).toBeNull();

    await act(async () => {
      fireEvent.change(view.getByTestId("graph-search-input"), {
        target: { value: "find me" },
      });
    });

    // Auto-expand reveals both deep matches; count settles at "1 / 2".
    await waitFor(() => {
      expect(view.queryByText("Find me one")).not.toBeNull();
      expect(view.queryByText("Find me two")).not.toBeNull();
      expect(view.getByTestId("graph-search-count").textContent).toBe("1 / 2");
    });
  });

  it("prev/next step the current-match cursor with wrap-around (AC #3)", async () => {
    const view = renderGraph();
    await waitFor(() => view.getByTestId("mindmap-outline"));

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
    await waitFor(() => view.getByTestId("mindmap-outline"));

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
    expect(view.queryByText("Alpha proposal")).toBeNull();
  });

  it("clearing restores the pre-search snapshot, preserving manual expansion (AC #2)", async () => {
    const view = renderGraph();
    await waitFor(() => view.getByTestId("mindmap-outline"));

    // Manually expand idea-1 BEFORE searching (reveals its proposal, level 1).
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "graph.outline.expand:1" }));
    });
    await waitFor(() => expect(view.queryByText("Alpha proposal")).not.toBeNull());
    // prop-1 is NOT manually expanded — its tasks stay hidden.
    expect(view.queryByText("Find me one")).toBeNull();

    // Search: auto-expands prop-1 (level 2) so the deep tasks appear.
    await act(async () => {
      fireEvent.change(view.getByTestId("graph-search-input"), {
        target: { value: "find me" },
      });
    });
    await waitFor(() => expect(view.queryByText("Find me one")).not.toBeNull());

    // Clear via the X button → restore snapshot { ideas: [idea-1], proposals: [] }.
    await act(async () => {
      fireEvent.click(view.getByTestId("graph-search-clear"));
    });

    await waitFor(() => {
      // search-forced level-2 expansion collapsed again.
      expect(view.queryByText("Find me one")).toBeNull();
      // manual level-1 expansion preserved.
      expect(view.queryByText("Alpha proposal")).not.toBeNull();
    });
    // The search session is over: count/nav gone, query cleared.
    expect(view.queryByTestId("graph-search-nav")).toBeNull();
    expect(
      (view.getByTestId("graph-search-input") as HTMLInputElement).value,
    ).toBe("");
  });

  it("Enter steps to the next match (wrap-around), but is IME-guarded while composing", async () => {
    const view = renderGraph();
    await waitFor(() => view.getByTestId("mindmap-outline"));
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
    await waitFor(() => view.getByTestId("mindmap-outline"));
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

// Integration convergence (proposal task 5): the two spec scenarios that span
// MORE than one renderer / control and weren't covered above — Q7=a type-filter
// exclusion through the live component, and search-state survival across the
// canvas↔outline viewport swap.
describe("ResourceGraph — search integration (type filter + viewport resize)", () => {
  it("excludes a filtered-out type from matches WITHOUT flipping the filter checkboxes (Q7=a)", async () => {
    const view = renderGraph(); // narrow → outline
    await waitFor(() => view.getByTestId("mindmap-outline"));

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

  it("preserves the active query/matches/current-match across a viewport resize (canvas↔outline)", async () => {
    // Start narrow (outline), search, step to the 2nd match.
    const view = renderGraph();
    await waitFor(() => view.getByTestId("mindmap-outline"));
    await act(async () => {
      fireEvent.change(view.getByTestId("graph-search-input"), {
        target: { value: "find me" },
      });
    });
    await waitFor(() =>
      expect(view.getByTestId("graph-search-count").textContent).toBe("1 / 2"),
    );
    await act(async () => fireEvent.click(view.getByTestId("graph-search-next")));
    expect(view.getByTestId("graph-search-count").textContent).toBe("2 / 2");

    // Resize to WIDE → the canvas renders from the SAME parent state.
    await act(async () => {
      resizeViewport(false);
    });
    await waitFor(() => view.getByTestId("force-canvas"));
    expect(view.queryByTestId("mindmap-outline")).toBeNull();

    // The query/count survive the swap (control card is shared)…
    expect(
      (view.getByTestId("graph-search-input") as HTMLInputElement).value,
    ).toBe("find me");
    expect(view.getByTestId("graph-search-count").textContent).toBe("2 / 2");
    // …and the canvas receives the SAME match set + current-match cursor.
    const canvas = view.getByTestId("force-canvas");
    expect(canvas.getAttribute("data-match-count")).toBe("2");
    expect(canvas.getAttribute("data-current-match")).not.toBe("");
  });
});
