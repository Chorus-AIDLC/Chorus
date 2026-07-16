// @vitest-environment jsdom
//
// UI tests for the shared StartDevelopmentButton
// (add-stage-advance-start-development). Covers:
//  - gating by the shared canStartDevelopment predicate (render vs hidden),
//  - AgentPresence-driven online state: offline disables with a hint,
//  - clicking calls startDevelopmentAction; success shows the started hint,
//  - server error codes surface as SPECIFIC i18n toasts (agent_offline
//    distinct from the generic failure).

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The offline hint now rides a Radix Tooltip, whose Popper-based primitives use
// ResizeObserver + pointer-capture — absent from jsdom. Stub them so focusing
// the trigger to open the tooltip doesn't throw.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (typeof Element !== "undefined" && !Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
}

const { startDevelopmentActionMock, toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
  startDevelopmentActionMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock(
  "@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/stage-advance-actions",
  () => ({
    startDevelopmentAction: (...args: unknown[]) => startDevelopmentActionMock(...args),
  })
);

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

// Presence: overridable per-test. Default = the assignee agent online.
const { presenceValue } = vi.hoisted(() => ({
  presenceValue: {
    current: {
      connections: [
        { agentUuid: "agent-1", effectiveStatus: "online" },
      ] as { agentUuid: string; effectiveStatus: string }[],
    } as { connections: { agentUuid: string; effectiveStatus: string }[] } | null,
  },
}));

vi.mock("@/contexts/agent-presence-context", () => ({
  useAgentPresenceOptional: () => presenceValue.current,
}));

vi.mock("next-intl", async () => {
  const en = (await import("../../../messages/en.json")).default as Record<string, unknown>;
  return {
    useTranslations: (ns: string) => (key: string) => {
      let node: unknown = en;
      for (const p of `${ns}.${key}`.split(".")) {
        node =
          node && typeof node === "object" && p in (node as Record<string, unknown>)
            ? (node as Record<string, unknown>)[p]
            : undefined;
      }
      return typeof node === "string" ? node : `${ns}.${key}`;
    },
  };
});

import { StartDevelopmentButton } from "@/components/start-development-button";

const agentAssignee = { type: "agent", uuid: "agent-1" };
const HAPPY_PROPS = {
  ideaUuid: "idea-1",
  assignee: agentAssignee,
  proposals: [{ status: "approved" }],
  tasks: [{ status: "open" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  presenceValue.current = {
    connections: [{ agentUuid: "agent-1", effectiveStatus: "online" }],
  };
  // Pin-then-wake fetches GET /api/ideas/:uuid/wake-preview on click. Default to
  // the `direct` outcome so these tests exercise the wake path with no picker /
  // reassign (the pin-then-wake branches have their own unit tests in
  // use-pin-then-wake.test.tsx). A deterministic stub also removes the noisy
  // "Invalid URL" error jsdom's fetch would otherwise log.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        data: { outcome: "direct", assigneeAgentUuid: null, onlineInstances: [] },
      }),
    })),
  );
});

describe("StartDevelopmentButton — render gating", () => {
  it("renders enabled when preconditions hold and the agent is online", () => {
    render(<StartDevelopmentButton {...HAPPY_PROPS} />);
    const btn = screen.getByRole<HTMLButtonElement>("button", { name: "Start Development" });
    expect(btn.disabled).toBe(false);
  });

  it("does not render without an approved proposal", () => {
    render(
      <StartDevelopmentButton {...HAPPY_PROPS} proposals={[{ status: "pending" }]} />
    );
    expect(screen.queryByRole("button", { name: "Start Development" })).toBeNull();
  });

  it("does not render when every task is finished", () => {
    render(
      <StartDevelopmentButton
        {...HAPPY_PROPS}
        tasks={[{ status: "done" }, { status: "closed" }]}
      />
    );
    expect(screen.queryByRole("button", { name: "Start Development" })).toBeNull();
  });

  it("does not render for a non-agent assignee", () => {
    render(
      <StartDevelopmentButton {...HAPPY_PROPS} assignee={{ type: "user", uuid: "u1" }} />
    );
    expect(screen.queryByRole("button", { name: "Start Development" })).toBeNull();
  });
});

