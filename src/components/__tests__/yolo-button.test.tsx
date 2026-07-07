// @vitest-environment jsdom
//
// UI tests for the shared YoloButton (add-stage-advance-yolo). Covers:
//  - gating by the shared canRequestYolo predicate: shows at any incomplete
//    stage (incl. no proposal), hidden only when the idea is done or the
//    assignee is not an agent,
//  - AgentPresence-driven online state: offline disables with a hint,
//  - the CONFIRM step: clicking the button opens the dialog and does NOT call
//    yoloRequestedAction until the user confirms,
//  - server error codes surface as SPECIFIC i18n toasts (agent_offline distinct
//    from the generic failure).

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The Yolo trigger is now wrapped in a shadcn (Radix) Tooltip, whose
// PopperContent uses ResizeObserver — absent from jsdom. Without this stub,
// opening the tooltip (focus/click) throws unhandled errors that Vitest flags
// as potential false positives. Stub the browser APIs Radix's popper needs.
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

const { yoloRequestedActionMock, toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
  yoloRequestedActionMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock(
  "@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/stage-advance-actions",
  () => ({
    yoloRequestedAction: (...args: unknown[]) => yoloRequestedActionMock(...args),
  })
);

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

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

import { YoloButton } from "@/components/yolo-button";

const agentAssignee = { type: "agent", uuid: "agent-1" };
// Default: an early-stage idea (no proposal yet) — Yolo must still show.
const HAPPY_PROPS = {
  ideaUuid: "idea-1",
  assignee: agentAssignee,
  proposals: [] as { status: string }[],
  tasks: [] as { status: string }[],
};

beforeEach(() => {
  vi.clearAllMocks();
  presenceValue.current = {
    connections: [{ agentUuid: "agent-1", effectiveStatus: "online" }],
  };
});

describe("YoloButton — render gating", () => {
  it("renders enabled at an early stage (agent assignee, no proposal, online)", () => {
    render(<YoloButton {...HAPPY_PROPS} />);
    const btn = screen.getByRole<HTMLButtonElement>("button", { name: "Yolo" });
    expect(btn.disabled).toBe(false);
  });

  it("renders on a building-stage idea (approved proposal + unfinished task) — coexists with Start Development", () => {
    render(
      <YoloButton
        {...HAPPY_PROPS}
        proposals={[{ status: "approved" }]}
        tasks={[{ status: "in_progress" }]}
      />
    );
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Yolo" }).disabled).toBe(false);
  });

  it("does not render for a fully-done idea (approved proposal + all tasks done/closed)", () => {
    render(
      <YoloButton
        {...HAPPY_PROPS}
        proposals={[{ status: "approved" }]}
        tasks={[{ status: "done" }, { status: "closed" }]}
      />
    );
    expect(screen.queryByRole("button", { name: "Yolo" })).toBeNull();
  });

  it("does not render for a non-agent assignee", () => {
    render(<YoloButton {...HAPPY_PROPS} assignee={{ type: "user", uuid: "u1" }} />);
    expect(screen.queryByRole("button", { name: "Yolo" })).toBeNull();
  });
});

describe("YoloButton — presence gating", () => {
  it("disables with the offline hint when the agent has no online connection", () => {
    presenceValue.current = {
      connections: [{ agentUuid: "agent-1", effectiveStatus: "offline" }],
    };
    render(<YoloButton {...HAPPY_PROPS} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Yolo" }).disabled).toBe(true);
    expect(screen.getByText(/assigned agent is offline/i)).toBeTruthy();
  });

  it("treats a missing presence provider as offline, never online", () => {
    presenceValue.current = null;
    render(<YoloButton {...HAPPY_PROPS} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Yolo" }).disabled).toBe(true);
  });
});

describe("YoloButton — confirm dialog + click behavior", () => {
  it("opens the confirm dialog and does NOT call the action until the user confirms", async () => {
    yoloRequestedActionMock.mockResolvedValue({ success: true });
    render(<YoloButton {...HAPPY_PROPS} />);

    // Clicking the button opens the dialog but must NOT fire the action yet.
    await userEvent.click(screen.getByRole("button", { name: "Yolo" }));
    expect(screen.getByText(/drive this idea all the way to done|drive this idea|automatically/i)).toBeTruthy();
    expect(yoloRequestedActionMock).not.toHaveBeenCalled();

    // Confirming fires the action.
    await userEvent.click(screen.getByRole("button", { name: "Run Yolo" }));
    await waitFor(() => {
      expect(yoloRequestedActionMock).toHaveBeenCalledWith("idea-1");
      expect(toastSuccessMock).toHaveBeenCalled();
    });
  });

  it("cancelling the dialog does not call the action", async () => {
    render(<YoloButton {...HAPPY_PROPS} />);
    await userEvent.click(screen.getByRole("button", { name: "Yolo" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(yoloRequestedActionMock).not.toHaveBeenCalled();
  });

  it("surfaces the agent-offline rejection as its SPECIFIC message, not the generic one", async () => {
    yoloRequestedActionMock.mockResolvedValue({ success: false, errorCode: "agent_offline" });
    render(<YoloButton {...HAPPY_PROPS} />);

    await userEvent.click(screen.getByRole("button", { name: "Yolo" }));
    await userEvent.click(screen.getByRole("button", { name: "Run Yolo" }));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(/offline/i));
    });
    expect(toastErrorMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/^Failed to start Yolo$/)
    );
  });

  it("maps assignee_not_agent and unknown error codes to their own messages", async () => {
    const cases: [string, RegExp][] = [
      ["assignee_not_agent", /not an agent/i],
      ["unknown", /failed to start yolo/i],
    ];
    for (const [errorCode, pattern] of cases) {
      toastErrorMock.mockClear();
      yoloRequestedActionMock.mockResolvedValue({ success: false, errorCode });
      const { unmount } = render(<YoloButton {...HAPPY_PROPS} />);
      await userEvent.click(screen.getByRole("button", { name: "Yolo" }));
      await userEvent.click(screen.getByRole("button", { name: "Run Yolo" }));
      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(pattern));
      });
      unmount();
    }
  });
});
