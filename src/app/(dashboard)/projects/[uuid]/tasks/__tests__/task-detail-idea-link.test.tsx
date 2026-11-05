// @vitest-environment jsdom
//
// Task detail panel — direct Idea link for Quick Tasks (link-quick-task-to-idea D8):
//  - create mode offers an optional Idea Select (non-theme ideas) and passes ideaUuid,
//  - detail view shows the linked Idea as a source link,
//  - edit mode can change or clear the link (null, never ""),
//  - proposal tasks are never offered the Idea Select.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import en from "../../../../../../../messages/en.json";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  updateFields: vi.fn(),
  ideaOptions: vi.fn(),
  ideaSource: vi.fn(),
  proposalSource: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/hooks/use-progress-router", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }) }));
vi.mock("@/contexts/realtime-context", () => ({ useRealtimeEntityEvent: () => {}, useRealtimeEntityTypeEvent: () => {} }));
vi.mock("../[taskUuid]/actions", () => ({
  updateTaskStatusAction: vi.fn(),
  createTaskAction: mocks.createTask,
  updateTaskFieldsAction: mocks.updateFields,
  deleteTaskAction: vi.fn(),
  getTaskIdeaOptionsAction: mocks.ideaOptions,
}));
vi.mock("../[taskUuid]/criteria-actions", () => ({
  markCriteriaAction: vi.fn(), selfCheckCriteriaAction: vi.fn(), resetCriterionAction: vi.fn(),
}));
vi.mock("../[taskUuid]/activity-actions", () => ({ getTaskActivitiesAction: vi.fn().mockResolvedValue({ activities: [] }) }));
vi.mock("../[taskUuid]/source-actions", () => ({
  getTaskSourceAction: mocks.proposalSource,
  getTaskIdeaSourceAction: mocks.ideaSource,
}));
vi.mock("../[taskUuid]/dependency-actions", () => ({
  getTaskDependenciesAction: vi.fn().mockResolvedValue({ dependsOn: [], dependedBy: [] }),
  addTaskDependencyAction: vi.fn(),
  removeTaskDependencyAction: vi.fn(),
  getProjectTasksForDependencyAction: vi.fn().mockResolvedValue({ tasks: [] }),
}));
vi.mock("../session-actions", () => ({ getTaskSessionsAction: vi.fn().mockResolvedValue({ success: true, data: [] }) }));
vi.mock("../assign-task-modal", () => ({ AssignTaskModal: () => null }));
vi.mock("@/components/unified-comments", () => ({ UnifiedComments: () => null }));
vi.mock("@/components/references-section", () => ({ ReferencesSection: () => null }));
vi.mock("@/components/markdown-content", () => ({ MarkdownContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/mention-renderer", () => ({ ContentWithMentions: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { TaskDetailPanel } from "../task-detail-panel";

const PROJECT = "project-1";
const quickTask = {
  uuid: "task-1",
  title: "Quick fix",
  description: null,
  status: "open",
  priority: "medium",
  storyPoints: null,
  proposalUuid: null as string | null,
  ideaUuid: "idea-1" as string | null,
  acceptanceCriteriaItems: [],
  assignee: null,
};

function renderPanel(task: typeof quickTask | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <TaskDetailPanel task={task} projectUuid={PROJECT} currentUserUuid="user-1" onClose={vi.fn()} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
  mocks.ideaOptions.mockResolvedValue({
    success: true,
    data: [{ uuid: "idea-1", title: "Login idea" }, { uuid: "idea-2", title: "Billing idea" }],
    hasMore: false,
  });
  mocks.ideaSource.mockResolvedValue({ uuid: "idea-1", title: "Login idea" });
  mocks.proposalSource.mockResolvedValue({ uuid: "prop-1", title: "Proposal one" });
  mocks.createTask.mockResolvedValue({ success: true, taskUuid: "new" });
  mocks.updateFields.mockResolvedValue({ success: true });
});
afterEach(cleanup);

describe("TaskDetailPanel — Quick Task Idea link", () => {
  it("create mode offers the Idea Select and the created task stores ideaUuid", async () => {
    const user = userEvent.setup();
    renderPanel(null);
    await waitFor(() => expect(mocks.ideaOptions).toHaveBeenCalledWith(PROJECT));
    await user.type(screen.getByLabelText(en.tasks.titleLabel), "New quick task");
    await user.click(screen.getByRole("combobox", { name: en.tasks.ideaLink.label }));
    await user.click(await screen.findByRole("option", { name: "Billing idea" }));
    await user.click(screen.getByRole("button", { name: en.common.create }));
    await waitFor(() => expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({
      projectUuid: PROJECT, title: "New quick task", ideaUuid: "idea-2",
    })));
  });

  it("create mode without a choice sends no link (null)", async () => {
    const user = userEvent.setup();
    renderPanel(null);
    await user.type(screen.getByLabelText(en.tasks.titleLabel), "Unlinked");
    await user.click(screen.getByRole("button", { name: en.common.create }));
    await waitFor(() => expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({ ideaUuid: null })));
  });

  it("detail view shows the linked Idea as a source link to the idea panel", async () => {
    renderPanel(quickTask);
    const link = await screen.findByRole("link", { name: /Login idea/ });
    expect(link.getAttribute("href")).toBe(`/projects/${PROJECT}/dashboard?panel=idea-1`);
    expect(mocks.ideaSource).toHaveBeenCalledWith("idea-1");
    expect(mocks.proposalSource).not.toHaveBeenCalled();
  });

  it("edit mode clears the link by sending null", async () => {
    const user = userEvent.setup();
    renderPanel(quickTask);
    await user.click(await screen.findByRole("button", { name: en.common.edit }));
    await user.click(screen.getByRole("combobox", { name: en.tasks.ideaLink.label }));
    await user.click(await screen.findByRole("option", { name: en.tasks.ideaLink.none }));
    await user.click(screen.getByRole("button", { name: en.tasks.saveChanges }));
    await waitFor(() => expect(mocks.updateFields).toHaveBeenCalledWith(expect.objectContaining({
      taskUuid: "task-1", ideaUuid: null,
    })));
  });

  it("edit mode changes the link and omits ideaUuid when unchanged", async () => {
    const user = userEvent.setup();
    renderPanel(quickTask);
    await user.click(await screen.findByRole("button", { name: en.common.edit }));
    await user.click(screen.getByRole("button", { name: en.tasks.saveChanges }));
    await waitFor(() => expect(mocks.updateFields).toHaveBeenCalledTimes(1));
    expect(mocks.updateFields.mock.calls[0][0]).not.toHaveProperty("ideaUuid");

    await user.click(await screen.findByRole("button", { name: en.common.edit }));
    await user.click(screen.getByRole("combobox", { name: en.tasks.ideaLink.label }));
    await user.click(await screen.findByRole("option", { name: "Billing idea" }));
    await user.click(screen.getByRole("button", { name: en.tasks.saveChanges }));
    await waitFor(() => expect(mocks.updateFields).toHaveBeenLastCalledWith(expect.objectContaining({ ideaUuid: "idea-2" })));
  });

  it("proposal tasks get no Idea Select and no idea source link", async () => {
    const user = userEvent.setup();
    renderPanel({ ...quickTask, proposalUuid: "prop-1", ideaUuid: null });
    expect(await screen.findByRole("link", { name: /Proposal one/ })).toBeTruthy();
    expect(mocks.ideaSource).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: en.common.edit }));
    expect(screen.queryByRole("combobox", { name: en.tasks.ideaLink.label })).toBeNull();
    expect(mocks.ideaOptions).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: en.tasks.saveChanges }));
    await waitFor(() => expect(mocks.updateFields).toHaveBeenCalled());
    expect(mocks.updateFields.mock.calls[0][0]).not.toHaveProperty("ideaUuid");
  });
});
