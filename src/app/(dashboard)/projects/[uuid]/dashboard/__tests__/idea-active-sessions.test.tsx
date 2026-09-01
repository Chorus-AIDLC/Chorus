// @vitest-environment jsdom

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import type {
  ActiveIdeaSession,
  AgentPresenceValue,
} from "@/contexts/agent-presence-context";
import { IdeaStatusGroup } from "../idea-status-group";
import { IdeaLineageTree } from "../idea-lineage-tree";
import type { IdeaCardItem } from "../idea-card";

const presence = vi.hoisted(() => ({
  value: null as AgentPresenceValue | null,
}));
vi.mock("@/contexts/agent-presence-context", () => ({
  useAgentPresenceOptional: () => presence.value,
}));
vi.mock("@/hooks/use-presence", () => ({
  usePresence: () => ({ getPresence: () => [] }),
}));
vi.mock("@/app/(dashboard)/projects/[uuid]/references-actions", () => ({
  listReferencesAction: vi.fn(),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    `${key}${values?.count ? `:${values.count}` : ""}`,
}));

const IDEA: IdeaCardItem = {
  uuid: "idea-1",
  title: "Active daemon idea",
  status: "in_progress",
  derivedStatus: "in_progress",
  badgeHint: "building",
  createdAt: "2026-08-30T00:00:00.000Z",
  parentUuid: null,
};

function activeSession(sessionUuid: string): ActiveIdeaSession {
  return {
    sessionUuid,
    ideaUuid: IDEA.uuid,
    agentUuid: `agent-${sessionUuid}`,
    originConnectionUuid: `connection-${sessionUuid}`,
    activities: new Set([`activity-${sessionUuid}`]),
    agentName: `Agent ${sessionUuid}`,
    host: "devbox",
    cwd: `/work/${sessionUuid}`,
    connectionAvailable: true,
    canOpen: true,
  };
}

function setSessions(sessions: ActiveIdeaSession[]) {
  presence.value = {
    activeSessionsByIdea:
      sessions.length > 0 ? new Map([[IDEA.uuid, sessions]]) : new Map(),
    openChatForActiveSession: vi.fn(),
  } as unknown as AgentPresenceValue;
}

beforeEach(() => {
  setSessions([]);
});

describe("Idea Tracker daemon activity", () => {
  it("flat rows cover zero, one, navigation isolation, and final-end removal", () => {
    const onIdeaClick = vi.fn();
    const { rerender } = render(
      <IdeaStatusGroup
        status="in_progress"
        ideas={[IDEA]}
        onIdeaClick={onIdeaClick}
      />,
    );
    expect(
      screen.queryByTestId("tracker-active-session-indicator"),
    ).toBeNull();

    setSessions([activeSession("one")]);
    rerender(
      <IdeaStatusGroup
        status="in_progress"
        ideas={[IDEA]}
        onIdeaClick={onIdeaClick}
      />,
    );
    fireEvent.click(screen.getByTestId("tracker-active-session-indicator"));
    expect(presence.value?.openChatForActiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionUuid: "one" }),
    );
    expect(onIdeaClick).not.toHaveBeenCalled();

    setSessions([]);
    rerender(
      <IdeaStatusGroup
        status="in_progress"
        ideas={[IDEA]}
        onIdeaClick={onIdeaClick}
      />,
    );
    expect(
      screen.queryByTestId("tracker-active-session-indicator"),
    ).toBeNull();
  });

  it("lineage rows expose a multi-session chooser without opening details", () => {
    setSessions([activeSession("one"), activeSession("two")]);
    const onIdeaClick = vi.fn();
    render(<IdeaLineageTree ideas={[IDEA]} onIdeaClick={onIdeaClick} />);

    const indicator = screen.getByTestId("tracker-active-session-indicator");
    expect(indicator.textContent).toContain("2");
    fireEvent.click(indicator);
    fireEvent.click(screen.getByText("Agent two"));

    expect(presence.value?.openChatForActiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionUuid: "two" }),
    );
    expect(onIdeaClick).not.toHaveBeenCalled();
  });
});
