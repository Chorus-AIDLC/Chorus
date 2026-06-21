// @vitest-environment jsdom
//
// Regression for the reported bug: "stay on the Dashboard → follow an idea link
// (notification / search / toast / agent-presence) → URL changes to ?panel=<id>
// but the right-hand idea detail panel does not open/switch."
//
// This drives the REAL usePanelUrl hook (only useSearchParams is mocked, exactly
// as Next re-renders consumers on soft navigation) through IdeaTracker, and
// asserts the IdeaDetailPanel renders for the idea named in the URL — and
// switches when the URL changes. The pre-fix hook ignored useSearchParams, so
// the panel marker never appeared / never switched.

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { IdeaTracker } from "../idea-tracker";
import type { TrackerGroupsResult, TrackerIdeaItem } from "@/services/idea.service";

// Controllable URL query string standing in for the live address bar that
// useSearchParams() reflects. Tests mutate it, then re-render the tree.
let mockParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => mockParams,
}));

vi.mock("@/contexts/realtime-context", () => ({
  useRealtimeEntityTypeEvent: () => {},
}));

// IdeaDetailPanel is the thing the bug failed to render/switch. Stub it to a
// marker that echoes the ideaUuid prop so we can assert which idea is open.
vi.mock("../panels/idea-detail-panel", () => ({
  IdeaDetailPanel: ({ ideaUuid }: { ideaUuid: string }) => (
    <div data-testid="detail-panel">{ideaUuid}</div>
  ),
}));

vi.mock("../idea-tracker-stats", () => ({
  IdeaTrackerStats: () => <div data-testid="stats-view" />,
}));
vi.mock("../idea-status-group", () => ({
  IdeaStatusGroup: ({ status, ideas }: { status: string; ideas: unknown[] }) => (
    <div data-testid="status-group">{`${status}:${ideas.length}`}</div>
  ),
}));
vi.mock("../idea-lineage-tree", () => ({
  IdeaLineageTree: ({ ideas }: { ideas: unknown[] }) => (
    <div data-testid="lineage-tree">{ideas.length}</div>
  ),
}));
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

const flatTracker: TrackerGroupsResult = { groups: { todo: [idea()] }, counts: { todo: 1 } };

const baseProps = {
  projectUuid: PROJECT,
  currentUserUuid: "u1",
  initialTrackerData: flatTracker,
  initialStatsData: {
    stats: {
      ideas: { total: 1, open: 1 },
      tasks: { total: 0, inProgress: 0, todo: 0, toVerify: 0, done: 0 },
      proposals: { total: 0, pending: 0 },
      documents: { total: 0 },
    },
    recentActivities: [],
  },
};

beforeEach(() => {
  mockParams = new URLSearchParams();
  window.history.replaceState(null, "", `/projects/${PROJECT}/dashboard`);
});

describe("Dashboard idea panel — soft navigation sync (regression)", () => {
  it("opens the detail panel for the idea named in ?panel= on the current URL", () => {
    mockParams = new URLSearchParams("panel=idea-A");
    render(<IdeaTracker {...baseProps} />);
    expect(screen.getByTestId("detail-panel").textContent).toBe("idea-A");
  });

  it("switches the open panel when the URL changes to a different ?panel= (soft nav)", () => {
    mockParams = new URLSearchParams("panel=idea-A");
    const { rerender } = render(<IdeaTracker {...baseProps} />);
    expect(screen.getByTestId("detail-panel").textContent).toBe("idea-A");

    // Simulate a soft-nav idea link (notification / search / toast / presence):
    // the URL changes and Next re-renders useSearchParams consumers.
    mockParams = new URLSearchParams("panel=idea-B");
    rerender(<IdeaTracker {...baseProps} />);
    expect(screen.getByTestId("detail-panel").textContent).toBe("idea-B");
  });

  it("closes the panel when the URL loses its ?panel= param", () => {
    mockParams = new URLSearchParams("panel=idea-A");
    const { rerender } = render(<IdeaTracker {...baseProps} />);
    expect(screen.queryByTestId("detail-panel")).not.toBeNull();

    mockParams = new URLSearchParams("");
    rerender(<IdeaTracker {...baseProps} />);
    expect(screen.queryByTestId("detail-panel")).toBeNull();
  });

  it("does not open a panel when no ?panel= param is present", () => {
    mockParams = new URLSearchParams("");
    render(<IdeaTracker {...baseProps} />);
    expect(screen.queryByTestId("detail-panel")).toBeNull();
  });
});
