import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, auth, group, groupMember, project, localMember } from "./project-group.fixture";

vi.mock("@/lib/prisma", async () => ({ prisma: (await import("./project-group.fixture")).fixture.prisma }));
vi.mock("@/lib/event-bus", async () => ({ eventBus: (await import("./project-group.fixture")).events }));

import { addGroupMember, listGroupMembers, removeGroupMember, updateGroupMember } from "@/services/project-group-member.service";
import { computeProjectAccess, requireProjectAccess } from "@/services/project-access.service";
import * as implicitAdminService from "@/services/project-group-implicit-admin.service";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.reset();
});

describe("automatic group Admin presentation", () => {
  it.each(["public", "private"])("synthesizes a stable, read-only Admin for an adminless %s group", async (visibility) => {
    group("g", visibility, false);
    groupMember("g", "viewer", "viewer");
    const before = structuredClone(fixture.state);

    const members = await listGroupMembers(auth("viewer"), "g");
    const automatic = members.find((m) => m.userUuid === "admin");
    expect(automatic).toMatchObject({
      uuid: "implicit:g:admin", userUuid: "admin", name: "admin", email: "admin@test.local",
      role: "admin", directRole: null, effectiveRole: "admin", implicit: true, automaticAdmin: true, addedByUuid: null,
    });
    expect((await listGroupMembers(auth(), "g")).find((m) => m.userUuid === "admin")?.uuid).toBe(automatic?.uuid);
    expect(fixture.state).toEqual(before);
    expect(fixture.writes).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it.each(["viewer", "editor"])("preserves the existing %s row identity and storage while presenting effective Admin", async (role) => {
    group("g", "private", false);
    groupMember("g", "admin", role);
    const stored = structuredClone(fixture.state.projectGroupMember[0]);

    expect(await listGroupMembers(auth(), "g")).toEqual([
      expect.objectContaining({
        uuid: stored.uuid, userUuid: "admin", role: "admin", directRole: role,
        implicit: true, automaticAdmin: true, createdAt: stored.createdAt.toISOString(),
      }),
    ]);
    expect(fixture.state.projectGroupMember).toEqual([stored]);
    expect(fixture.writes).toEqual([]);
  });

  it("removes the automatic presentation as soon as an explicit Admin exists", async () => {
    group("g", "private", false);
    groupMember("g", "admin", "viewer");
    groupMember("g", "editor", "admin");
    expect(await listGroupMembers(auth(), "g")).toEqual([
      expect.objectContaining({ userUuid: "admin", role: "viewer" }),
      expect.objectContaining({ userUuid: "editor", role: "admin" }),
    ]);
    expect((await listGroupMembers(auth(), "g")).some((m) => m.implicit || m.automaticAdmin)).toBe(false);
    expect(fixture.writes).toEqual([]);
  });

  it("follows a changed first company user without creating any memberships", async () => {
    group("g", "private", false);
    expect((await listGroupMembers(auth(), "g"))[0].userUuid).toBe("admin");
    fixture.state.user = fixture.state.user.filter((u) => u.uuid !== "admin");
    expect((await listGroupMembers(auth("editor"), "g"))[0].userUuid).toBe("editor");
    expect(fixture.state.projectGroupMember).toEqual([]);
  });
});

describe("automatic group Admin mutations", () => {
  it.each([false, true])("blocks automatic Admin removal and demotion with an existing row: %s", async (existing) => {
    group("g", "private", false);
    if (existing) groupMember("g", "admin", "viewer");
    const before = structuredClone(fixture.state);
    for (const role of ["viewer", "editor"] as const) {
      await expect(updateGroupMember(auth(), "g", "admin", role)).rejects.toMatchObject({
        status: 400, message: "Cannot remove or demote the automatic group Admin",
      });
    }
    await expect(removeGroupMember(auth(), "g", "admin")).rejects.toMatchObject({ status: 400 });
    expect(fixture.state).toEqual(before);
    expect(fixture.writes).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it("can explicitly retain a synthetic Admin, including after another Admin is added", async () => {
    group("g", "private", false);
    await addGroupMember(auth(), "g", "admin", "admin");
    await addGroupMember(auth(), "g", "editor", "admin");
    expect(await listGroupMembers(auth(), "g")).toEqual([
      expect.objectContaining({ userUuid: "admin", role: "admin" }),
      expect.objectContaining({ userUuid: "editor", role: "admin" }),
    ]);
    expect((await listGroupMembers(auth(), "g")).some((m) => m.implicit)).toBe(false);
  });

  it("can explicitly promote the existing Viewer row without changing its identity", async () => {
    group("g", "private", false);
    groupMember("g", "admin", "viewer");
    const uuid = fixture.state.projectGroupMember[0].uuid;
    await updateGroupMember(auth(), "g", "admin", "admin");
    expect(fixture.state.projectGroupMember).toEqual([
      expect.objectContaining({ uuid, userUuid: "admin", role: "admin" }),
    ]);
    expect((await listGroupMembers(auth(), "g"))[0].implicit).toBeUndefined();
  });

  it("publishes every child's former automatic Admin and invalidates the acting request after the first explicit Admin", async () => {
    group("g", "private", false);
    project("p");
    project("q");
    localMember("p", "admin", "viewer");
    const actor = auth();
    const invalidate = vi.spyOn(implicitAdminService, "invalidateImplicitGroupAdminCache");
    await requireProjectAccess(actor, "q", "admin");

    await addGroupMember(actor, "g", "editor", "admin");

    expect(fixture.events.filter((e) => e.type === "access").map((e) => e.data)).toEqual([
      { companyUuid: "c", projectUuid: "p", userUuids: ["editor", "admin"] },
      { companyUuid: "c", projectUuid: "q", userUuids: ["editor", "admin"] },
    ]);
    expect(fixture.events.every((e) => !e.inTransaction)).toBe(true);
    expect(invalidate).toHaveBeenCalledWith(actor);
    expect((await computeProjectAccess(actor, "p")).level).toBe("viewer");
    expect((await computeProjectAccess(actor, "q")).level).toBe("none");
    await expect(requireProjectAccess(actor, "q", "viewer")).rejects.toMatchObject({ status: 404 });
    invalidate.mockRestore();
  });

  it("includes the old automatic Admin when promoting a different existing member", async () => {
    group("g", "private", false);
    project();
    groupMember("g", "editor", "editor");
    await updateGroupMember(auth(), "g", "editor", "admin");
    expect(fixture.events.find((e) => e.type === "access")?.data.userUuids).toEqual(["editor", "admin"]);
  });

  it("does not revoke or report automatic Admin when adding a non-Admin", async () => {
    group("g", "private", false);
    project();
    await addGroupMember(auth(), "g", "editor", "editor");
    expect((await computeProjectAccess(auth(), "p")).level).toBe("admin");
    expect(fixture.events.find((e) => e.type === "access")?.data.userUuids).toEqual(["editor"]);
    expect(fixture.state.projectGroupMember.map((m) => m.userUuid)).toEqual(["editor"]);
  });

  it("retains the last explicit Admin protection even though a fallback could otherwise exist", async () => {
    group();
    await expect(removeGroupMember(auth(), "g", "admin")).rejects.toMatchObject({ status: 400 });
    await expect(updateGroupMember(auth(), "g", "admin", "viewer")).rejects.toMatchObject({ status: 400 });
    expect(fixture.state.projectGroupMember[0].role).toBe("admin");
    expect(fixture.writes).toEqual([]);
  });

  it("rechecks loss of automatic authority after the group lock", async () => {
    group("g", "private", false);
    fixture.onLock = () => groupMember("g", "editor", "admin");
    await expect(addGroupMember(auth(), "g", "viewer", "viewer")).rejects.toMatchObject({ status: 404 });
    expect(fixture.writes).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it("rolls back a failed audit and leaves the automatic grant and cached access valid", async () => {
    group("g", "private", false);
    project();
    const actor = auth();
    await requireProjectAccess(actor, "p", "admin");
    const before = structuredClone(fixture.state);
    fixture.failWrite = "comment";
    await expect(addGroupMember(actor, "g", "editor", "admin")).rejects.toThrow("forced comment failure");
    expect(fixture.state).toEqual(before);
    expect(fixture.events).toEqual([]);
    expect((await requireProjectAccess(actor, "p", "admin")).accessLevel).toBe("admin");
  });
});
