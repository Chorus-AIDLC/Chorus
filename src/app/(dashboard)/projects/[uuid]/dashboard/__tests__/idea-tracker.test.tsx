// @vitest-environment jsdom
//
// Component-level tests for IdeaTracker — the wiring the pure-helper tests
// can't reach. Two regressions are guarded here:
//
//  1. Frozen-emptiness bug: the header "New Idea" button is suppressed while
//     the project is empty (the list shows its own centered CTA). The parent's
//     emptiness must track the *live* list, not the one-time SSR snapshot —
//     otherwise creating the first idea from the empty CTA leaves a populated
//     list with no way to add another idea until a full reload.
//
//  2. Hydration mismatch: the initial render must equal the adaptive default
//     on both server and client (localStorage is NOT read in the initializer),
//     with the stored per-project override applied only after mount. Reading
//     localStorage during the initial render diverges client HTML from server
//     HTML for any user with a stored preference.

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { IdeaTracker } from "../idea-tracker";
import type { IdeaCardItem } from "../idea-card";
import type { TrackerGroupsResult, TrackerIdeaItem } from "@/services/idea.service";

// Capture realtime subscribers so a test can fire a refetch on demand.
const realtimeCallbacks = new Map<string, () => void>();
vi.mock("@/contexts/realtime-context", () => ({
  useRealtimeEntityTypeEvent: (type: string, cb: () => void) => {
    realtimeCallbacks.set(type, cb);
  },
}));

// The panel URL hook touches window.history; stub it to stable no-ops.
vi.mock("@/hooks/use-panel-url", () => ({
  usePanelUrl: () => ({ selectedId: null, openPanel: vi.fn(), closePanel: vi.fn() }),
}));

// Stub the heavy leaf views so we test IdeaTracker + IdeaTrackerList wiring,
// not their internals. Each renders a distinct marker we can assert on.
vi.mock("../idea-tracker-stats", () => ({
  IdeaTrackerStats: () => <div data-testid="stats-view" />,
}));
vi.mock("../idea-status-group", () => ({
  IdeaStatusGroup: ({ status, ideas }: { status: string; ideas: IdeaCardItem[] }) => (
    <div data-testid="status-group">{`${status}:${ideas.length}`}</div>
  ),
}));
vi.mock("../idea-lineage-tree", () => ({
  IdeaLineageTree: ({ ideas }: { ideas: IdeaCardItem[] }) => (
    <div data-testid="lineage-tree">{ideas.length}</div>
  ),
}));
vi.mock("../panels/idea-detail-panel", () => ({ IdeaDetailPanel: () => null }));
vi.mock("../new-idea-dialog", () => ({ NewIdeaDialog: () => null }));

vi.mock("next-intl", async () => {
  const en = (await import("../../../../../../../messages/en.json")).default as Record<
    string,
    unknown
  >;
  function resolveKey(ns: string, key: string): string {
    const path = ns ? `${ns}.${key}`.split(".") : key.split(".");
    let node: unknown = en;
    for (const p of path) {
      if (node && typeof node === "object" && p in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[p];
      } else {
        return `${ns ? ns + "." : ""}${key}`;
      }
    }
    return typeof node === "string" ? node : `${ns ? ns + "." : ""}${key}`;
  }
  return {
    useTranslations: (ns?: string) => (key: string) => resolveKey(ns ?? "", key),
  };
});

const PROJECT = "11111111-1111-4111-8111-111111111111";

function idea(over: Partial<TrackerIdeaItem> = {}): TrackerIdeaItem {
  return {
    uuid: "i1",
    title: "First idea",
    status: "todo",
    derivedStatus: "todo",
    badgeHint: null,
    createdAt: "2026-06-14T00:00:00.000Z",
    parentUuid: null,
    childCount: 0,
    ...over,
  };
}

