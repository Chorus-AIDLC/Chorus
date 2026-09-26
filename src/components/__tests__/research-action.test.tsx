// @vitest-environment jsdom
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { IdeaActionsMenu } from "@/app/(dashboard)/projects/[uuid]/dashboard/panels/idea-actions-menu";

const mocks = vi.hoisted(() => ({
  eligibility: vi.fn(), dispatch: vi.fn(), openSession: vi.fn(),
  pinThenWake: vi.fn(),
  pinConfig: vi.fn(), agents: vi.fn(), instances: vi.fn(), assign: vi.fn(), reassign: vi.fn(),
  success: vi.fn(), error: vi.fn(), info: vi.fn(),
}));
vi.mock("@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/research-actions", () => ({
  researchEligibilityAction: mocks.eligibility, researchIdeaAction: mocks.dispatch,
}));
vi.mock("@/contexts/agent-presence-context", () => ({
  useAgentPresenceOptional: () => ({ openChatForSession: mocks.openSession }),
}));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error, info: mocks.info } }));
vi.mock("@/hooks/use-pin-then-wake", () => ({
  usePinThenWake: (config: unknown) => {
    mocks.pinConfig(config);
    return { start: mocks.pinThenWake, pickerState: null, confirmPick: vi.fn(), confirmTemporary: vi.fn(), cancelPick: vi.fn(), isResolving: false };
  },
}));
vi.mock("@/components/agent-presence/wake-cwd-picker-dialog", () => ({ WakeCwdPickerDialog: () => null }));
vi.mock("@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/actions", () => ({
  getPmAgentsAction: mocks.agents, getAgentInstancesAction: mocks.instances,
  claimIdeaToAgentAction: mocks.assign, reassignIdeaInstanceNoWakeAction: mocks.reassign,
}));
vi.mock("@/components/start-development-button", () => ({
  StartDevelopmentButton: ({ renderAction }: { renderAction: (v: unknown) => React.ReactNode }) =>
    renderAction({ label: "Start Development", busy: false, onSelect: vi.fn() }),
}));
vi.mock("@/components/yolo-button", () => ({
  YoloButton: ({ renderAction }: { renderAction: (v: unknown) => React.ReactNode }) =>
    renderAction({ label: "Yolo", busy: false, onSelect: vi.fn() }),
}));
vi.mock("next-intl", async () => {
  const en = (await import("../../../messages/en.json")).default;
  return { useTranslations: (namespace?: string) => (key: string) => {
    const path = (namespace ? `${namespace}.${key}` : key).split(".");
    let value: unknown = en;
    for (const part of path) value = (value as Record<string, unknown>)?.[part];
    return typeof value === "string" ? value : key;
  } };
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  mocks.agents.mockResolvedValue({ agents: [{ uuid: "agent", name: "Research agent" }], users: [] });
  mocks.instances.mockResolvedValue({ instances: [{
    connectionUuid: "connection", agentInstanceUuid: "instance", host: "host", cwd: "/project", effectiveStatus: "online",
  }], resolvedTarget: null });
  mocks.eligibility.mockResolvedValue({ eligible: true });
  mocks.dispatch.mockResolvedValue({ success: true, session: { uuid: "session", sessionId: "idea" }, agentUuid: "agent", turnUuid: "turn" });
  Object.defineProperty(window, "matchMedia", { writable: true, value: vi.fn(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) });
});
function setup(overrides: Record<string, unknown> = {}) {
  const onStarted = vi.fn();
  render(<IdeaActionsMenu
    ideaUuid="idea" projectUuid="project" assignee={{ type: "agent", uuid: "agent" }}
    proposals={[{ status: "approved" }]} tasks={[{ status: "open" }]}
    triggerRef={createRef()} busy={false}
    onVerify={vi.fn()} onDerive={vi.fn()} onSetParent={vi.fn()}
    onMove={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onStarted={onStarted}
    onCloseAutoFocus={vi.fn()} {...overrides}
  />);
  return { onStarted };
}
async function openMenu(mobile = false) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Actions" }));
  const research = screen.getByRole(mobile ? "button" : "menuitem", { name: "Research" });
  await waitFor(() => expect(mocks.eligibility).toHaveBeenCalledWith("idea"));
  return { user, research };
}
describe("Tracker Research action", () => {
  it.each([
    { proposals: [], tasks: [], verifyReason: "Pending answers" },
    { proposals: [{ status: "pending" }], tasks: [] },
    { proposals: [{ status: "approved" }], tasks: [{ status: "assigned" }] },
    { stageReason: "This is a theme", proposals: [], tasks: [] },
  ])("uses independent server eligibility during planning %#", async (overrides) => {
    setup(overrides);
    const { research } = await openMenu();
    await waitFor(() => expect(research.getAttribute("aria-disabled")).toBe("false"));
  });
  it("dispatches once and focuses the returned root conversation", async () => {
    const { onStarted } = setup();
    const { user, research } = await openMenu();
    await user.click(research);
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith("idea"));
    expect(mocks.openSession).toHaveBeenCalledWith({ uuid: "session", sessionId: "idea" });
    expect(onStarted).toHaveBeenCalledOnce();
    expect(mocks.success).toHaveBeenCalled();
  });
  it("opens a research-only picker for an agentless idea and preserves state until confirmation", async () => {
    setup({ assignee: null });
    const { user, research } = await openMenu();
    await user.click(research);
    expect(await screen.findByRole("dialog", { name: "Choose a research agent" })).toBeDefined();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Research agent" }));
    const submit = screen.getByRole("button", { name: "Request research" });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    await user.click(submit);
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith("idea", undefined, { agentUuid: "agent", instanceUuid: "instance" }));
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(mocks.reassign).not.toHaveBeenCalled();
  });
  it("cancelling agent selection makes no assignment or dispatch", async () => {
    setup({ assignee: null });
    const { user, research } = await openMenu();
    await user.click(research);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(mocks.reassign).not.toHaveBeenCalled();
  });
  it("uses existing pin-then-wake for an ambiguous new root, then retries after selection", async () => {
    mocks.dispatch.mockResolvedValueOnce({ success: false, errorCode: "assignment_required" });
    setup();
    const { user, research } = await openMenu();
    await user.click(research);
    await waitFor(() => expect(mocks.pinThenWake).toHaveBeenCalledOnce());
    expect(mocks.pinThenWake.mock.calls[0][0].ideaUuid).toBe("idea");
    await mocks.pinConfig.mock.calls.at(-1)![0].reassignNoWake("idea", "agent", "instance");
    await act(() => mocks.pinThenWake.mock.calls[0][0].wake());
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(mocks.dispatch).toHaveBeenLastCalledWith("idea", undefined, { agentUuid: "agent", instanceUuid: "instance" });
    expect(mocks.reassign).not.toHaveBeenCalled();
    expect(mocks.openSession).toHaveBeenCalledOnce();
  });
  it.each(["development_started", "already_running"])("disables %s with an accessible explanation", async (reason) => {
    mocks.eligibility.mockResolvedValue({ eligible: false, reason });
    setup();
    const { user, research } = await openMenu();
    expect(research.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(research.getAttribute("aria-describedby")!)).not.toBeNull();
    await user.click(research);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it.each(["permission_denied", "agent_offline", "origin_conflict", "target_changed"])("surfaces %s without a success claim", async (errorCode) => {
    mocks.dispatch.mockResolvedValue({ success: false, errorCode });
    setup();
    const { user, research } = await openMenu();
    await user.click(research);
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.openSession).not.toHaveBeenCalled();
  });
  it("renders and dispatches Research in the narrow-screen sheet", async () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList);
    setup();
    const { user, research } = await openMenu(true);
    await user.click(research);
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledOnce());
  });
  it("keeps disabled mobile explanation visible", async () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList);
    mocks.eligibility.mockResolvedValue({ eligible: false, reason: "development_started" });
    setup();
    const { research } = await openMenu(true);
    expect(research.textContent).toContain("Development has started");
    expect(research.getAttribute("aria-disabled")).toBe("true");
  });
});
