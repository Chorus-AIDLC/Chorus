// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "../../../../../../../messages/en.json";

const { assign, loadAgents, loadInstances, refresh } = vi.hoisted(() => ({ assign: vi.fn(), loadAgents: vi.fn(), loadInstances: vi.fn(), refresh: vi.fn() }));
vi.mock("@/hooks/use-progress-router", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("../[taskUuid]/actions", () => ({
  claimTaskAction: vi.fn(), claimTaskToAgentAction: assign, claimTaskToUserAction: vi.fn(), releaseTaskAction: vi.fn(),
  getDeveloperAgentsAction: loadAgents, getAgentInstancesAction: loadInstances,
}));
import { AssignTaskModal } from "../assign-task-modal";

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  loadAgents.mockResolvedValue({ agents: [{ uuid: "agent-one", name: "Builder", roles: ["developer_agent"], ownerUuid: "user-one" }, { uuid: "agent-two", name: "Tester", roles: ["developer_agent"], ownerUuid: "user-one" }], users: [] });
  loadInstances.mockResolvedValue({ instances: [] });
  assign.mockResolvedValue({ success: true });
});
afterEach(cleanup);

it("uses the shared agent selector and submits the chosen agent without changing instance semantics", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<NextIntlClientProvider locale="en" messages={en}><AssignTaskModal task={{ uuid: "task-one", title: "Build feature", description: null, status: "open", assignee: null }} projectUuid="project-one" currentUserUuid="user-one" onClose={onClose} /></NextIntlClientProvider>);
  await user.click(await screen.findByText(en.assign.orAssignToAgent));
  expect(screen.getByRole("button", { name: "Assign" })).toBeDisabled();
  screen.getByRole("combobox", { name: en.tasks.selectAgent }).focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("option", { name: "Builder" })).toBeInTheDocument();
  await user.keyboard("t{Enter}");
  await waitFor(() => expect(loadInstances).toHaveBeenCalledWith("agent-two", "project-one"));
  expect(screen.getByRole("combobox", { name: en.tasks.selectAgent })).toHaveTextContent("Tester");
  await user.click(screen.getByRole("button", { name: "Assign" }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith("task-one", "agent-two", undefined));
  expect(onClose).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledOnce();
});
