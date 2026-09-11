// @vitest-environment jsdom
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import en from "../../../../../../../messages/en.json";
import { IdeaDetailPanel } from "../panels/idea-detail-panel";

const mocks = vi.hoisted(() => ({
  getIdea: vi.fn(), proposals: vi.fn(), tasks: vi.fn(), elaboration: vi.fn(), verify: vi.fn(), update: vi.fn(), delete: vi.fn(),
  refresh: vi.fn(), close: vi.fn(), reassign: vi.fn(), yolo: vi.fn(), start: vi.fn(),
}));
vi.mock("@/hooks/use-progress-router", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/contexts/realtime-context", () => ({ useRealtimeEntityTypeEvent: () => {} }));
vi.mock("@/contexts/agent-presence-context", () => ({ useAgentPresenceOptional: () => null }));
vi.mock("../panels/actions", () => ({ getIdeaAction: mocks.getIdea, getTaskAction: vi.fn(), getProposalsForIdeaAction: mocks.proposals, getTasksForProposalAction: mocks.tasks }));
vi.mock("@/app/(dashboard)/projects/[uuid]/ideas/actions", () => ({ updateIdeaAction: mocks.update, deleteIdeaAction: mocks.delete }));
vi.mock("@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/actions", () => ({ reassignIdeaInstanceNoWakeAction: mocks.reassign }));
vi.mock("@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/elaboration-actions", () => ({ getElaborationAction: mocks.elaboration, verifyElaborationAction: mocks.verify }));
vi.mock("@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/stage-advance-actions", () => ({ startDevelopmentAction: mocks.start, yoloRequestedAction: mocks.yolo }));
vi.mock("../panels/elaboration-view", () => ({ ElaborationView: () => null }));
vi.mock("../panels/proposal-view", () => ({ ProposalView: () => null }));
vi.mock("../panels/overview-timeline", () => ({ OverviewTimeline: () => null }));
vi.mock("../panels/reports-list", () => ({ ReportsList: () => null }));
vi.mock("../panels/task-list-view", () => ({ TaskListView: () => null }));
vi.mock("../panels/activity-comments-view", () => ({ ActivityCommentsView: () => null }));
vi.mock("@/app/(dashboard)/projects/[uuid]/tasks/task-detail-panel", () => ({ TaskDetailPanel: () => null }));
vi.mock("../panels/document-panel", () => ({ DocumentPanel: () => null }));
vi.mock("../panels/move-idea-dialog", () => ({ MoveIdeaDialog: ({ open }: { open: boolean }) => open ? <div role="dialog">Move</div> : null }));
vi.mock("../panels/set-parent-dialog", () => ({ SetParentDialog: ({ open }: { open: boolean }) => open ? <div role="dialog">Set parent</div> : null }));
vi.mock("../new-idea-dialog", () => ({ NewIdeaDialog: ({ open }: { open: boolean }) => open ? <div role="dialog">Derive</div> : null }));
vi.mock("@/app/(dashboard)/projects/[uuid]/ideas/assign-idea-modal", () => ({ AssignIdeaModal: () => null }));
vi.mock("@/components/references-section", () => ({ ReferencesSection: () => null }));
vi.mock("@/components/active-session-indicator", () => ({ ActiveSessionIndicator: () => null }));

const idea = { uuid: "idea-1", title: "Test idea", content: "Body", status: "elaborating", derivedStatus: "researching", badgeHint: null, createdAt: "2026-09-01T00:00:00Z", assignee: { type: "agent", uuid: "agent-1", name: "Agent" }, elaborationStatus: "validating", isContainer: false };
function Panel({ uuid = "idea-1" }: { uuid?: string }) {
  return <NextIntlClientProvider locale="en" messages={en}>
    <IdeaDetailPanel ideaUuid={uuid} projectUuid="project-1" currentUserUuid="user-1" onClose={mocks.close} />
  </NextIntlClientProvider>;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getIdea.mockImplementation(async (uuid: string) => ({ success: true, data: { ...idea, uuid } }));
  mocks.proposals.mockResolvedValue({ success: true, data: [] });
  mocks.tasks.mockResolvedValue({ success: true, data: [] });
  mocks.elaboration.mockResolvedValue({ success: true, data: { rounds: [{ status: "validating" }] } });
  mocks.update.mockResolvedValue({ success: true }); mocks.delete.mockResolvedValue({ success: true });
  mocks.verify.mockResolvedValue({ success: true }); mocks.reassign.mockResolvedValue({ success: true });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { outcome: "direct", onlineInstances: [] } }) }));
  window.history.replaceState(null, "", "/projects/project-1/dashboard?panel=idea-1");
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture = () => false; Element.prototype.setPointerCapture = () => {}; Element.prototype.releasePointerCapture = () => {}; Element.prototype.scrollIntoView = () => {};
});
async function open(user: ReturnType<typeof userEvent.setup>) { await user.click(await screen.findByRole("button", { name: "Actions" })); }

