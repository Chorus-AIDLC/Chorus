// Unit tests for handleInstancePickConfirm — the "Pin instance" confirm handler
// extracted from MentionEditor.
//
// Regression context (fix-mention-cwd-picker-mobile-overflow round 3): on mobile
// the owner reported tapping "Pin instance" did nothing — the modal stayed open.
// Root cause: the old handler ran the mention insert (a Tiptap `command` captured
// when the picker opened, which can throw/no-op once the editor has blurred behind
// the Radix dialog) BEFORE closing the modal, so a throwing insert skipped the
// close and the dialog stuck open. The fix closes FIRST, then inserts deferred +
// guarded. These tests pin that ordering and the throw-safety.

import { describe, it, expect, vi } from "vitest";
import { handleInstancePickConfirm } from "@/components/mention-editor";

const instance = {
  connectionUuid: "conn-1",
  agentInstanceUuid: "inst-1",
  host: "host-1",
  cwd: "/Users/dev/projectA",
  effectiveStatus: "online" as const,
};

function makePick() {
  return {
    item: { type: "agent" as const, uuid: "a1", name: "Agent One" },
    onlineInstances: [instance],
    command: vi.fn(),
  };
}

// Synchronous defer so we can assert the deferred body's effects inline.
const syncDefer = (fn: () => void) => fn();

describe("handleInstancePickConfirm", () => {
  it("closes the modal before performing the insert", () => {
    const order: string[] = [];
    const close = vi.fn(() => order.push("close"));
    const insert = vi.fn(() => order.push("insert"));
    handleInstancePickConfirm(makePick(), instance, {
      close,
      insert,
      defer: syncDefer,
      focusEditor: vi.fn(),
      onError: vi.fn(),
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
    // Close must come first — this is the whole fix.
    expect(order).toEqual(["close", "insert"]);
  });

  it("STILL closes the modal even when the insert throws (the mobile bug)", () => {
    const close = vi.fn();
    const onError = vi.fn();
    const insert = vi.fn(() => {
      throw new Error("stale Tiptap command — editor blurred");
    });
    expect(() =>
      handleInstancePickConfirm(makePick(), instance, {
        close,
        insert,
        defer: syncDefer,
        focusEditor: vi.fn(),
        onError,
      }),
    ).not.toThrow();
    expect(close).toHaveBeenCalledTimes(1); // modal dismissed regardless
    expect(onError).toHaveBeenCalledTimes(1); // error surfaced, not swallowed silently
  });

  it("focuses the editor before inserting (reliable transaction on touch)", () => {
    const order: string[] = [];
    handleInstancePickConfirm(makePick(), instance, {
      close: vi.fn(),
      insert: () => order.push("insert"),
      defer: syncDefer,
      focusEditor: () => order.push("focus"),
      onError: vi.fn(),
    });
    expect(order).toEqual(["focus", "insert"]);
  });

  it("passes the chosen pick + instance through to insert", () => {
    const pick = makePick();
    const insert = vi.fn();
    handleInstancePickConfirm(pick, instance, {
      close: vi.fn(),
      insert,
      defer: syncDefer,
      focusEditor: vi.fn(),
      onError: vi.fn(),
    });
    expect(insert).toHaveBeenCalledWith(pick, instance);
  });

  it("closes and performs no insert when there is no pending pick", () => {
    const close = vi.fn();
    const insert = vi.fn();
    const defer = vi.fn();
    handleInstancePickConfirm(null, instance, {
      close,
      insert,
      defer,
      focusEditor: vi.fn(),
      onError: vi.fn(),
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(defer).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});
