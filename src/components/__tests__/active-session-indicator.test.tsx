// @vitest-environment jsdom

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ActiveIdeaSession } from "@/contexts/agent-presence-context";
import { ActiveSessionIndicator } from "../active-session-indicator";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    `${key}${values?.count ? `:${values.count}` : ""}`,
}));

function session(
  sessionUuid: string,
  overrides: Partial<ActiveIdeaSession> = {},
): ActiveIdeaSession {
  return {
    sessionUuid,
    ideaUuid: "idea-1",
    agentUuid: `agent-${sessionUuid}`,
    originConnectionUuid: `connection-${sessionUuid}`,
    activities: new Set([`activity-${sessionUuid}`]),
    agentName: `Agent ${sessionUuid}`,
    host: "devbox",
    cwd: `/work/${sessionUuid}`,
    connectionAvailable: true,
    canOpen: true,
    ...overrides,
  };
}

describe("ActiveSessionIndicator", () => {
  it("renders nothing for zero sessions", () => {
    const { container } = render(
      <ActiveSessionIndicator
        sessions={[]}
        onSelect={() => {}}
        surface="tracker"
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("opens one session directly and isolates the parent click", () => {
    const onSelect = vi.fn();
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <ActiveSessionIndicator
          sessions={[session("one")]}
          onSelect={onSelect}
          surface="tracker"
        />
      </div>,
    );

    const trigger = screen.getByTestId("tracker-active-session-indicator");
    expect(
      trigger.querySelector(".motion-reduce\\:animate-none"),
    ).not.toBeNull();
    fireEvent.click(trigger);

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionUuid: "one" }),
    );
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it("shows a keyboard-focusable chooser for many sessions and selects one", () => {
    const onSelect = vi.fn();
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <ActiveSessionIndicator
          sessions={[session("one"), session("two")]}
          onSelect={onSelect}
          surface="graph"
        />
      </div>,
    );

    const trigger = screen.getByTestId("graph-active-session-indicator");
    expect(trigger.querySelector('[data-slot="agent-avatar"]')).not.toBeNull();
    fireEvent.focus(trigger);
    expect(screen.getByText("Agent one")).toBeTruthy();
    expect(screen.getByText("Agent two")).toBeTruthy();
    expect(
      document.querySelectorAll('[data-slot="agent-avatar"]'),
    ).toHaveLength(3);

    fireEvent.click(screen.getByText("Agent two"));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionUuid: "two" }),
    );
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it("renders the same live-agent affordance in the Idea Tracker sidebar", () => {
    render(
      <ActiveSessionIndicator
        sessions={[session("sidebar")]}
        onSelect={() => {}}
        surface="sidebar"
      />,
    );

    const trigger = screen.getByTestId("sidebar-active-session-indicator");
    expect(trigger.querySelector('[data-slot="agent-avatar"]')).not.toBeNull();
    expect(trigger.querySelector(".motion-safe\\:animate-ping")).not.toBeNull();
  });

  it("supports keyboard activation without leaking the event to its parent", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <ActiveSessionIndicator
          sessions={[session("one")]}
          onSelect={onSelect}
          surface="tracker"
        />
      </div>,
    );

    const trigger = screen.getByTestId("tracker-active-session-indicator");
    fireEvent.focus(trigger);
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionUuid: "one" }),
    );
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it("exposes every chooser entry to keyboard focus", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ActiveSessionIndicator
        sessions={[session("one"), session("two")]}
        onSelect={onSelect}
        surface="graph"
      />,
    );

    const trigger = screen.getByTestId("graph-active-session-indicator");
    fireEvent.focus(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(
      screen.getByText("Agent one").closest("button"),
    );

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByText("Agent two").closest("button"),
    );
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionUuid: "two" }),
    );
  });

  it("keeps an activity actionable when connection details are unavailable", () => {
    render(
      <ActiveSessionIndicator
        sessions={[
          session("fallback", {
            connectionAvailable: false,
            host: null,
            cwd: null,
            agentName: null,
          }),
        ]}
        onSelect={() => {}}
        surface="tracker"
      />,
    );
    fireEvent.pointerEnter(
      screen.getByTestId("tracker-active-session-indicator"),
    );
    expect(screen.getByText("agent-fallback")).toBeTruthy();
    expect(screen.getByText("agentFallback")).toBeTruthy();
  });

  it("keeps a single other-user session status-only for mouse and keyboard", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ActiveSessionIndicator
        sessions={[session("other", { canOpen: false })]}
        onSelect={onSelect}
        surface="tracker"
      />,
    );

    const trigger = screen.getByTestId("tracker-active-session-indicator");
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(trigger);
    await user.keyboard("{Enter}");
    fireEvent.pointerEnter(trigger);

    expect(screen.getByText("statusOnly")).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("disables only the other-user entry in a mixed chooser", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ActiveSessionIndicator
        sessions={[
          session("other", { canOpen: false }),
          session("owned", { canOpen: true }),
        ]}
        onSelect={onSelect}
        surface="graph"
      />,
    );

    fireEvent.focus(screen.getByTestId("graph-active-session-indicator"));
    const other = screen.getByText("Agent other").closest("button")!;
    const owned = screen.getByText("Agent owned").closest("button")!;
    expect(other.disabled).toBe(true);
    fireEvent.click(other);
    expect(onSelect).not.toHaveBeenCalled();

    expect(document.activeElement).toBe(owned);
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionUuid: "owned", canOpen: true }),
    );
  });
});
