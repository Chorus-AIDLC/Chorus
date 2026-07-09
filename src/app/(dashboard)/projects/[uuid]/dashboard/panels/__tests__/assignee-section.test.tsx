// @vitest-environment jsdom
//
// UI tests for AssigneeSection (refine-idea-panel-action-row). The assignee
// block doubles as the reassign trigger: when `editable && onReassign` are
// both provided it renders as a clickable button (with an accessible
// reassign/assign label) whose click invokes onReassign; otherwise it renders
// as a non-interactive block (default render unchanged), so callers that omit
// the props — and the elaborated (read-only) state — get no reassign entry.

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Radix has no bearing here (AssigneeSection uses a Tooltip), but its Popper
// primitives touch ResizeObserver / pointer-capture — absent from jsdom.
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

// AssigneeInstanceLine pulls in the agent-presence context; stub it to a bare
// span so this stays a focused unit test of AssigneeSection's own behavior.
vi.mock("@/components/agent-presence", () => ({
  AssigneeInstanceLine: ({ host }: { host: string; cwd: string | null }) => (
    <span>{host}</span>
  ),
}));

vi.mock("next-intl", async () => {
  const en = (await import("../../../../../../../../messages/en.json")).default as Record<
    string,
    unknown
  >;
  function resolveKey(ns: string, key: string): string {
    const path = ns ? `${ns}.${key}`.split(".") : key.split(".");
    let node: unknown = en;
    for (const p of path) {
      if (node && typeof node === "object" && p in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[p];
      } else {
        return `${ns ? ns + "." : ""}${key}`;
      }
    }
    return typeof node === "string" ? node : `${ns ? ns + "." : ""}${key}`;
  }
  return {
    useTranslations: (ns?: string) => (key: string) => resolveKey(ns ?? "", key),
  };
});

import { AssigneeSection } from "../assignee-section";

const agentAssignee = {
  type: "agent",
  uuid: "agent-1",
  name: "Admin Claude",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AssigneeSection — reassign trigger", () => {
  it("is a clickable button that invokes onReassign when editable + onReassign are set (assigned)", async () => {
    const onReassign = vi.fn();
    render(
      <AssigneeSection assignee={agentAssignee} editable onReassign={onReassign} />
    );
    // Accessible name = "Reassign" (assignee present).
    const btn = screen.getByRole("button", { name: /reassign/i });
    await userEvent.click(btn);
    expect(onReassign).toHaveBeenCalledTimes(1);
  });

  it("labels the trigger 'Assign' when there is no assignee (unassigned state also wrapped)", async () => {
    const onReassign = vi.fn();
    render(<AssigneeSection assignee={null} editable onReassign={onReassign} />);
    const btn = screen.getByRole("button", { name: /^assign$/i });
    await userEvent.click(btn);
    expect(onReassign).toHaveBeenCalledTimes(1);
  });

  it("renders non-interactively when editable is false (elaborated / read-only)", () => {
    const onReassign = vi.fn();
    render(
      <AssigneeSection assignee={agentAssignee} editable={false} onReassign={onReassign} />
    );
    expect(screen.queryByRole("button")).toBeNull();
    // The assignee name is still shown — only the click affordance is gone.
    expect(screen.getByText("Admin Claude")).toBeTruthy();
  });

  it("renders non-interactively when the props are omitted (default render unchanged)", () => {
    render(<AssigneeSection assignee={agentAssignee} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Admin Claude")).toBeTruthy();
  });
});