describe("Tracker panel action integration", () => {
  it("has independent Close, no footer, and inline Save/Cancel while editing", async () => {
    const user = userEvent.setup(); const view = render(<Panel />); await open(user);
    expect(view.container.querySelector(".border-t")).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Edit Idea" }));
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    const title = screen.getByRole("textbox", { name: en.ideas.titleLabel });
    await user.clear(title); await user.type(title, "Updated");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.closest('[data-slot="scroll-area"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" }).closest('[data-slot="scroll-area"]')).toBeTruthy();
    await user.click(save);
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ ideaUuid: "idea-1", projectUuid: "project-1", title: "Updated", content: "Body" }));
    await open(user); await user.click(screen.getByRole("menuitem", { name: "Edit Idea" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(mocks.close).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Actions" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close" })); expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("Delete confirmation survives menu closure, cancels without mutation, and restores focus", async () => {
    const user = userEvent.setup(); render(<Panel />); await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Delete Idea" }));
    expect(screen.queryByRole("menu")).toBeNull(); expect(screen.getByRole("alertdialog")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Actions" }));
    await open(user); await user.click(screen.getByRole("menuitem", { name: "Delete Idea" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(mocks.delete).toHaveBeenCalledWith("idea-1", "project-1"); expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("Verify uses shared elaboration gates, waits for late answers, then runs original wake", async () => {
    let resolve!: (value: unknown) => void;
    mocks.elaboration.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const user = userEvent.setup(); render(<Panel />); await open(user);
    const verify = screen.getByRole("menuitem", { name: "Verify Elaborate" });
    expect(verify.getAttribute("aria-disabled")).toBe("true");
    await act(async () => resolve({ success: true, data: { rounds: [{ status: "pending_answers" }] } }));
    await waitFor(() => expect(verify.textContent).toContain(en.ideaTracker.panel.actions.verifyUnavailable));
    await user.click(verify); expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("Verify enabled path wakes and shows inline feedback", async () => {
    const user = userEvent.setup(); render(<Panel />); await open(user);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Verify Elaborate" }).getAttribute("aria-disabled")).toBe("false"));
    await user.click(screen.getByRole("menuitem", { name: "Verify Elaborate" }));
    await waitFor(() => expect(mocks.verify).toHaveBeenCalledWith("idea-1"));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("container progression stays visible but disabled; derive and move remain usable", async () => {
    mocks.getIdea.mockResolvedValue({ success: true, data: { ...idea, isContainer: true } });
    const user = userEvent.setup(); render(<Panel />); await open(user);
    for (const name of ["Verify Elaborate", "Start Development", "Yolo"]) {
      expect(screen.getByRole("menuitem", { name }).getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByRole("menuitem", { name }).textContent).toContain(en.ideaTracker.lineage.containerHint);
    }
    expect(screen.getByRole("menuitem", { name: en.ideas.actions.move }).getAttribute("aria-disabled")).toBe("false");
    await user.click(screen.getByRole("menuitem", { name: en.ideaTracker.lineage.deriveIdea }));
    expect(screen.getByRole("dialog").textContent).toBe("Derive");
  });

  it("opens one consistently named parent action from Actions and removes the old inline button", async () => {
    const user = userEvent.setup();
    render(<Panel />);
    expect(screen.queryByRole("button", { name: en.ideaTracker.lineage.setParent })).toBeNull();
    expect(screen.queryByRole("button", { name: en.ideaTracker.lineage.changeParent })).toBeNull();
    await open(user);
    await user.click(screen.getByRole("menuitem", { name: en.ideaTracker.lineage.setParentTitle }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog").textContent).toBe("Set parent");
  });

  it("keeps the elaborated edit lock visible and blocks mutations during a container update", async () => {
    let resolve!: (value: unknown) => void;
    mocks.getIdea.mockResolvedValue({ success: true, data: { ...idea, status: "elaborated" } });
    mocks.update.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const user = userEvent.setup(); render(<Panel />); await open(user);
    expect(screen.getByRole("menuitem", { name: "Edit Idea" }).textContent).toContain(en.ideaTracker.panel.actions.editUnavailable);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("switch"));
    await open(user);
    for (const item of screen.getAllByRole("menuitem").filter((item) => !item.textContent?.startsWith("Copy"))) {
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.textContent).toContain(en.ideaTracker.panel.actions.busy);
    }
    await act(async () => resolve({ success: true }));
  });

  it("Verify picker remains mounted after menu selection; cancel never verifies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: {
      outcome: "pick", assigneeAgentUuid: "agent-1", onlineInstances: [1, 2].map((n) => ({ connectionUuid: `c${n}`, agentInstanceUuid: `i${n}`, host: `h${n}`, cwd: `/repo${n}`, effectiveStatus: "online" })),
    } }) }));
    const user = userEvent.setup(); render(<Panel />); await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Verify Elaborate" }));
    expect(await screen.findByRole("dialog")).toBeTruthy(); expect(screen.queryByRole("menu")).toBeNull();
    await user.click(screen.getByRole("button", { name: en.wakeCwdPicker.cancel }));
    expect(mocks.verify).not.toHaveBeenCalled(); expect(mocks.reassign).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Actions" }));
  });

  it("waits for proposals AND tasks before trusting Yolo's completion gate", async () => {
    let resolveProposals!: (value: unknown) => void;
    let resolveTasks!: (value: unknown) => void;
    mocks.proposals.mockImplementation(() => new Promise((r) => { resolveProposals = r; }));
    mocks.tasks.mockImplementation(() => new Promise((r) => { resolveTasks = r; }));
    const user = userEvent.setup(); render(<Panel />); await open(user);
    expect(screen.getByRole("menuitem", { name: "Yolo" }).textContent).toContain(en.ideaTracker.panel.actions.loadingStage);
    await act(async () => resolveProposals({ success: true, data: [{ uuid: "p1", status: "approved" }] }));
    await waitFor(() => expect(mocks.tasks).toHaveBeenCalled());
    expect(screen.getByRole("menuitem", { name: "Yolo" }).textContent).toContain(en.ideaTracker.panel.actions.loadingStage);
    await act(async () => resolveTasks({ success: true, data: [{ uuid: "t1", title: "Done", status: "done" }] }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Yolo" }).textContent).toContain(en.yolo.completedHint));
  });

  it("resets modal/edit state when the URL selects another idea, ignoring late old data", async () => {
    const user = userEvent.setup(); const view = render(<Panel />); await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Delete Idea" }));
    view.rerender(<Panel uuid="idea-2" />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Delete Idea" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    expect(mocks.delete).toHaveBeenCalledWith("idea-2", "project-1");
  });
});
