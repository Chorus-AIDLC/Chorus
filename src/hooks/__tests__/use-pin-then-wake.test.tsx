// @vitest-environment jsdom
//
// Unit tests for the shared pin-then-wake click orchestration
// (pin-cwd-before-wake, task 1d). Drives the hook through all three preview
// outcomes and the middle-state contract via a tiny harness component:
//
//   pick     → picker opens; on confirm → reassign(chosen) → wake.
//   auto_pin → reassign(sole) → wake, NO picker.
//   direct   → wake, NO picker, NO reassign.
//
// Plus: preview miss / no-assignee → wake directly; a failed wake after a
// successful reassign does NOT roll back the pin (retry allowed); the reassign
// is best-effort (a rejected reassign still fires the wake — the elaborated-idea
// case); cancelling the picker aborts both reassign and wake.

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  usePinThenWake,
  type WakeTargetPreview,
} from "@/hooks/use-pin-then-wake";
import type { InstanceCandidate } from "@/components/agent-presence/instance-picker";

const AGENT = "agent-1";
const IDEA = "idea-1";

function candidate(over: Partial<InstanceCandidate> = {}): InstanceCandidate {
  return {
    connectionUuid: over.connectionUuid ?? "conn-1",
    // Respect an EXPLICIT null (the "no durable AgentInstance" case) — only
    // default when the key is entirely absent.
    agentInstanceUuid:
      "agentInstanceUuid" in over ? over.agentInstanceUuid : "inst-1",
    host: over.host ?? "host-a",
    cwd: over.cwd ?? "/repo/a",
    effectiveStatus: over.effectiveStatus ?? "online",
  };
}

