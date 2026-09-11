// @vitest-environment jsdom
import React, { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import en from "../../../../../../../messages/en.json";
import zh from "../../../../../../../messages/zh.json";
import { IdeaActionsMenu } from "../panels/idea-actions-menu";

const mocks = vi.hoisted(() => ({
  start: vi.fn(), yolo: vi.fn(), reassign: vi.fn(), success: vi.fn(), error: vi.fn(),
  connections: [{ agentUuid: "agent-1", effectiveStatus: "online" }],
}));
vi.mock("@/contexts/agent-presence-context", () => ({ useAgentPresenceOptional: () => ({ connections: mocks.connections }) }));
vi.mock("@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/stage-advance-actions", () => ({
  startDevelopmentAction: mocks.start, yoloRequestedAction: mocks.yolo,
}));
vi.mock("@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/actions", () => ({ reassignIdeaInstanceNoWakeAction: mocks.reassign }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));

const callbacks = { onVerify: vi.fn(), onDerive: vi.fn(), onMove: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onStarted: vi.fn() };
const base = {
  ideaUuid: "idea-1", projectUuid: "project-1", assignee: { type: "agent", uuid: "agent-1" },
  assigneeName: "Agent", proposals: [{ status: "approved" }], tasks: [{ status: "open" }], busy: false, ...callbacks,
};
type Overrides = Partial<React.ComponentProps<typeof IdeaActionsMenu>>;
function Harness({ overrides = {}, locale = "en" }: { overrides?: Overrides; locale?: "en" | "zh" }) {
  const ref = useRef<HTMLButtonElement>(null);
  return <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    <IdeaActionsMenu {...base} triggerRef={ref} onCloseAutoFocus={(event) => { event.preventDefault(); ref.current?.focus(); }} {...overrides} />
  </NextIntlClientProvider>;
}
const instances = [1, 2].map((n) => ({ connectionUuid: `c${n}`, agentInstanceUuid: `i${n}`, host: `host-${n}`, cwd: `/repo-${n}`, effectiveStatus: "online", isOnline: true }));
function preview(outcome = "direct") {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { outcome, assigneeAgentUuid: "agent-1", onlineInstances: outcome === "pick" ? instances : outcome === "auto_pin" ? instances.slice(0, 1) : [] } }) }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connections = [{ agentUuid: "agent-1", effectiveStatus: "online" }];
  mocks.start.mockResolvedValue({ success: true });
  mocks.yolo.mockResolvedValue({ success: true });
  mocks.reassign.mockResolvedValue({ success: true });
  preview();
  window.history.replaceState(null, "", "/projects/project-1/dashboard?panel=old&tab=tasks&search=noise#hash");
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});
async function open(user: ReturnType<typeof userEvent.setup>) { await user.click(screen.getByRole("button", { name: "Actions" })); }

