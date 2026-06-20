// @vitest-environment jsdom
//
// UI tests for the /ideas route IdeaDetailPanel "Verify Elaborate" button —
// the replacement for the old human-facing "Create Proposal" button. Covers:
//  - gating by the shared canVerifyElaboration predicate,
//  - the old "Create Proposal" button is gone from this panel,
//  - clicking calls verifyElaborationAction and shows the queued hint,
//  - the failure path surfaces an inline error.

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

const {
  getElaborationActionMock,
  skipElaborationActionMock,
  verifyElaborationActionMock,
  getIdeaActivitiesActionMock,
  updateIdeaActionMock,
  deleteIdeaActionMock,
} = vi.hoisted(() => ({
  getElaborationActionMock: vi.fn(),
  skipElaborationActionMock: vi.fn(),
  verifyElaborationActionMock: vi.fn(),
  getIdeaActivitiesActionMock: vi.fn(),
  updateIdeaActionMock: vi.fn(),
  deleteIdeaActionMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/elaboration-actions", () => ({
  getElaborationAction: (...args: unknown[]) => getElaborationActionMock(...args),
  skipElaborationAction: (...args: unknown[]) => skipElaborationActionMock(...args),
  verifyElaborationAction: (...args: unknown[]) => verifyElaborationActionMock(...args),
}));

vi.mock("@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/activity-actions", () => ({
  getIdeaActivitiesAction: (...args: unknown[]) => getIdeaActivitiesActionMock(...args),
}));

vi.mock("@/app/(dashboard)/projects/[uuid]/ideas/actions", () => ({
  updateIdeaAction: (...args: unknown[]) => updateIdeaActionMock(...args),
  deleteIdeaAction: (...args: unknown[]) => deleteIdeaActionMock(...args),
}));

vi.mock("@/contexts/realtime-context", () => ({
  useRealtimeEntityTypeEvent: () => {},
  useRealtimeEntityEvent: () => {},
}));

// Stub heavy children — not under test here.
vi.mock("@/components/elaboration-panel", () => ({ ElaborationPanel: () => <div data-testid="elaboration-panel" /> }));
vi.mock("@/components/unified-comments", () => ({ UnifiedComments: () => <div /> }));
vi.mock("@/components/markdown-content", () => ({ MarkdownContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/mention-renderer", () => ({ ContentWithMentions: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("./assign-idea-modal", () => ({ AssignIdeaModal: () => <div /> }));
vi.mock("@/app/(dashboard)/projects/[uuid]/dashboard/panels/move-idea-dialog", () => ({ MoveIdeaDialog: () => <div /> }));

vi.mock("next-intl", async () => {
  const en = (await import("../../../../../../../messages/en.json")).default as Record<string, unknown>;
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

import { IdeaDetailPanel } from "../idea-detail-panel";

const IDEA_UUID = "00000000-0000-4000-8000-000000000111";
const PROJECT_UUID = "00000000-0000-4000-8000-0000000000aa";
const USER_UUID = "00000000-0000-4000-8000-0000000000bb";

function idea(over: Record<string, unknown> = {}) {
  return {
    uuid: IDEA_UUID,
    title: "My Idea",
    content: "body",
    status: "elaborating",
    elaborationStatus: "validating",
    assignee: { type: "agent", uuid: "agent-1", name: "PM Bot", assignedAt: null, assignedBy: null },
    createdAt: "2026-06-20T00:00:00.000Z",
    ...over,
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

function renderPanel(over: Record<string, unknown> = {}) {
  return render(
    <IdeaDetailPanel
      idea={idea(over) as never}
      projectUuid={PROJECT_UUID}
      currentUserUuid={USER_UUID}
      isUsedInProposal={false}
      onClose={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getIdeaActivitiesActionMock.mockResolvedValue({ activities: [] });
  getElaborationActionMock.mockResolvedValue(elaborationResponse("answered"));
  verifyElaborationActionMock.mockResolvedValue({ success: true, data: {} });
});

describe("/ideas IdeaDetailPanel — Verify Elaborate replaces Create Proposal", () => {
  it("renders an enabled Verify Elaborate button when every round is answered", async () => {
    renderPanel();
    const btn = (await screen.findByRole("button", { name: "Verify Elaborate" })) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    // The old human-facing Create Proposal button must be gone from this panel.
    expect(screen.queryByRole("button", { name: "Create Proposal" })).toBeNull();
    expect(screen.queryByText("Create Proposal")).toBeNull();
  });

  it("does not render the verify button while a round is still pending", async () => {
    getElaborationActionMock.mockResolvedValue(elaborationResponse("pending_answers"));
    renderPanel();
    await screen.findByRole("button", { name: "Reassign" });
    expect(screen.queryByRole("button", { name: "Verify Elaborate" })).toBeNull();
  });

  it("does not render the verify button once elaboration is resolved", async () => {
    getElaborationActionMock.mockResolvedValue(elaborationResponse("answered"));
    renderPanel({ elaborationStatus: "resolved" });
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
  });

  it("surfaces an inline error and keeps the button when verify fails", async () => {
    verifyElaborationActionMock.mockResolvedValueOnce({ success: false, error: "boom" });
    const user = userEvent.setup();
    renderPanel();
    const btn = await screen.findByRole("button", { name: "Verify Elaborate" });
    await user.click(btn);

    await waitFor(() => expect(verifyElaborationActionMock).toHaveBeenCalled());
    expect(await screen.findByText("boom")).toBeTruthy();
    // Button still present after failure (verified flag not set).
    expect(screen.getByRole("button", { name: "Verify Elaborate" })).toBeTruthy();
  });
});
