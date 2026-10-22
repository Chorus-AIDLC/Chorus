// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserAvatarProps } from "@/components/ui/user-avatar";

const auth = vi.hoisted(() => ({
  user: { uuid: "self", name: "Current User", avatarSeed: "saved-self" },
}));

vi.mock("@/contexts/auth-context", () => ({ useOptionalAuth: () => auth }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/hooks/use-progress-router", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/ui/user-avatar", () => ({
  UserAvatar: ({ userUuid, name, avatarSeed, decorative, size }: UserAvatarProps) => (
    <span data-testid="human-avatar" data-user={userUuid} data-seed={avatarSeed} data-size={size} aria-hidden={decorative}>{name}</span>
  ),
}));
vi.mock("@/components/ui/agent-avatar", () => ({
  AgentAvatar: ({ name }: { name: string }) => <span data-testid="agent-avatar">{name}</span>,
}));
vi.mock("@/components/agent-presence", () => ({ AssigneeInstanceLine: () => <span data-testid="instance-line" /> }));
vi.mock("@/components/ui/presence-indicator", () => ({ PresenceIndicator: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/contexts/realtime-context", () => ({ useRealtimeEntityTypeEvent: vi.fn() }));
vi.mock("../../tasks/session-actions", () => ({ getBatchWorkerCountsAction: vi.fn().mockResolvedValue({ success: false }) }));

import { AssigneeSection } from "../panels/assignee-section";
import { TaskListView } from "../panels/task-list-view";
import { AssignModal } from "@/components/assign-modal";

afterEach(cleanup);
beforeEach(() => { auth.user.avatarSeed = "saved-self"; });

describe("project human identity slots", () => {
  it("keeps mounted assignee and assignment-self avatars on the same saved seed without overriding other users", () => {
    function Surfaces() {
      return <>
        <AssigneeSection assignee={{ type: "user", uuid: "self", name: "Current User", avatarSeed: "stale-self" }} />
        <AssignModal open onOpenChange={vi.fn()} title="Assign" agents={[]} currentUserUuid="self"
          users={[{ uuid: "self", name: "Current User", email: null, avatarSeed: "stale-self" }, { uuid: "other", name: "Other User", email: null, avatarSeed: "saved-other" }]}
          onAssignToSelf={vi.fn()} onAssignToAgent={vi.fn()} onAssignToUser={vi.fn()} />
      </>;
    }
    const { rerender } = render(<Surfaces />);
    const selfAvatars = () => screen.getAllByTestId("human-avatar").filter((avatar) => avatar.dataset.user === "self");
    expect(selfAvatars()).toHaveLength(2);
    expect(selfAvatars().every((avatar) => avatar.dataset.seed === "saved-self")).toBe(true);
    auth.user.avatarSeed = "new-saved-self";
    rerender(<Surfaces />);
    expect(selfAvatars().every((avatar) => avatar.dataset.seed === "new-saved-self")).toBe(true);
    expect(screen.getAllByTestId("human-avatar").find((avatar) => avatar.dataset.user === "other")?.dataset.seed).toBe("saved-other");
    expect(screen.getAllByTestId("human-avatar").every((avatar) => avatar.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("forwards task-list nested human identity while retaining the Agent avatar branch", () => {
    render(<TaskListView projectUuid="project" proposalUuids={[]} onSelectTask={vi.fn()} tasks={[
      { uuid: "task-human", title: "Human task", status: "open", commentCount: 0, assignee: { type: "user", uuid: "other", name: "Other User", avatarSeed: "task-seed" } },
      { uuid: "task-agent", title: "Agent task", status: "open", commentCount: 0, assignee: { type: "agent", uuid: "agent", name: "Agent" } },
    ]} />);
    expect(screen.getByTestId("human-avatar").dataset).toMatchObject({ user: "other", seed: "task-seed", size: "14" });
    expect(screen.getAllByTestId("agent-avatar")).toHaveLength(1);
  });

  it.each(["agent", "agent_instance"])("preserves %s assignee rendering", (type) => {
    render(<AssigneeSection assignee={{ type, uuid: "agent", name: "Agent", instance: { agentUuid: "agent", host: "host", cwd: "/repo" } }} />);
    expect(screen.getByTestId("agent-avatar").textContent).toBe("Agent");
    expect(screen.queryByTestId("human-avatar")).toBeNull();
  });

  it("passes an unresolved user's missing seed through to the safe fallback", () => {
    render(<AssigneeSection assignee={{ type: "user", uuid: "missing", name: "Deleted User", avatarSeed: null }} />);
    expect(screen.getByTestId("human-avatar").dataset.user).toBe("missing");
    expect(screen.getByTestId("human-avatar").hasAttribute("data-seed")).toBe(false);
  });
});