describe("Tracker Actions — real Radix interactions", () => {
  it("groups all actions with separated destructive Delete and no nested buttons", async () => {
    const user = userEvent.setup(); render(<Harness />); await open(user);
    expect(screen.getAllByRole("menuitem")).toHaveLength(9);
    expect(screen.getByRole("menuitem", { name: "Delete Idea" }).getAttribute("data-variant")).toBe("destructive");
    expect(screen.getByRole("menuitem", { name: "Delete Idea" }).previousElementSibling?.getAttribute("role")).toBe("separator");
    expect(document.querySelector("button button")).toBeNull();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Actions" }));
  });

  it("keeps unavailable actions focusable and explained; pointer/Enter/Space cannot run them", async () => {
    const user = userEvent.setup();
    render(<Harness overrides={{ stageReason: en.ideaTracker.lineage.containerHint, editReason: en.ideaTracker.panel.actions.editUnavailable }} />);
    await open(user);
    const item = screen.getByRole("menuitem", { name: "Start Development" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    const id = item.getAttribute("aria-describedby")!;
    expect(document.getElementById(id)?.textContent).toBe(en.ideaTracker.lineage.containerHint);
    act(() => item.focus());
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    await user.click(item);
    act(() => item.focus()); await user.keyboard("{Enter} ");
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.reassign).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Edit Idea" }).getAttribute("aria-disabled")).toBe("true");
  });

  it.each([
    { overrides: { assignee: null }, label: "Yolo", reason: en.yolo.errorAssigneeNotAgent },
    { overrides: { proposals: [] }, label: "Start Development", reason: en.startDevelopment.errorNoApprovedProposal },
    { overrides: { tasks: [{ status: "done" }] }, label: "Yolo", reason: en.yolo.completedHint },
    { overrides: { busy: true }, label: en.ideaTracker.lineage.deriveIdea, reason: en.ideaTracker.panel.actions.busy },
  ])("explains gate $reason", async ({ overrides, label, reason }) => {
    const user = userEvent.setup(); render(<Harness overrides={overrides} />); await open(user);
    const item = screen.getByRole("menuitem", { name: label });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain(reason);
  });

  it("responds to late stage data and presence updates without stale eligibility", async () => {
    const user = userEvent.setup();
    const view = render(<Harness overrides={{ stageReason: en.ideaTracker.panel.actions.loadingStage }} />);
    await open(user);
    expect(screen.getByRole("menuitem", { name: "Yolo" }).getAttribute("aria-disabled")).toBe("true");
    view.rerender(<Harness overrides={{ tasks: [{ status: "done" }] }} />);
    expect(screen.getByRole("menuitem", { name: "Yolo" }).textContent).toContain(en.yolo.completedHint);
    mocks.connections = [];
    view.rerender(<Harness />);
    expect(screen.getByRole("menuitem", { name: "Yolo" }).textContent).toContain(en.yolo.offlineHint);
    mocks.connections = [{ agentUuid: "agent-1", effectiveStatus: "online" }];
    view.rerender(<Harness />);
    expect(screen.getByRole("menuitem", { name: "Yolo" }).getAttribute("aria-disabled")).toBe("false");
  });

  it("copies canonical absolute link and exact UUID only after clipboard resolves", async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; })).mockResolvedValue(undefined);
    render(<Harness />); await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Copy link" }));
    expect(write).toHaveBeenCalledWith(`${window.location.origin}/projects/project-1/dashboard?panel=idea-1`);
    expect(mocks.success).not.toHaveBeenCalled(); await act(async () => resolve());
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith(en.ideaTracker.panel.actions.linkCopied));
    await open(user); await user.click(screen.getByRole("menuitem", { name: "Copy UUID" }));
    expect(write).toHaveBeenLastCalledWith("idea-1");
    expect(mocks.success).toHaveBeenLastCalledWith(en.ideaTracker.panel.actions.uuidCopied);
  });

  it.each(["missing", "rejected"])("reports %s clipboard without false success", async (mode) => {
    const user = userEvent.setup();
    if (mode === "missing") Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    else vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    render(<Harness />); await open(user); await user.click(screen.getByRole("menuitem", { name: "Copy UUID" }));
    expect(mocks.error).toHaveBeenCalledWith(en.ideaTracker.panel.actions.copyFailed);
    expect(mocks.success).not.toHaveBeenCalled(); await open(user); expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("Yolo keyboard confirmation survives menu closure; cancel restores focus without wake", async () => {
    const user = userEvent.setup(); render(<Harness />);
    act(() => screen.getByRole("button", { name: "Actions" }).focus()); await user.keyboard("{Enter}");
    act(() => screen.getByRole("menuitem", { name: "Yolo" }).focus()); await user.keyboard("{Enter}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByRole("alertdialog").contains(document.activeElement)).toBe(true);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.yolo).not.toHaveBeenCalled(); expect(mocks.reassign).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Actions" }));
  });

  it.each(["Start Development", "Yolo"])("%s picker survives menu closure and pins before waking", async (label) => {
    preview("pick"); const user = userEvent.setup(); render(<Harness />); await open(user);
    await user.click(screen.getByRole("menuitem", { name: label }));
    if (label === "Yolo") await user.click(screen.getByRole("button", { name: en.yolo.confirmCta }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.yolo).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: en.wakeCwdPicker.confirm }));
    await waitFor(() => expect(label === "Yolo" ? mocks.yolo : mocks.start).toHaveBeenCalledWith("idea-1"));
    expect(mocks.reassign).toHaveBeenCalledWith("idea-1", "agent-1", "i1");
    expect(mocks.reassign.mock.invocationCallOrder[0]).toBeLessThan((label === "Yolo" ? mocks.yolo : mocks.start).mock.invocationCallOrder[0]);
  });

  it.each(["Start Development", "Yolo"])("%s picker cancellation releases the gate without pin/wake", async (label) => {
    preview("pick"); const user = userEvent.setup(); render(<Harness />); await open(user);
    await user.click(screen.getByRole("menuitem", { name: label }));
    if (label === "Yolo") await user.click(screen.getByRole("button", { name: en.yolo.confirmCta }));
    await screen.findByRole("dialog"); await user.click(screen.getByRole("button", { name: en.wakeCwdPicker.cancel }));
    expect(mocks.reassign).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.yolo).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Actions" }));
    await open(user);
    for (const name of ["Start Development", "Yolo", "Delete Idea"]) {
      expect(screen.getByRole("menuitem", { name }).getAttribute("aria-disabled")).toBe("false");
    }
    await user.click(screen.getByRole("menuitem", { name: label }));
    if (label === "Yolo") await user.click(screen.getByRole("button", { name: en.yolo.confirmCta }));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: en.wakeCwdPicker.confirm }));
    await waitFor(() => expect(label === "Yolo" ? mocks.yolo : mocks.start).toHaveBeenCalledOnce());
  });

  it("uses Chinese menu, gate and clipboard feedback", async () => {
    const user = userEvent.setup(); vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<Harness locale="zh" overrides={{ busy: true }} />);
    await user.click(screen.getByRole("button", { name: zh.common.actions }));
    expect(screen.getByRole("menuitem", { name: zh.ideas.editIdea }).textContent).toContain(zh.ideaTracker.panel.actions.busy);
    await user.click(screen.getByRole("menuitem", { name: zh.ideaTracker.panel.actions.copyLink }));
    expect(mocks.success).toHaveBeenCalledWith(zh.ideaTracker.panel.actions.linkCopied);
  });

  it("keeps Yolo confirmation mounted if presence changes, but disables confirmation", async () => {
    const user = userEvent.setup(); const view = render(<Harness />); await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Yolo" }));
    mocks.connections = [];
    view.rerender(<Harness />);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: en.yolo.confirmCta }).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.yolo).not.toHaveBeenCalled();
  });

  it("blocks repeat and competing mutations while a wake is pending", async () => {
    let resolve!: (value: unknown) => void;
    mocks.start.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const user = userEvent.setup(); render(<Harness />); await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Start Development" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    await open(user);
    for (const name of ["Start Development", "Yolo", "Verify Elaborate", "Delete Idea", "Edit Idea"]) {
      const item = screen.getByRole("menuitem", { name });
      expect(item.getAttribute("aria-disabled")).toBe("true");
      await user.click(item);
    }
    expect(mocks.start).toHaveBeenCalledOnce(); expect(callbacks.onDelete).not.toHaveBeenCalled();
    expect(callbacks.onVerify).not.toHaveBeenCalled(); expect(mocks.yolo).not.toHaveBeenCalled();
    await act(async () => resolve({ success: true }));
    expect(callbacks.onStarted).toHaveBeenCalledOnce();
  });

  describe.each(["auto_pin", "pick"])("deferred %s flow", (outcome) => {
    it.each([
      ["Start Development", "success"], ["Yolo", "success"],
      ["Start Development", "failure"], ["Yolo", "failure"],
      ["Start Development", "throw"], ["Yolo", "throw"],
    ])("locks %s through pin+wake and releases after %s", async (label, result) => {
      preview(outcome);
      const pin = deferred<{ success: boolean }>();
      const wake = deferred<{ success: boolean }>();
      mocks.reassign.mockReturnValueOnce(pin.promise);
      const action = label === "Yolo" ? mocks.yolo : mocks.start;
      action.mockReturnValueOnce(wake.promise);
      const user = userEvent.setup(); render(<Harness />); await open(user);
      await user.click(screen.getByRole("menuitem", { name: label }));
      if (label === "Yolo") await user.click(screen.getByRole("button", { name: en.yolo.confirmCta }));
      if (outcome === "pick") {
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("button", { name: en.wakeCwdPicker.confirm }));
      }
      await waitFor(() => expect(mocks.reassign).toHaveBeenCalledOnce());
      expect(mocks.reassign).toHaveBeenCalledWith("idea-1", "agent-1", "i1");
      expect(action).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      await open(user);
      const assertLocked = async () => {
        for (const name of ["Start Development", "Yolo", "Verify Elaborate", "Delete Idea", "Edit Idea", en.ideaTracker.lineage.deriveIdea, en.ideas.actions.move]) {
          const item = screen.getByRole("menuitem", { name });
          expect(item.getAttribute("aria-disabled")).toBe("true");
          await user.click(item);
          act(() => item.focus()); await user.keyboard("{Enter} ");
        }
        expect(callbacks.onDelete).not.toHaveBeenCalled();
        expect(callbacks.onVerify).not.toHaveBeenCalled();
        expect(callbacks.onEdit).not.toHaveBeenCalled();
        expect(callbacks.onDerive).not.toHaveBeenCalled();
        expect(callbacks.onMove).not.toHaveBeenCalled();
        expect(screen.queryByRole("alertdialog")).toBeNull();
        expect(mocks.reassign).toHaveBeenCalledOnce();
        expect(label === "Yolo" ? mocks.start : mocks.yolo).not.toHaveBeenCalled();
      };
      await assertLocked();
      // Even a failed/thrown best-effort pin proceeds to exactly one wake,
      // without an unlocked render between the two deferred requests.
      await act(async () => {
        if (result === "throw") pin.reject(new Error("pin failed"));
        else pin.resolve({ success: result === "success" });
      });
      expect(action).toHaveBeenCalledOnce();
      await assertLocked();
      await act(async () => {
        if (result === "throw") wake.reject(new Error("wake failed"));
        else wake.resolve({ success: result === "success" });
      });
      expect(action).toHaveBeenCalledOnce();
      expect(screen.getByRole("menuitem", { name: "Delete Idea" }).getAttribute("aria-disabled")).toBe("false");
      if (result !== "success") {
        expect(mocks.error).toHaveBeenCalledWith(label === "Yolo" ? en.yolo.errorGeneric : en.startDevelopment.errorGeneric);
        expect(mocks.success).not.toHaveBeenCalled();
        // Error releases both the hook and the surface's own pending flag.
        expect(screen.getByRole("menuitem", { name: label }).getAttribute("aria-disabled")).toBe("false");
        await user.click(screen.getByRole("menuitem", { name: label }));
        if (label === "Yolo") await user.click(screen.getByRole("button", { name: en.yolo.confirmCta }));
        if (outcome === "pick") {
          await screen.findByRole("dialog");
          await user.click(screen.getByRole("button", { name: en.wakeCwdPicker.confirm }));
        }
        await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
      }
    });
  });

  it("does not submit an IME-composing Enter selection", async () => {
    const user = userEvent.setup(); render(<Harness />); await open(user);
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Yolo" }), { key: "Enter", isComposing: true });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