const emptyTracker: TrackerGroupsResult = { groups: {}, counts: {} };
const flatTracker: TrackerGroupsResult = { groups: { todo: [idea()] }, counts: { todo: 1 } };
const lineageTracker: TrackerGroupsResult = {
  groups: { todo: [idea({ childCount: 1 })] },
  counts: { todo: 1 },
};

const baseProps = {
  projectUuid: PROJECT,
  currentUserUuid: "u1",
  initialStatsData: {
    stats: {
      ideas: { total: 0, open: 0 },
      tasks: { total: 0, inProgress: 0, todo: 0, toVerify: 0, done: 0 },
      proposals: { total: 0, pending: 0 },
      documents: { total: 0 },
    },
    recentActivities: [],
  },
};

beforeEach(() => {
  realtimeCallbacks.clear();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("IdeaTracker — emptiness tracks the live list (regression #1)", () => {
  it("reveals the header New Idea button after the first idea arrives via realtime refresh", async () => {
    // Empty project: header New Idea is hidden, the list shows its own CTA.
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ success: true, data: flatTracker }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<IdeaTracker {...baseProps} initialTrackerData={emptyTracker} />);

    // Empty state: the list's centered CTA is shown; no populated groups yet.
    expect(screen.getByText("No ideas yet")).toBeTruthy();
    expect(screen.queryByTestId("status-group")).toBeNull();

    // A new idea is created elsewhere → SSE fires → the list refetches.
    await act(async () => {
      await realtimeCallbacks.get("idea")?.();
    });

    // The list is now populated AND a New Idea affordance is present again.
    await waitFor(() => {
      expect(screen.getByTestId("status-group")).toBeTruthy();
    });
    expect(screen.queryByText("No ideas yet")).toBeNull();
    expect(screen.getByRole("button", { name: "New Idea" })).toBeTruthy();
  });
});

describe("IdeaTracker — adaptive default & stored override (regression #2)", () => {
  it("does not read localStorage during the initial render (server == client markup)", () => {
    // A user previously chose Stats; the project, however, has lineage so the
    // adaptive default is Lineage. The initial render MUST reflect the adaptive
    // default — not the stored value — or hydration diverges from server HTML.
    window.localStorage.setItem(`chorus:dashboard-view:${PROJECT}`, "stats");

    const html = renderToString(
      <IdeaTracker {...baseProps} initialTrackerData={lineageTracker} />,
    );

    // Lineage view (the adaptive default) renders the tree, not the stats view.
    expect(html).toContain('data-testid="lineage-tree"');
    expect(html).not.toContain('data-testid="stats-view"');
  });

  it("applies the stored override after mount", async () => {
    window.localStorage.setItem(`chorus:dashboard-view:${PROJECT}`, "stats");

    render(<IdeaTracker {...baseProps} initialTrackerData={lineageTracker} />);

    // The post-mount effect swaps to the stored Stats view.
    await waitFor(() => {
      expect(screen.getByTestId("stats-view")).toBeTruthy();
    });
  });

  it("defaults to Lineage for a project with derivation when no preference is stored", () => {
    render(<IdeaTracker {...baseProps} initialTrackerData={lineageTracker} />);
    expect(screen.getByTestId("lineage-tree")).toBeTruthy();
    expect(screen.queryByTestId("stats-view")).toBeNull();
  });

  it("defaults to the flat Ideas list for a project without derivation", () => {
    render(<IdeaTracker {...baseProps} initialTrackerData={flatTracker} />);
    expect(screen.getByTestId("status-group")).toBeTruthy();
    expect(screen.queryByTestId("lineage-tree")).toBeNull();
  });
});

describe("IdeaTracker — switch stays reachable at zero ideas", () => {
  it("renders all three view options even when the project is empty", () => {
    render(<IdeaTracker {...baseProps} initialTrackerData={emptyTracker} />);
    expect(screen.getByRole("button", { name: /Ideas/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Lineage/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stats/ })).toBeTruthy();
  });
});
