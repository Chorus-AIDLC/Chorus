// @vitest-environment jsdom
//
// UI tests for the dashboard idea-tracker IdeaDetailPanel footer "Verify
// Elaborate" button (task: Frontend Verify Elaborate button). Covers:
//  - the button is gated by the shared canVerifyElaboration predicate,
//  - clicking calls verifyElaborationAction and shows the queued hint on success,
//  - the failure path surfaces an inline error.
// Heavy tab/child views are stubbed so the test focuses on the footer contract.

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

const {
  getIdeaActionMock,
  getProposalsForIdeaActionMock,
  getTasksForProposalActionMock,
  getTaskActionMock,
  getElaborationActionMock,
  verifyElaborationActionMock,
} = vi.hoisted(() => ({
  getIdeaActionMock: vi.fn(),
  getProposalsForIdeaActionMock: vi.fn(),
  getTasksForProposalActionMock: vi.fn(),
  getTaskActionMock: vi.fn(),
  getElaborationActionMock: vi.fn(),
  verifyElaborationActionMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("../actions", () => ({
  getIdeaAction: (...args: unknown[]) => getIdeaActionMock(...args),
  getProposalsForIdeaAction: (...args: unknown[]) => getProposalsForIdeaActionMock(...args),
  getTasksForProposalAction: (...args: unknown[]) => getTasksForProposalActionMock(...args),
  getTaskAction: (...args: unknown[]) => getTaskActionMock(...args),
}));

vi.mock("@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/elaboration-actions", () => ({
  getElaborationAction: (...args: unknown[]) => getElaborationActionMock(...args),
  verifyElaborationAction: (...args: unknown[]) => verifyElaborationActionMock(...args),
}));

// Realtime SSE hooks are no-ops in the test.
vi.mock("@/contexts/realtime-context", () => ({
  useRealtimeEntityTypeEvent: () => {},
  useRealtimeEntityEvent: () => {},
}));

// Stub the tab/child views — they fetch their own data and are out of scope here.
vi.mock("../elaboration-view", () => ({ ElaborationView: () => <div data-testid="elaboration-view" /> }));
vi.mock("../proposal-view", () => ({ ProposalView: () => <div /> }));
vi.mock("../overview-timeline", () => ({ OverviewTimeline: () => <div /> }));
vi.mock("../reports-list", () => ({ ReportsList: () => <div /> }));
vi.mock("../task-list-view", () => ({ TaskListView: () => <div /> }));
vi.mock("../activity-comments-view", () => ({ ActivityCommentsView: () => <div /> }));
vi.mock("../document-panel", () => ({ DocumentPanel: () => <div /> }));
vi.mock("../move-idea-dialog", () => ({ MoveIdeaDialog: () => <div /> }));
vi.mock("../set-parent-dialog", () => ({ SetParentDialog: () => <div /> }));
vi.mock("../new-idea-dialog", () => ({ NewIdeaDialog: () => <div /> }));
vi.mock("@/app/(dashboard)/projects/[uuid]/tasks/task-detail-panel", () => ({ TaskDetailPanel: () => <div /> }));
vi.mock("@/app/(dashboard)/projects/[uuid]/ideas/assign-idea-modal", () => ({ AssignIdeaModal: () => <div /> }));

vi.mock("next-intl", async () => {
  const en = (await import("../../../../../../../../messages/en.json")).default as Record<string, unknown>;
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
  const tCache = new Map<string, (key: string, values?: Record<string, unknown>) => string>();
  return {
    useTranslations: (ns?: string) => {
      const k = ns ?? "";
      let fn = tCache.get(k);
      if (!fn) {
        fn = (key) => resolveKey(k, key);
        tCache.set(k, fn);
      }
      return fn;
    },
  };
});

(window as unknown as { matchMedia: typeof window.matchMedia }).matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  onchange: null,
  dispatchEvent: vi.fn(),
})) as unknown as typeof window.matchMedia;

import { IdeaDetailPanel } from "../idea-detail-panel";

const IDEA_UUID = "00000000-0000-4000-8000-000000000111";
const PROJECT_UUID = "00000000-0000-4000-8000-0000000000aa";
const USER_UUID = "00000000-0000-4000-8000-0000000000bb";

