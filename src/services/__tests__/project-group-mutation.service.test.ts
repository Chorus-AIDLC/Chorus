import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, auth, group, groupMember, project, localMember } from "./project-group.fixture";

vi.mock("@/lib/prisma", async () => ({ prisma: (await import("./project-group.fixture")).fixture.prisma }));
vi.mock("@/lib/event-bus", async () => ({ eventBus: (await import("./project-group.fixture")).events }));

import { materializeGroupGrants, type GroupDbClient } from "@/services/project-group-mutation.service";
import { deleteProjectGroup, moveProjectToGroup } from "@/services/project-group.service";
import { getProjectGroupMovePreview } from "@/services/project-group-preview.service";
import { computeProjectAccess } from "@/services/project-access.service";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.reset();
});

async function detach(actor = auth()) {
  const preview = await getProjectGroupMovePreview(actor, "p", null);
  return moveProjectToGroup("c", "p", null, actor, preview.confirmationToken);
}

describe("detach snapshots automatic group Admin", () => {
  it.each(["private", "public"])("retains the automatic Admin only for the detached %s child", async (visibility) => {
    group("g", visibility, false);
    project("p", "g", visibility);
    project("q", "g", visibility);
    groupMember("g", "viewer", "viewer");
    const groupRows = structuredClone(fixture.state.projectGroupMember);

    await getProjectGroupMovePreview(auth(), "p", null);
    expect(fixture.writes).toEqual([]);
    await detach();

    expect(fixture.state.project.find((p) => p.uuid === "p")?.groupUuid).toBeNull();
    expect(fixture.state.projectMember).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectUuid: "p", userUuid: "admin", role: "admin", addedByUuid: "admin" }),
      expect.objectContaining({ projectUuid: "p", userUuid: "viewer", role: "viewer" }),
    ]));
    expect(fixture.state.projectMember.some((m) => m.projectUuid === "q")).toBe(false);
    expect(fixture.state.projectGroupMember).toEqual(groupRows);
    expect((await computeProjectAccess(auth(), "p")).level).toBe("admin");
    expect(fixture.events.every((e) => !e.inTransaction)).toBe(true);
  });

  it("upgrades an existing direct role to the automatic Admin and preserves its identity", async () => {
    group("g", "private", false);
    project();
    groupMember("g", "admin", "viewer");
    localMember("p", "admin", "editor");
    localMember("p", "viewer", "admin");
    groupMember("g", "viewer", "viewer");
    const directUuid = fixture.state.projectMember[0].uuid;
    await detach();
    expect(fixture.state.projectMember).toEqual([
      expect.objectContaining({ uuid: directUuid, userUuid: "admin", role: "admin" }),
      expect.objectContaining({ userUuid: "viewer", role: "admin" }),
    ]);
    expect(fixture.state.projectGroupMember.find((m) => m.userUuid === "admin")?.role).toBe("viewer");
  });

  it("does not materialize a fallback once an explicit group Admin exists", async () => {
    group("g", "private", false);
    groupMember("g", "editor", "admin");
    project();
    localMember("p", "admin", "admin");
    await detach(auth("editor"));
    expect(fixture.state.projectMember).toEqual([
      expect.objectContaining({ uuid: "p-admin", userUuid: "admin", role: "admin" }),
      expect.objectContaining({ userUuid: "editor", role: "admin" }),
    ]);
    expect(fixture.writes.filter((w) => w.table === "projectMember").map((w) => w.data.userUuid)).toEqual(["editor"]);
  });

  it("preserves the same snapshot when deleting a group and retaining its children", async () => {
    group("g", "private", false);
    project();
    project("q");
    await deleteProjectGroup("c", "g", false, auth());
    expect(fixture.state.projectGroup).toEqual([]);
    expect(fixture.state.project.map((p) => p.groupUuid)).toEqual([null, null]);
    expect(fixture.state.projectMember).toEqual([
      expect.objectContaining({ projectUuid: "p", userUuid: "admin", role: "admin" }),
      expect.objectContaining({ projectUuid: "q", userUuid: "admin", role: "admin" }),
    ]);
  });

  it("requires a retained Admin when neither explicit nor automatic Admin is available", async () => {
    group("g", "private", false);
    project();
    fixture.state.user = [];
    await expect(materializeGroupGrants(fixture.prisma as unknown as GroupDbClient, auth(), "g", "p"))
      .rejects.toMatchObject({ status: 400, message: "Detaching must retain a project Admin" });
    expect(fixture.writes).toEqual([]);
  });

  it("does not snapshot grants for an unauthorized detach", async () => {
    group("g", "private", false);
    project();
    groupMember("g", "outside", "viewer");
    await expect(moveProjectToGroup("c", "p", null, auth("outside"), "invalid"))
      .rejects.toMatchObject({ status: 403 });
    expect(fixture.writes).toEqual([]);
    expect(fixture.state.projectMember).toEqual([]);
  });

  it("rolls back the Admin snapshot with the detach when its audit fails", async () => {
    group("g", "private", false);
    project();
    const before = structuredClone(fixture.state);
    fixture.failWrite = "comment";
    await expect(detach()).rejects.toThrow("forced comment failure");
    expect(fixture.state).toEqual(before);
    expect(fixture.events).toEqual([]);
  });

  it("rechecks fallback revocation under the group lock before making a snapshot", async () => {
    group("g", "private", false);
    project();
    const preview = await getProjectGroupMovePreview(auth(), "p", null);
    fixture.onLock = () => groupMember("g", "editor", "admin");
    await expect(moveProjectToGroup("c", "p", null, auth(), preview.confirmationToken))
      .rejects.toMatchObject({ status: 404 });
    expect(fixture.state.projectMember).toEqual([]);
    expect(fixture.writes).toEqual([]);
    expect(fixture.events).toEqual([]);
  });
});
