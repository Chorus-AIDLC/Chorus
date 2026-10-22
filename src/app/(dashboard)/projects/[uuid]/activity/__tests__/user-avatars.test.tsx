// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserAvatarProps } from "@/components/ui/user-avatar";

const mocks = vi.hoisted(() => ({ users: vi.fn(), agents: vi.fn(), activities: vi.fn(), access: vi.fn() }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findMany: mocks.users }, agent: { findMany: mocks.agents } } }));
vi.mock("@/services/activity.service", () => ({ listActivities: mocks.activities }));
vi.mock("../../access-guard", () => ({ requireProjectPageAccess: mocks.access }));
vi.mock("@/components/formatted-date-time", () => ({ FormattedDateTime: () => null }));
vi.mock("@/components/user-identity-avatar", () => ({
  UserIdentityAvatar: ({ userUuid, avatarSeed }: UserAvatarProps) => <span data-testid="human-avatar" data-user={userUuid} data-seed={avatarSeed} />,
}));

import ActivityPage from "../page";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({ auth: { companyUuid: "company", actorUuid: "viewer" } });
});

describe("activity current user avatar hydration", () => {
  it("renders super admins as Admin without hydrating them as workspace users", async () => {
    mocks.activities.mockResolvedValue({ activities: ["user", "agent", "super_admin", "system"].map((actorType) => ({
      uuid: `activity-${actorType}`, actorUuid: "shared", actorType, targetType: "task", targetUuid: "task",
      action: "execution_started", value: null, createdAt: new Date(),
    })) });
    mocks.users.mockResolvedValue([{ uuid: "shared", name: "Human owner", avatarSeed: "human-seed" }]);
    mocks.agents.mockResolvedValue([{ uuid: "shared", name: "Agent worker" }]);

    const { container } = render(await ActivityPage({ params: Promise.resolve({ uuid: "project" }) }));

    expect(screen.getByText("Admin")).toBeTruthy();
    expect(screen.getByText("Human owner")).toBeTruthy();
    expect(screen.getByText("Agent worker")).toBeTruthy();
    expect(screen.getByText("common.system")).toBeTruthy();
    expect(screen.getAllByTestId("human-avatar")).toHaveLength(1);
    expect(container.querySelectorAll(".lucide-settings")).toHaveLength(2);
    expect(mocks.users).toHaveBeenCalledTimes(1);
    expect(mocks.agents).toHaveBeenCalledTimes(1);
  });

  it("never queries administrator UUIDs from user or agent profiles", async () => {
    mocks.activities.mockResolvedValue({ activities: [{
      uuid: "admin-activity", actorUuid: "admin-only", actorType: "super_admin", targetType: "task", targetUuid: "task",
      action: "execution_started", value: null, createdAt: new Date(),
    }] });
    mocks.users.mockResolvedValue([]);
    mocks.agents.mockResolvedValue([]);

    render(await ActivityPage({ params: Promise.resolve({ uuid: "project" }) }));

    expect(screen.getByText("Admin")).toBeTruthy();
    expect(screen.queryByText("common.system")).toBeNull();
    expect(screen.queryByTestId("human-avatar")).toBeNull();
    for (const lookup of [mocks.users, mocks.agents]) {
      expect(lookup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        where: { uuid: { in: [] }, companyUuid: "company" },
      }));
    }
  });

  it("resolves historical actors in one tenant-scoped batch, retains agents, and safely falls back for missing actors", async () => {
    mocks.activities.mockResolvedValue({ activities: ["human", "human", "agent", "deleted"].map((actorUuid, index) => ({ uuid: `activity-${index}`, actorUuid, actorType: actorUuid === "agent" ? "agent" : "user", targetType: "task", targetUuid: "task", action: "created", value: { avatarSeed: "historical-seed" }, createdAt: new Date() })) });
    mocks.users.mockResolvedValue([{ uuid: "human", name: "Human", avatarSeed: "current-seed" }]);
    mocks.agents.mockResolvedValue([{ uuid: "agent", name: "Agent" }]);
    const { container } = render(await ActivityPage({ params: Promise.resolve({ uuid: "project" }) }));
    expect(mocks.users).toHaveBeenCalledTimes(1);
    expect(mocks.users).toHaveBeenCalledWith({ where: { uuid: { in: ["human", "deleted"] }, companyUuid: "company" }, select: { uuid: true, name: true, avatarSeed: true } });
    expect(mocks.agents).toHaveBeenCalledTimes(1);
    expect(mocks.agents).toHaveBeenCalledWith({ where: { uuid: { in: ["agent"] }, companyUuid: "company" }, select: { uuid: true, name: true } });
    expect(mocks.access).toHaveBeenCalledWith("project");
    const avatars = screen.getAllByTestId("human-avatar");
    expect(avatars).toHaveLength(2);
    expect(avatars.filter((avatar) => avatar.dataset.seed === "current-seed")).toHaveLength(2);
    expect(container.querySelectorAll(".lucide-settings")).toHaveLength(1);
    expect(container.querySelectorAll(".lucide-monitor")).toHaveLength(1);
  });

  it("uses actorType to distinguish colliding human and Agent UUIDs without hydrating system actors", async () => {
    mocks.activities.mockResolvedValue({ activities: ["user", "agent", "system"].map((actorType) => ({ uuid: `activity-${actorType}`, actorUuid: "shared", actorType, targetType: "task", targetUuid: "task", action: "created", value: null, createdAt: new Date() })) });
    mocks.users.mockResolvedValue([{ uuid: "shared", name: "Human owner", avatarSeed: "human-seed" }]);
    mocks.agents.mockResolvedValue([{ uuid: "shared", name: "Agent worker" }]);
    const { container } = render(await ActivityPage({ params: Promise.resolve({ uuid: "project" }) }));
    expect(screen.getAllByTestId("human-avatar")).toHaveLength(1);
    expect(screen.getByTestId("human-avatar").dataset).toMatchObject({ user: "shared", seed: "human-seed" });
    expect(screen.getByText("Human owner")).toBeTruthy();
    expect(screen.getByText("Agent worker")).toBeTruthy();
    expect(screen.getByText("common.system")).toBeTruthy();
    expect(container.querySelectorAll(".lucide-monitor")).toHaveLength(1);
    expect(container.querySelectorAll(".lucide-settings")).toHaveLength(1);
    expect(mocks.users).toHaveBeenCalledWith({ where: { uuid: { in: ["shared"] }, companyUuid: "company" }, select: { uuid: true, name: true, avatarSeed: true } });
    expect(mocks.agents).toHaveBeenCalledWith({ where: { uuid: { in: ["shared"] }, companyUuid: "company" }, select: { uuid: true, name: true } });
  });

  it.each(["user", "agent"])("never resolves a missing %s actor through the other identity map", async (actorType) => {
    mocks.activities.mockResolvedValue({ activities: [{ uuid: "activity", actorUuid: "shared", actorType, targetType: "task", targetUuid: "task", action: "created", value: null, createdAt: new Date() }] });
    mocks.users.mockResolvedValue(actorType === "user" ? [] : [{ uuid: "shared", name: "Wrong human", avatarSeed: "wrong-seed" }]);
    mocks.agents.mockResolvedValue(actorType === "agent" ? [] : [{ uuid: "shared", name: "Wrong agent" }]);
    const { container } = render(await ActivityPage({ params: Promise.resolve({ uuid: "project" }) }));
    expect(screen.queryByTestId("human-avatar")).toBeNull();
    expect(screen.getByText("common.system")).toBeTruthy();
    expect(container.querySelectorAll(".lucide-monitor")).toHaveLength(0);
    expect(container.querySelectorAll(".lucide-settings")).toHaveLength(1);
  });
});