function ideaResponse(over: Record<string, unknown> = {}) {
  return {
    success: true as const,
    data: {
      uuid: IDEA_UUID,
      title: "My Idea",
      content: "body",
      status: "elaborating",
      elaborationStatus: "validating",
      derivedStatus: "researching",
      badgeHint: "answer_questions",
      assignee: { type: "agent", uuid: "agent-1", name: "PM Bot", assignedAt: null, assignedBy: null },
      createdAt: "2026-06-20T00:00:00.000Z",
      parent: null,
      parentUuid: null,
      children: [],
      descendantUuids: [],
      ...over,
    },
  };
}

function elaborationResponse(roundStatus: string) {
  return {
    success: true as const,
    data: {
      ideaUuid: IDEA_UUID,
      depth: "standard",
      status: "pending_answers",
      rounds: [
        {
          uuid: "round-1",
          roundNumber: 1,
          status: roundStatus,
          isAppended: false,
          createdBy: { type: "agent", uuid: "agent-1" },
          validatedAt: null,
          questions: [],
          createdAt: "2026-06-20T00:00:00.000Z",
        },
      ],
      summary: { totalQuestions: 1, answeredQuestions: 1, validatedRounds: 0, pendingRound: null },
    },
  };
}

function renderPanel() {
  return render(
    <IdeaDetailPanel
      ideaUuid={IDEA_UUID}
      projectUuid={PROJECT_UUID}
      currentUserUuid={USER_UUID}
      onClose={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getIdeaActionMock.mockResolvedValue(ideaResponse());
  getProposalsForIdeaActionMock.mockResolvedValue({ success: true, data: [] });
  getTasksForProposalActionMock.mockResolvedValue({ success: true, data: [] });
  getTaskActionMock.mockResolvedValue({ success: false });
  getElaborationActionMock.mockResolvedValue(elaborationResponse("answered"));
  verifyElaborationActionMock.mockResolvedValue({ success: true, data: {} });
});

describe("dashboard IdeaDetailPanel — Verify Elaborate footer button", () => {
  it("renders an enabled Verify Elaborate button when every round is answered", async () => {
    renderPanel();
    const btn = (await screen.findByRole("button", { name: "Verify Elaborate" })) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("does not render the button while a round is still pending", async () => {
    getElaborationActionMock.mockResolvedValue(elaborationResponse("pending_answers"));
    renderPanel();
    // The idea loads (Reassign button proves the footer rendered) but no verify button.
    await screen.findByRole("button", { name: "Reassign" });
    expect(screen.queryByRole("button", { name: "Verify Elaborate" })).toBeNull();
  });

  it("does not render the button once elaboration is resolved", async () => {
    getIdeaActionMock.mockResolvedValue(ideaResponse({ elaborationStatus: "resolved" }));
    renderPanel();
    await screen.findByRole("button", { name: "Reassign" });
    expect(screen.queryByRole("button", { name: "Verify Elaborate" })).toBeNull();
  });

  it("calls verifyElaborationAction on click and shows the queued hint on success", async () => {
    const user = userEvent.setup();
    renderPanel();
    const btn = await screen.findByRole("button", { name: "Verify Elaborate" });
    await user.click(btn);

    await waitFor(() => {
      expect(verifyElaborationActionMock).toHaveBeenCalledWith(IDEA_UUID);
    });
    expect(
      await screen.findByText("Verified — the agent will write the proposal when it's available."),
    ).toBeTruthy();
    // No manual "Create Proposal" fallback on the idea panel.
    expect(screen.queryByRole("button", { name: "Create Proposal" })).toBeNull();
  });

  it("surfaces an inline error and keeps the button when verify fails", async () => {
    verifyElaborationActionMock.mockResolvedValueOnce({ success: false, error: "boom" });
    const user = userEvent.setup();
    renderPanel();
    const btn = await screen.findByRole("button", { name: "Verify Elaborate" });
    await user.click(btn);

    await waitFor(() => expect(verifyElaborationActionMock).toHaveBeenCalled());
    expect(await screen.findByText("boom")).toBeTruthy();
  });
});
