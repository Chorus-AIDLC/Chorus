// @vitest-environment jsdom
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { IdeaActionsMenu } from "@/app/(dashboard)/projects/[uuid]/dashboard/panels/idea-actions-menu";
import { ResearchAction } from "@/components/research-action";
import type { StageAction } from "@/components/stage-action";
import en from "../../../messages/en.json";
import zh from "../../../messages/zh.json";

const mocks = vi.hoisted(() => ({
  eligibility: vi.fn(), dispatch: vi.fn(), openSession: vi.fn(),
  pinThenWake: vi.fn(),
  pinConfig: vi.fn(), agents: vi.fn(), instances: vi.fn(), assign: vi.fn(), reassign: vi.fn(),
  success: vi.fn(), error: vi.fn(), info: vi.fn(),
  connections: [{ agentUuid: "agent", effectiveStatus: "online" }],
  provider: true, resolving: false, locale: "en" as "en" | "zh",
}));
vi.mock("@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/research-actions", () => ({
  researchEligibilityAction: mocks.eligibility, researchIdeaAction: mocks.dispatch,
}));
vi.mock("@/contexts/agent-presence-context", () => ({
  useAgentPresenceOptional: () => mocks.provider ? { connections: mocks.connections, setModalOpen: mocks.openSession } : null,
}));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error, info: mocks.info } }));
vi.mock("@/hooks/use-pin-then-wake", () => ({
  usePinThenWake: (config: unknown) => {
    mocks.pinConfig(config);
    return { start: mocks.pinThenWake, pickerState: null, confirmPick: vi.fn(), confirmTemporary: vi.fn(), cancelPick: vi.fn(), isResolving: mocks.resolving };
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
  const zh = (await import("../../../messages/zh.json")).default;
  return { useTranslations: (namespace?: string) => (key: string) => {
    const path = (namespace ? `${namespace}.${key}` : key).split(".");
    let value: unknown = mocks.locale === "zh" ? zh : en;
    for (const part of path) value = (value as Record<string, unknown>)?.[part];
    return typeof value === "string" ? value : key;
  } };
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.connections = [{ agentUuid: "agent", effectiveStatus: "online" }];
  mocks.provider = true;
  mocks.resolving = false;
  mocks.locale = "en";
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
  const tree = (updates = {}) => <IdeaActionsMenu
    ideaUuid="idea" projectUuid="project" assignee={{ type: "agent", uuid: "agent" }}
    proposals={[{ status: "approved" }]} tasks={[{ status: "open" }]}
    triggerRef={createRef()} busy={false}
    onVerify={vi.fn()} onDerive={vi.fn()} onSetParent={vi.fn()}
    onMove={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onStarted={onStarted}
    onCloseAutoFocus={vi.fn()} {...overrides} {...updates}
  />;
  const view = render(tree());
  return { onStarted, rerender: (updates = {}) => view.rerender(tree(updates)) };
}
async function openMenu(mobile = false) {
  const user = userEvent.setup();
  const messages = mocks.locale === "zh" ? zh : en;
  await user.click(screen.getByRole("button", { name: messages.common.actions }));
  const research = screen.getByRole(mobile ? "button" : "menuitem", { name: messages.research.button });
  await waitFor(() => expect(mocks.eligibility).toHaveBeenCalledWith("idea"));
  return { user, research };
}
describe("Tracker Research action", () => {
  it.each([
    { provider: false, connections: [{ agentUuid: "agent", effectiveStatus: "online" }] },
    { provider: true, connections: [] },
    { provider: true, connections: [{ agentUuid: "agent", effectiveStatus: "offline" }] },
    { provider: true, connections: [{ agentUuid: "agent", effectiveStatus: "stale" }] },
    { provider: true, connections: [{ agentUuid: "other", effectiveStatus: "online" }] },
    { provider: true, connections: [{ agentUuid: "instance", effectiveStatus: "online" }] },
  ])("fails closed for absent or ineffective owning-agent presence %#", async ({ provider, connections }) => {
    mocks.provider = provider;
    mocks.connections = connections;
    setup({ assignee: { type: "agent_instance", uuid: "instance", instance: { agentUuid: "agent" } } });
    const { user, research } = await openMenu();
    expect(research.getAttribute("aria-disabled")).toBe("true");
    expect(research.textContent).toContain(en.research.offlineHint);
    await user.click(research);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.pinThenWake).not.toHaveBeenCalled();
  });
  it("uses any effectively online connection of an instance's owning agent", async () => {
    mocks.connections = [
      { agentUuid: "agent", effectiveStatus: "stale" },
      { agentUuid: "agent", effectiveStatus: "online" },
    ];
    setup({ assignee: { type: "agent_instance", uuid: "instance", instance: { agentUuid: "agent" } } });
    const { user, research } = await openMenu();
    await waitFor(() => expect(research.getAttribute("aria-disabled")).toBe("false"));
    await user.click(research);
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith("idea");
  });
  it.each([false, true])("updates mounted assignment and presence without reloading, mobile=%s", async (mobile) => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList);
    const view = setup();
    const { user } = await openMenu(mobile);
    const research = () => screen.getByRole(mobile ? "button" : "menuitem", { name: "Research" });
    await waitFor(() => expect(research().getAttribute("aria-disabled")).toBe("false"));
    mocks.connections = [];
    view.rerender();
    expect(research().textContent).toContain(en.research.offlineHint);
    await user.click(research());
    mocks.connections = [{ agentUuid: "agent", effectiveStatus: "online" }];
    view.rerender();
    expect(research().getAttribute("aria-disabled")).toBe("false");
    for (const assignee of [null, { type: "user", uuid: "human" }]) {
      view.rerender({ assignee });
      expect(research().textContent).toContain(en.research.assignmentHint);
      await user.click(research());
    }
    view.rerender({ assignee: { type: "agent", uuid: "other" } });
    expect(research().textContent).toContain(en.research.offlineHint);
    await user.click(research());
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.agents).not.toHaveBeenCalled();
    mocks.connections = [{ agentUuid: "other", effectiveStatus: "online" }];
    view.rerender({ assignee: { type: "agent_instance", uuid: "instance", instance: { agentUuid: "other" } } });
    await waitFor(() => expect(research().getAttribute("aria-disabled")).toBe("false"));
    await user.click(research());
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith("idea");
  });
  it.each(["loading", "unknown", "development_started", "idea_completed"])("reconnection preserves eligibility restriction %s", async (reason) => {
    if (reason === "loading") mocks.eligibility.mockReturnValue(new Promise(() => {}));
    else if (reason === "unknown") mocks.eligibility.mockRejectedValue(new Error("unavailable"));
    else mocks.eligibility.mockResolvedValue({ eligible: false, reason });
    mocks.connections = [];
    const view = setup();
    const { user, research } = await openMenu();
    expect(research.textContent).toContain(en.research.offlineHint);
    mocks.connections = [{ agentUuid: "agent", effectiveStatus: "online" }];
    view.rerender();
    await waitFor(() => expect(research.textContent).toContain(en.research[reason as keyof typeof en.research]));
    expect(research.getAttribute("aria-disabled")).toBe("true");
    await user.click(research);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("shares the rendered reason with the handler, including external and resolving gates", async () => {
    let action!: StageAction;
    const tree = (disabledReason?: string) => <ResearchAction ideaUuid="idea"
      assignee={{ type: "agent", uuid: "agent" }} refreshKey="stable" disabledReason={disabledReason}
      onStarted={vi.fn()} renderAction={(value) => { action = value; return null; }} />;
    const view = render(tree("External block"));
    await waitFor(() => expect(mocks.eligibility).toHaveBeenCalled());
    expect(action.disabledReason).toBe("External block");
    act(() => action.onSelect());
    mocks.resolving = true;
    view.rerender(tree());
    expect(action.disabledReason).toBe(en.research.dispatching);
    act(() => action.onSelect());
    mocks.connections = [];
    view.rerender(tree());
    expect(action.disabledReason).toBe(en.research.dispatching);
    mocks.connections = [{ agentUuid: "agent", effectiveStatus: "online" }];
    view.rerender(tree());
    act(() => action.onSelect());
    mocks.resolving = false;
    mocks.connections = [];
    view.rerender(tree());
    expect(action.disabledReason).toBe(en.research.offlineHint);
    act(() => action.onSelect());
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.pinThenWake).not.toHaveBeenCalled();
  });
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
  it("dispatches once with queued feedback and refreshes without changing the conversation", async () => {
    const { onStarted } = setup();
    const { user, research } = await openMenu();
    await user.click(research);
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith("idea"));
    expect(mocks.openSession).not.toHaveBeenCalled();
    expect(onStarted).toHaveBeenCalledOnce();
    expect(mocks.success).toHaveBeenCalledWith("Research request queued.");
  });
  it("blocks only submission and allows another explicit request immediately after acceptance", async () => {
    let accept!: (result: unknown) => void;
    mocks.dispatch.mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
    const tree = <ResearchAction ideaUuid="idea" assignee={{ uuid: "agent", type: "agent" }}
      refreshKey="stable" onStarted={vi.fn()} renderAction={(action) =>
        <button disabled={!!action.disabledReason} onClick={action.onSelect}>{action.label}</button>} />;
    const view = render(tree);
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Research" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    act(() => { button.click(); button.click(); });
    expect(button.disabled).toBe(true);
    mocks.connections = [];
    view.rerender(React.cloneElement(tree));
    mocks.connections = [{ agentUuid: "agent", effectiveStatus: "online" }];
    view.rerender(React.cloneElement(tree));
    expect(button.disabled).toBe(true);
    await user.click(button);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    await act(async () => accept({ success: true, session: { uuid: "session", sessionId: "idea" } }));
    expect(button.disabled).toBe(false);
    expect(mocks.success).toHaveBeenCalledWith("Research request queued.");
    await user.click(button);
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(button.disabled).toBe(false);
    expect(mocks.openSession).not.toHaveBeenCalled();
  });
  it("keeps failed Research retryable on the same idea without changing chat", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("network unavailable"));
    const onStarted = vi.fn();
    render(<ResearchAction ideaUuid="idea" assignee={{ uuid: "agent", type: "agent" }}
      refreshKey="stable" onStarted={onStarted} renderAction={(action) =>
        <button disabled={!!action.disabledReason} onClick={action.onSelect}>{action.label}</button>} />);
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Research" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    await user.click(button);
    await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
    expect(button.disabled).toBe(false);
    expect(mocks.success).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    await user.click(button);
    expect(mocks.dispatch.mock.calls).toEqual([["idea"], ["idea"]]);
    expect(mocks.success).toHaveBeenCalledExactlyOnceWith("Research request queued.");
    expect(onStarted).toHaveBeenCalledOnce();
    expect(mocks.openSession).not.toHaveBeenCalled();
  });
  describe.each([false, true])("unavailable Research, mobile=%s", (mobile) => {
    it.each([
      ["en", null, false], ["zh", null, false],
      ["en", { type: "user", uuid: "human" }, false],
      ["zh", { type: "user", uuid: "human" }, false],
      ["en", { type: "agent", uuid: "agent" }, true],
      ["zh", { type: "agent", uuid: "agent" }, true],
    ] as const)("explains %s assignment %j (offline=%s) and blocks pointer/Enter/Space", async (locale, assignee, offline) => {
      mocks.locale = locale;
      if (offline) mocks.connections = [];
      vi.mocked(window.matchMedia).mockReturnValue({ matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList);
      setup({ assignee });
      const { user, research } = await openMenu(mobile);
      const reason = (locale === "zh" ? zh : en).research[offline ? "offlineHint" : "assignmentHint"];
      expect(research.getAttribute("aria-disabled")).toBe("true");
      expect(document.getElementById(research.getAttribute("aria-describedby")!)?.textContent).toBe(reason);
      act(() => research.focus());
      expect(document.activeElement).toBe(research);
      if (mobile) expect(research.textContent).toContain(reason);
      else expect((await screen.findByRole("tooltip")).textContent).toBe(reason);
      await user.click(research);
      act(() => research.focus());
      await user.keyboard("{Enter} ");
      expect(screen.getByRole(mobile ? "dialog" : "menu")).toBeTruthy();
      expect(screen.queryByRole("combobox")).toBeNull();
      expect(mocks.agents).not.toHaveBeenCalled();
      expect(mocks.pinThenWake).not.toHaveBeenCalled();
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(mocks.assign).not.toHaveBeenCalled();
      expect(mocks.reassign).not.toHaveBeenCalled();
    });
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
    expect(mocks.openSession).not.toHaveBeenCalled();
  });
  it("preserves the validated temporary cwd retry without generic assignment", async () => {
    mocks.dispatch.mockResolvedValueOnce({ success: false, errorCode: "assignment_required" });
    setup();
    const { user, research } = await openMenu();
    await user.click(research);
    await waitFor(() => expect(mocks.pinThenWake).toHaveBeenCalledOnce());
    const target = { agentUuid: "agent", validationRequestUuid: "validation" };
    await act(() => mocks.pinThenWake.mock.calls[0][0].wake(target));
    expect(mocks.dispatch).toHaveBeenLastCalledWith("idea", target, undefined);
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(mocks.reassign).not.toHaveBeenCalled();
    expect(mocks.success).toHaveBeenCalledExactlyOnceWith(en.research.dispatched);
  });
  it.each(["development_started", "idea_completed"])("disables %s with an accessible explanation", async (reason) => {
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
    const { onStarted } = setup();
    const { user, research } = await openMenu();
    await user.click(research);
    await waitFor(() => expect(mocks.error).toHaveBeenCalledExactlyOnceWith(en.research[errorCode as keyof typeof en.research]));
    expect(mocks.success).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
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