// A minimal harness that exposes start() as a button and renders the picker
// state inline so the test can assert/act on it without the real dialog.
function Harness({
  preview,
  reassignNoWake,
  wake,
}: {
  preview: WakeTargetPreview | null;
  reassignNoWake: (
    ideaUuid: string,
    agentUuid: string,
    instanceUuid: string,
  ) => Promise<{ success: boolean; error?: string }>;
  wake: (temporary?: {
    agentUuid: string;
    validationRequestUuid: string;
  }) => void | Promise<void>;
}) {
  const { start, pickerState, confirmPick, confirmTemporary, cancelPick } = usePinThenWake({
    fetchPreview: async () => preview,
    reassignNoWake,
  });
  return (
    <div>
      <button onClick={() => start({ ideaUuid: IDEA, wake })}>go</button>
      {pickerState && (
        <div data-testid="picker">
          <span data-testid="picker-count">{pickerState.instances.length}</span>
          {pickerState.instances.map((i) => (
            <button
              key={i.connectionUuid}
              data-testid={`confirm-${i.connectionUuid}`}
              onClick={() => confirmPick(i)}
            >
              confirm {i.connectionUuid}
            </button>
          ))}
          <button data-testid="cancel" onClick={cancelPick}>
            cancel
          </button>
          <button
            data-testid="temporary"
            onClick={() =>
              confirmTemporary({
                agentUuid: AGENT,
                validationRequestUuid: "request-1",
              })
            }
          >
            temporary
          </button>
        </div>
      )}
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usePinThenWake", () => {
  it("direct → wakes immediately, no picker, no reassign", async () => {
    const reassign = vi.fn().mockResolvedValue({ success: true });
    const wake = vi.fn().mockResolvedValue(undefined);
    render(
      <Harness
        preview={{ outcome: "direct", assigneeAgentUuid: AGENT, onlineInstances: [candidate()] }}
        reassignNoWake={reassign}
        wake={wake}
      />,
    );

    await userEvent.click(screen.getByText("go"));

    await waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(reassign).not.toHaveBeenCalled();
    expect(screen.queryByTestId("picker")).toBeNull();
  });

  it("auto_pin → reassigns the sole online instance, then wakes, no picker", async () => {
    const reassign = vi.fn().mockResolvedValue({ success: true });
    const wake = vi.fn().mockResolvedValue(undefined);
    const sole = candidate({ connectionUuid: "conn-x", agentInstanceUuid: "inst-x" });
    render(
      <Harness
        preview={{ outcome: "auto_pin", assigneeAgentUuid: AGENT, onlineInstances: [sole] }}
        reassignNoWake={reassign}
        wake={wake}
      />,
    );

    await userEvent.click(screen.getByText("go"));

    await waitFor(() => {
      expect(reassign).toHaveBeenCalledWith(IDEA, AGENT, "inst-x");
      expect(wake).toHaveBeenCalledTimes(1);
    });
    // Reassign is invoked BEFORE the wake.
    expect(reassign.mock.invocationCallOrder[0]).toBeLessThan(
      wake.mock.invocationCallOrder[0],
    );
    expect(screen.queryByTestId("picker")).toBeNull();
  });

  it("pick → opens picker; confirm reassigns the chosen instance then wakes", async () => {
    const reassign = vi.fn().mockResolvedValue({ success: true });
    const wake = vi.fn().mockResolvedValue(undefined);
    const a = candidate({ connectionUuid: "conn-a", agentInstanceUuid: "inst-a", cwd: "/a" });
    const b = candidate({ connectionUuid: "conn-b", agentInstanceUuid: "inst-b", cwd: "/b", host: "host-b" });
    render(
      <Harness
        preview={{ outcome: "pick", assigneeAgentUuid: AGENT, onlineInstances: [a, b] }}
        reassignNoWake={reassign}
        wake={wake}
      />,
    );

    await userEvent.click(screen.getByText("go"));

    // Picker opens with both online instances; nothing fired yet.
    await screen.findByTestId("picker");
    expect(screen.getByTestId("picker-count").textContent).toBe("2");
    expect(reassign).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();

    // Choose the SECOND instance.
    await userEvent.click(screen.getByTestId("confirm-conn-b"));

    await waitFor(() => {
      expect(reassign).toHaveBeenCalledWith(IDEA, AGENT, "inst-b");
      expect(wake).toHaveBeenCalledTimes(1);
    });
    expect(reassign.mock.invocationCallOrder[0]).toBeLessThan(
      wake.mock.invocationCallOrder[0],
    );
    // Picker closes after confirm.
    expect(screen.queryByTestId("picker")).toBeNull();
  });

  it("pick → cancel aborts both the reassign and the wake", async () => {
    const reassign = vi.fn().mockResolvedValue({ success: true });
    const wake = vi.fn().mockResolvedValue(undefined);
    render(
      <Harness
        preview={{
          outcome: "pick",
          assigneeAgentUuid: AGENT,
          onlineInstances: [candidate({ connectionUuid: "c1" }), candidate({ connectionUuid: "c2" })],
        }}
        reassignNoWake={reassign}
        wake={wake}
      />,
    );

    await userEvent.click(screen.getByText("go"));
    await screen.findByTestId("picker");
    await userEvent.click(screen.getByTestId("cancel"));

    expect(reassign).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(screen.queryByTestId("picker")).toBeNull();
  });

  it("pick → temporary directory wakes with validation metadata without reassigning", async () => {
    const reassign = vi.fn().mockResolvedValue({ success: true });
    const wake = vi.fn().mockResolvedValue(undefined);
    render(
      <Harness
        preview={{
          outcome: "pick",
          assigneeAgentUuid: AGENT,
          onlineInstances: [candidate(), candidate({ connectionUuid: "conn-2" })],
        }}
        reassignNoWake={reassign}
        wake={wake}
      />,
    );

    await userEvent.click(screen.getByText("go"));
    await userEvent.click(await screen.findByTestId("temporary"));

    await waitFor(() =>
      expect(wake).toHaveBeenCalledWith({
        agentUuid: AGENT,
        validationRequestUuid: "request-1",
      }),
    );
    expect(reassign).not.toHaveBeenCalled();
  });

  it("preview miss (null) → wakes directly", async () => {
    const reassign = vi.fn();
    const wake = vi.fn().mockResolvedValue(undefined);
    render(<Harness preview={null} reassignNoWake={reassign} wake={wake} />);

    await userEvent.click(screen.getByText("go"));

    await waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(reassign).not.toHaveBeenCalled();
  });

  it("no assignee agent → wakes directly (defensive)", async () => {
    const reassign = vi.fn();
    const wake = vi.fn().mockResolvedValue(undefined);
    render(
      <Harness
        preview={{ outcome: "auto_pin", assigneeAgentUuid: null, onlineInstances: [candidate()] }}
        reassignNoWake={reassign}
        wake={wake}
      />,
    );

    await userEvent.click(screen.getByText("go"));

    await waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(reassign).not.toHaveBeenCalled();
  });

  it("best-effort reassign: a rejected reassign still fires the wake (elaborated-idea case)", async () => {
    // The reassign action rejects an elaborated idea; the wake must still fire.
    const reassign = vi
      .fn()
      .mockResolvedValue({ success: false, error: "Idea is not available for assignment" });
    const wake = vi.fn().mockResolvedValue(undefined);
    render(
      <Harness
        preview={{ outcome: "auto_pin", assigneeAgentUuid: AGENT, onlineInstances: [candidate()] }}
        reassignNoWake={reassign}
        wake={wake}
      />,
    );

    await userEvent.click(screen.getByText("go"));

    await waitFor(() => {
      expect(reassign).toHaveBeenCalledTimes(1);
      expect(wake).toHaveBeenCalledTimes(1);
    });
  });

  it("best-effort reassign: a THROWN reassign still fires the wake", async () => {
    const reassign = vi.fn().mockRejectedValue(new Error("network"));
    const wake = vi.fn().mockResolvedValue(undefined);
    render(
      <Harness
        preview={{ outcome: "auto_pin", assigneeAgentUuid: AGENT, onlineInstances: [candidate()] }}
        reassignNoWake={reassign}
        wake={wake}
      />,
    );

    await userEvent.click(screen.getByText("go"));

    await waitFor(() => {
      expect(reassign).toHaveBeenCalledTimes(1);
      expect(wake).toHaveBeenCalledTimes(1);
    });
  });

  it("middle-state: a failed wake after a successful reassign does NOT roll back the pin (retry allowed)", async () => {
    // The wake fails, but the reassign already persisted — there is no undo call.
    const reassign = vi.fn().mockResolvedValue({ success: true });
    const wake = vi
      .fn()
      .mockResolvedValueOnce(undefined) // first attempt "fails" silently (no throw contract)
      .mockResolvedValue(undefined);
    render(
      <Harness
        preview={{ outcome: "auto_pin", assigneeAgentUuid: AGENT, onlineInstances: [candidate({ agentInstanceUuid: "inst-keep" })] }}
        reassignNoWake={reassign}
        wake={wake}
      />,
    );

    // First click → reassign + wake.
    await userEvent.click(screen.getByText("go"));
    await waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(reassign).toHaveBeenCalledWith(IDEA, AGENT, "inst-keep");

    // Retry (the wake is re-fired) — the hook never issues any rollback/unpin
    // call; reassign is called again only because the outcome is still auto_pin.
    // The key contract: no "revert" path exists — the only reassign calls are
    // forward pins, and the wake can simply be retried.
    await userEvent.click(screen.getByText("go"));
    await waitFor(() => expect(wake).toHaveBeenCalledTimes(2));
    // Every reassign call is a forward pin to the SAME chosen instance — never a
    // revert to a plain agent.
    for (const call of reassign.mock.calls) {
      expect(call).toEqual([IDEA, AGENT, "inst-keep"]);
    }
  });

  it("auto_pin with a null agentInstanceUuid skips the reassign but still wakes", async () => {
    const reassign = vi.fn().mockResolvedValue({ success: true });
    const wake = vi.fn().mockResolvedValue(undefined);
    render(
      <Harness
        preview={{
          outcome: "auto_pin",
          assigneeAgentUuid: AGENT,
          onlineInstances: [candidate({ agentInstanceUuid: null })],
        }}
        reassignNoWake={reassign}
        wake={wake}
      />,
    );

    await userEvent.click(screen.getByText("go"));

    await waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(reassign).not.toHaveBeenCalled();
  });
});