describe("StartDevelopmentButton — presence gating", () => {
  it("disables the button and moves the offline hint into a focusable tooltip trigger (no persistent inline text)", async () => {
    presenceValue.current = {
      connections: [{ agentUuid: "agent-1", effectiveStatus: "offline" }],
    };
    render(<StartDevelopmentButton {...HAPPY_PROPS} />);

    const btn = screen.getByRole<HTMLButtonElement>("button", { name: "Start Development" });
    expect(btn.disabled).toBe(true);

    // No persistent inline hint text is rendered up front — it only exists in
    // the tooltip, which is closed until the trigger is hovered/focused.
    expect(screen.queryByText(/enables on reconnect/i)).toBeNull();

    // The disabled button is wrapped by a focusable (tabIndex=0) span that owns
    // the tooltip trigger, so keyboard users can reveal the hint.
    const trigger = btn.closest<HTMLElement>('[tabindex="0"]');
    expect(trigger).toBeTruthy();

    // Focusing the trigger opens the tooltip; the shortened offline copy shows.
    fireEvent.focus(trigger!);
    await waitFor(() => {
      expect(screen.getAllByText(/enables on reconnect/i).length).toBeGreaterThan(0);
    });
  });

  it("treats a missing presence provider as offline, never online", () => {
    presenceValue.current = null;
    render(<StartDevelopmentButton {...HAPPY_PROPS} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Start Development" }).disabled).toBe(true);
  });

  it("matches an agent_instance assignee through its owning agent", () => {
    render(
      <StartDevelopmentButton
        {...HAPPY_PROPS}
        assignee={{
          type: "agent_instance",
          uuid: "inst-1",
          instance: { agentUuid: "agent-1" },
        }}
      />
    );
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Start Development" }).disabled).toBe(false);
  });
});

describe("StartDevelopmentButton — click behavior", () => {
  it("calls startDevelopmentAction and shows the started hint + success toast", async () => {
    startDevelopmentActionMock.mockResolvedValue({ success: true });
    const onStarted = vi.fn();
    render(<StartDevelopmentButton {...HAPPY_PROPS} onStarted={onStarted} />);

    await userEvent.click(screen.getByRole("button", { name: "Start Development" }));

    await waitFor(() => {
      expect(startDevelopmentActionMock).toHaveBeenCalledWith("idea-1");
      expect(toastSuccessMock).toHaveBeenCalledWith(
        expect.stringMatching(/Development started/)
      );
      expect(onStarted).toHaveBeenCalled();
    });
    // The button is replaced by the started hint.
    expect(screen.queryByRole("button", { name: "Start Development" })).toBeNull();
    expect(screen.getByText(/Development started/)).toBeTruthy();
  });

  it("surfaces the agent-offline rejection as its SPECIFIC message, not the generic one", async () => {
    startDevelopmentActionMock.mockResolvedValue({
      success: false,
      errorCode: "agent_offline",
    });
    render(<StartDevelopmentButton {...HAPPY_PROPS} />);

    await userEvent.click(screen.getByRole("button", { name: "Start Development" }));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringMatching(/offline/i)
      );
    });
    expect(toastErrorMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/^Failed to start development$/)
    );
    // The button stays for a retry.
    expect(screen.getByRole("button", { name: "Start Development" })).toBeTruthy();
  });

  it("maps each remaining error code to its own message", async () => {
    const cases: [string, RegExp][] = [
      ["no_approved_proposal", /no approved proposal/i],
      ["no_unfinished_tasks", /already finished/i],
      ["assignee_not_agent", /not an agent/i],
      ["unknown", /failed to start development/i],
    ];
    for (const [errorCode, pattern] of cases) {
      toastErrorMock.mockClear();
      startDevelopmentActionMock.mockResolvedValue({ success: false, errorCode });
      const { unmount } = render(<StartDevelopmentButton {...HAPPY_PROPS} />);
      await userEvent.click(screen.getByRole("button", { name: "Start Development" }));
      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(pattern));
      });
      unmount();
    }
  });
});
