// @vitest-environment jsdom
//
// Unit test for the @-mention dropdown row renderer (createSuggestionPopupRenderer).
// Covers the agent-liveness UI from the mention-agent-liveness change:
//   - an online agent row shows a green status dot (Online tooltip) and, when
//     activeCount > 0, a count badge; the roles line is gone,
//   - an online idle agent (activeCount 0) shows the dot but no badge,
//   - an offline agent shows neither dot nor badge,
//   - user rows are unchanged (name + email, no dot/badge).
//
// The renderer is module-level DOM-building (no React/Tiptap), so we exercise it
// directly against a detached container + a stub command/labels — no editor boot.

import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { createSuggestionPopupRenderer } from "@/components/mention-editor";

const labels = {
  online: "Online",
  offline: "Offline",
  idle: "Idle",
  activeCount: (n: number) => `${n} active`,
};

function render(items: Array<Record<string, unknown>>) {
  const container = document.createElement("div");
  // keyDownRef shape matches the renderer's React.MutableRefObject param.
  const keyDownRef = createRef<unknown>() as { current: unknown };
  keyDownRef.current = null;
  createSuggestionPopupRenderer(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items as any,
    false,
    vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keyDownRef as any,
    container,
    labels,
  );
  return container;
}

// Helper: the presence dot is the avatar-corner span with title="Online" and a
// `ring` class (distinguishing it from any other titled element).
function presenceDot(c: HTMLElement) {
  return c.querySelector('span[title="Online"].ring-2');
}

describe("mention dropdown row renderer — agent liveness", () => {
  it("online + busy agent: avatar-corner presence dot + 'N active' status text, no roles line", () => {
    const c = render([
      {
        type: "agent",
        uuid: "a1",
        name: "AliceBot",
        roles: ["pm_agent"],
        online: true,
        activeCount: 2,
      },
    ]);

    // Presence dot sits on the avatar (absolute bottom-right, ringed), titled Online.
    const dot = presenceDot(c);
    expect(dot).not.toBeNull();
    expect(dot!.className).toContain("absolute");
    // Its parent is the avatar wrapper (relative), not the text info column.
    expect(dot!.parentElement?.className).toContain("relative");

    // Active-task count rendered as status text.
    expect(c.textContent).toContain("2 active");

    // The old roles line is gone.
    expect(c.textContent).not.toContain("pm_agent");
  });

  it("online + idle agent: presence dot + explicit 'Idle' status (never a blank line)", () => {
    const c = render([
      { type: "agent", uuid: "a2", name: "IdleBot", online: true, activeCount: 0 },
    ]);
    expect(presenceDot(c)).not.toBeNull();
    // Explicit idle status, not blank, and no active-count text.
    expect(c.textContent).toContain("Idle");
    expect(c.textContent).not.toContain("active");
  });

  it("offline agent: no presence dot, no status text", () => {
    const c = render([
      { type: "agent", uuid: "a3", name: "OffBot", online: false, activeCount: 0 },
    ]);
    expect(presenceDot(c)).toBeNull();
    expect(c.textContent).not.toContain("Idle");
    expect(c.textContent).not.toContain("active");
    // The name still renders.
    expect(c.textContent).toContain("OffBot");
  });

  it("user row is unchanged: name + email, no dot/status", () => {
    const c = render([
      { type: "user", uuid: "u1", name: "Alice", email: "alice@example.com" },
    ]);
    expect(c.textContent).toContain("Alice");
    expect(c.textContent).toContain("alice@example.com");
    expect(presenceDot(c)).toBeNull();
    expect(c.textContent).not.toContain("Idle");
    expect(c.textContent).not.toContain("active");
  });
});
