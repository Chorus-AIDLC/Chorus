// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import en from "../../../../../../../messages/en.json";
import zh from "../../../../../../../messages/zh.json";
import ja from "../../../../../../../messages/ja.json";
import ko from "../../../../../../../messages/ko.json";

const mockGetPmAgentsAction = vi.hoisted(() => vi.fn());
const mockAssignAgent = vi.hoisted(() => vi.fn());
const mockGetInstances = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-progress-router", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("../[ideaUuid]/actions", () => ({
  claimIdeaAction: vi.fn(),
  claimIdeaToAgentAction: mockAssignAgent,
  claimIdeaToUserAction: vi.fn(),
  releaseIdeaAction: vi.fn(),
  getPmAgentsAction: mockGetPmAgentsAction,
  getAgentInstancesAction: mockGetInstances,
}));

vi.mock("@/components/ui/scrollable-dialog", () => ({
  ScrollableDialog: ({
    header,
    footer,
    children,
  }: {
    header: React.ReactNode;
    footer: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div role="dialog">
      {header}
      <div>{children}</div>
      {footer}
    </div>
  ),
  ScrollableDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

import { AssignIdeaModal } from "../assign-idea-modal";

const idea = {
  uuid: "idea-1",
  title: "Verbose Idea title that should not be repeated",
  content: "Verbose Idea description that should not be repeated in the modal.",
  status: "elaborated",
  assignee: {
    type: "agent",
    uuid: "agent-1",
    name: "Admin Claude",
  },
};

describe("AssignIdeaModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPmAgentsAction.mockResolvedValue({ agents: [], users: [] });
    mockGetInstances.mockResolvedValue({ instances: [] });
    mockAssignAgent.mockResolvedValue({ success: true });
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
  });
  afterEach(cleanup);

  it("omits repeated Idea copy while preserving assignment context and controls", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}><AssignIdeaModal
        idea={idea}
        projectUuid="project-1"
        currentUserUuid="user-1"
        onClose={vi.fn()}
      /></NextIntlClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("Admin Claude")).toBeTruthy();
    });

    expect(screen.queryByText(idea.title)).toBeNull();
    expect(screen.queryByText(idea.content)).toBeNull();
    expect(screen.getByText("Assign to myself")).toBeTruthy();
    expect(screen.getByText("Assign to specific PM Agent")).toBeTruthy();
    expect(screen.getByText("Assign to another user")).toBeTruthy();
    expect(screen.getByText("Release (Clear Assignee)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Assign" })).toBeTruthy();
  });

  it.each([["en", en], ["zh", zh], ["ja", ja], ["ko", ko]] as const)("preserves the localized shared agent picker and assignment in %s", async (locale, messages) => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onError = vi.fn();
    mockGetPmAgentsAction.mockResolvedValue({ agents: [{ uuid: "agent-pm", name: "Planner", roles: ["pm_agent"], ownerUuid: "user-1" }], users: [] });
    render(<NextIntlClientProvider locale={locale} messages={messages} onError={onError}><AssignIdeaModal idea={idea} projectUuid="project-1" currentUserUuid="user-1" onClose={onClose} /></NextIntlClientProvider>);
    await user.click(await screen.findByText(messages.ideas.orAssignToPmAgent));
    const trigger = screen.getByRole("combobox", { name: messages.ideas.selectPmAgent });
    expect(trigger).toHaveTextContent(messages.ideas.selectPmAgent);
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("option", { name: "Planner" }));
    await waitFor(() => expect(mockGetInstances).toHaveBeenCalledWith("agent-pm", "project-1"));
    expect(trigger).toHaveTextContent("Planner");
    await user.click(screen.getByRole("button", { name: messages.common.assign }));
    await waitFor(() => expect(mockAssignAgent).toHaveBeenCalledWith("idea-1", "agent-pm", undefined));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });
});
