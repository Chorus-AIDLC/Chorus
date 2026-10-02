import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, auth, group, project, localMember } from "./project-group.fixture";

vi.mock("@/lib/prisma", async () => ({
  prisma: (await import("./project-group.fixture")).fixture.prisma,
}));
vi.mock("@/lib/event-bus", async () => ({
  eventBus: (await import("./project-group.fixture")).events,
}));

import { addGroupMember, updateGroupMember, removeGroupMember } from "@/services/project-group-member.service";
import { getGroupDashboard } from "@/services/project-group.service";
import { auditGroup } from "@/services/project-group-mutation.service";
import { prisma } from "@/lib/prisma";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.reset();
  group();
  project();
  localMember("p", "local", "viewer");
});

describe("group audits preserve the project-only visibility boundary", () => {
  it("retains detailed member history without exposing the roster through child activity", async () => {
    await addGroupMember(auth(), "g", "viewer", "viewer");
    await updateGroupMember(auth(), "g", "viewer", "editor");
    await removeGroupMember(auth(), "g", "viewer");

    const dashboard = await getGroupDashboard("c", "g", auth("local"));
    expect(dashboard?.recentActivity).toEqual([]);
    const records = fixture.state.comment.map((row) => JSON.parse(row.content));
    expect(records).toEqual([
      { action: "group_member_changed", userUuid: "viewer", beforeRole: null, role: "viewer" },
      { action: "group_member_changed", userUuid: "viewer", beforeRole: "viewer", role: "editor" },
      { action: "group_member_removed", userUuid: "viewer", beforeRole: "editor", role: null },
    ]);
    expect(fixture.state.comment.every((row) =>
      row.targetType === "project_group" && row.targetUuid === "g")).toBe(true);
  });

  it("keeps initialization identities out of child activity while preserving group audit", async () => {
    await prisma.$transaction((tx) =>
      auditGroup(tx, auth(), "g", ["p"], "group_access_initialized", {}));
    expect((await getGroupDashboard("c", "g", auth("local")))?.recentActivity).toEqual([]);
    expect(JSON.parse(fixture.state.comment[0].content)).toEqual({ action: "group_access_initialized" });
  });

  it("still records child-visible group basic changes", async () => {
    await prisma.$transaction((tx) =>
      auditGroup(tx, auth(), "g", ["p"], "group_updated", { name: "Renamed" }));
    expect((await getGroupDashboard("c", "g", auth("local")))?.recentActivity).toMatchObject([
      { action: "group_updated", value: { name: "Renamed" } },
    ]);
  });
});
