import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, auth, group, groupMember, project, localMember } from "./project-group.fixture";

vi.mock("@/lib/prisma", async () => ({ prisma: (await import("./project-group.fixture")).fixture.prisma }));
vi.mock("@/lib/event-bus", async () => ({ eventBus: (await import("./project-group.fixture")).events }));

import { LastAdminError, addMember, listMembers, removeMember, setVisibility, updateMemberRole } from "@/services/project-member.service";
import { computeProjectAccess, requireProjectAccess } from "@/services/project-access.service";
import { getProjectVisibilityPreview } from "@/services/project-access-preview.service";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.reset();
});

describe("project membership presentation for automatic group Admin", () => {
  it("lists a synthetic inherited Admin without writing either membership layer", async () => {
    group("g", "private", false);
    project();
    localMember("p", "viewer", "viewer");
    const before = structuredClone(fixture.state);

    expect(await listMembers(auth("viewer"), "p")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uuid: "inherited:implicit:g:admin", userUuid: "admin", name: "admin", email: "admin@test.local",
        role: "admin", source: "group", inheritedRole: "admin", directRole: null,
        effectiveRole: "admin", implicit: true, automaticAdmin: true,
      }),
    ]));
    expect(fixture.state).toEqual(before);
    expect(fixture.writes).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it.each(["viewer", "editor"])("merges a direct %s and a lower group grant into effective automatic Admin", async (role) => {
    group("g", "private", false);
    project();
    groupMember("g", "admin", "viewer");
    localMember("p", "admin", role);
    const before = structuredClone(fixture.state);

    expect(await listMembers(auth(), "p")).toEqual([
      expect.objectContaining({
        uuid: "p-admin", userUuid: "admin", role: "admin", source: "both",
        inheritedRole: "admin", directRole: role, effectiveRole: "admin", implicit: true, automaticAdmin: true,
      }),
    ]);
    expect(fixture.state).toEqual(before);
  });

  it("preserves an existing inherited row identity when its effective role becomes automatic Admin", async () => {
    group("g", "private", false);
    project();
    groupMember("g", "admin", "editor");
    expect(await listMembers(auth(), "p")).toEqual([
      expect.objectContaining({
        uuid: "inherited:g-admin", userUuid: "admin", role: "admin",
        directRole: null, inheritedRole: "admin", implicit: true,
      }),
    ]);
    expect(fixture.state.projectGroupMember[0].role).toBe("editor");
  });

  it("presents only actual grants once another explicit Admin ends the fallback", async () => {
    group("g", "private", false);
    project();
    groupMember("g", "admin", "viewer");
    groupMember("g", "editor", "admin");
    const rows = await listMembers(auth(), "p");
    expect(rows.find((m) => m.userUuid === "admin")).toMatchObject({ role: "viewer", inheritedRole: "viewer" });
    expect(rows.find((m) => m.userUuid === "editor")).toMatchObject({ role: "admin", inheritedRole: "admin" });
    expect(rows.some((m) => m.implicit || m.automaticAdmin)).toBe(false);
  });
});

describe("last project Admin includes live automatic group Admin", () => {
  it.each(["remove", "demote"] as const)("allows %s of the final direct Admin while an automatic group Admin remains", async (mutation) => {
    group("g", "private", false);
    project();
    localMember("p", "local", "admin");
    if (mutation === "remove") await removeMember(auth("local"), "p", "local");
    else await updateMemberRole(auth("local"), "p", "local", "viewer");
    expect(fixture.state.projectMember.some((m) => m.role === "admin")).toBe(false);
    expect(fixture.state.projectGroupMember).toEqual([]);
    expect((await computeProjectAccess(auth(), "p")).level).toBe("admin");
    expect(fixture.events.every((e) => !e.inTransaction)).toBe(true);
  });

  it("can remove its own direct Admin grant and retain its automatic inherited role", async () => {
    group("g", "private", false);
    project();
    localMember("p", "admin", "admin");
    await removeMember(auth(), "p", "admin");
    expect(fixture.state.projectMember).toEqual([]);
    expect((await listMembers(auth(), "p"))[0]).toMatchObject({ source: "group", role: "admin", implicit: true });
  });

  it("cannot remove the synthetic inherited Admin through the direct-member endpoint", async () => {
    group("g", "private", false);
    project();
    await expect(removeMember(auth(), "p", "admin")).rejects.toMatchObject({ status: 404 });
    expect(fixture.writes).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it.each(["remove", "demote"] as const)("rolls back %s when the company has no fallback user", async (mutation) => {
    group("g", "private", false);
    project();
    localMember("p", "local", "admin");
    fixture.state.user = [];
    const before = structuredClone(fixture.state);
    await expect(mutation === "remove"
      ? removeMember(auth("local"), "p", "local")
      : updateMemberRole(auth("local"), "p", "local", "viewer")).rejects.toBeInstanceOf(LastAdminError);
    expect(fixture.state).toEqual(before);
    expect(fixture.events).toEqual([]);
  });

  it("rejects an orphan group as a source of automatic Admin protection", async () => {
    project("p", "missing", "private");
    localMember("p", "local", "admin");
    const before = structuredClone(fixture.state);
    await expect(removeMember(auth("local"), "p", "local")).rejects.toBeInstanceOf(LastAdminError);
    expect(fixture.state).toEqual(before);
  });

  it("rolls back a direct Admin removal with its failed audit while keeping the lazy grant", async () => {
    group("g", "private", false);
    project();
    localMember("p", "local", "admin");
    const before = structuredClone(fixture.state);
    fixture.failWrite = "activity";
    await expect(removeMember(auth("local"), "p", "local")).rejects.toThrow("forced activity failure");
    expect(fixture.state).toEqual(before);
    expect(fixture.events).toEqual([]);
  });
});

describe("automatic project Admin presentation", () => {
  it.each(["private", "public"])("synthesizes a stable Admin for an ungrouped adminless %s project with no owner", async (visibility) => {
    project("p", null, visibility);
    localMember("p", "viewer", "viewer");
    const before = structuredClone(fixture.state);
    const rows = await listMembers(auth("viewer"), "p");
    const automatic = rows.find((m) => m.userUuid === "admin");
    expect(automatic).toMatchObject({
      uuid: "implicit:p:admin", userUuid: "admin", name: "admin", email: "admin@test.local",
      role: "admin", source: "project", directRole: null, inheritedRole: null,
      effectiveRole: "admin", implicit: true, automaticAdmin: true,
    });
    expect((await listMembers(auth(), "p")).find((m) => m.userUuid === "admin")?.uuid).toBe(automatic?.uuid);
    expect((await computeProjectAccess(auth(), "p")).level).toBe("admin");
    expect(fixture.state).toEqual(before);
    expect(fixture.writes).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it.each(["viewer", "editor"])("overlays a stored %s without changing its identity or stored role", async (role) => {
    project("p", null, "private");
    localMember("p", "admin", role);
    const before = structuredClone(fixture.state);
    expect(await listMembers(auth(), "p")).toEqual([
      expect.objectContaining({
        uuid: "p-admin", userUuid: "admin", role: "admin", source: "project",
        directRole: role, inheritedRole: null, effectiveRole: "admin", implicit: true, automaticAdmin: true,
      }),
    ]);
    expect(fixture.state).toEqual(before);
    expect(fixture.writes).toEqual([]);
  });

  it.each(["missing", "foreign"])("uses the project fallback with a %s group reference", async (groupUuid) => {
    if (groupUuid === "foreign") {
      group("foreign", "private", false);
      fixture.state.projectGroup[0].companyUuid = "another-company";
    }
    project("p", groupUuid, "private");
    groupMember(groupUuid, "viewer", "admin");
    expect(await listMembers(auth(), "p")).toEqual([
      expect.objectContaining({
        uuid: "implicit:p:admin", userUuid: "admin", role: "admin", source: "project",
        directRole: null, inheritedRole: null, implicit: true,
      }),
    ]);
    expect(fixture.writes).toEqual([]);
  });

  it("ends the fallback presentation once a local explicit Admin exists", async () => {
    project("p", null, "private");
    localMember("p", "admin", "viewer");
    localMember("p", "editor", "admin");
    const rows = await listMembers(auth(), "p");
    expect(rows.find((m) => m.userUuid === "admin")).toMatchObject({ role: "viewer" });
    expect(rows.find((m) => m.userUuid === "editor")).toMatchObject({ role: "admin" });
    expect(rows.some((m) => m.implicit || m.automaticAdmin)).toBe(false);
  });

  it("follows a changed first company user without writing memberships", async () => {
    project("p", null, "private");
    expect((await listMembers(auth(), "p"))[0].userUuid).toBe("admin");
    fixture.state.user = fixture.state.user.filter((u) => u.uuid !== "admin");
    expect((await listMembers(auth("editor"), "p"))[0].userUuid).toBe("editor");
    expect(fixture.state.projectMember).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });
});

describe("automatic project Admin membership operations", () => {
  it.each([null, "viewer", "editor"])("blocks effective automatic Admin removal and demotion with direct role %s", async (role) => {
    project("p", null, "private");
    if (role) localMember("p", "admin", role);
    const before = structuredClone(fixture.state);
    await expect(removeMember(auth(), "p", "admin")).rejects.toMatchObject({
      status: 400, message: "Cannot remove or demote the automatic project Admin",
    });
    for (const nextRole of ["viewer", "editor"] as const) {
      await expect(updateMemberRole(auth(), "p", "admin", nextRole)).rejects.toMatchObject({ status: 400 });
    }
    expect(fixture.state).toEqual(before);
    expect(fixture.writes).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it("lets a synthetic Admin add an explicit Admin grant for themselves", async () => {
    project("p", null, "private");
    await expect(updateMemberRole(auth(), "p", "admin", "admin")).rejects.toMatchObject({ status: 404 });
    await addMember(auth(), "p", "admin", "admin");
    expect(await listMembers(auth(), "p")).toEqual([
      expect.objectContaining({ userUuid: "admin", role: "admin" }),
    ]);
    expect((await listMembers(auth(), "p"))[0].implicit).toBeUndefined();
    expect(fixture.events.find((e) => e.type === "access")?.data.userUuids).toEqual(["admin"]);
  });

  it("lets an automatic Admin promote a stored Viewer to an explicit Admin", async () => {
    project("p", null, "private");
    localMember("p", "admin", "viewer");
    await updateMemberRole(auth(), "p", "admin", "admin");
    expect(fixture.state.projectMember).toEqual([
      expect.objectContaining({ uuid: "p-admin", userUuid: "admin", role: "admin" }),
    ]);
    expect((await listMembers(auth(), "p"))[0].implicit).toBeUndefined();
  });

  it.each(["add", "promote"] as const)("reports old and new Admins after the first explicit Admin %s and clears cached fallback access", async (mutation) => {
    project("p", null, "private");
    if (mutation === "promote") localMember("p", "editor", "viewer");
    const actor = auth();
    await requireProjectAccess(actor, "p", "admin");
    if (mutation === "add") await addMember(actor, "p", "editor", "admin");
    else await updateMemberRole(actor, "p", "editor", "admin");
    expect(fixture.events.find((e) => e.type === "access")?.data).toEqual({
      companyUuid: "c", projectUuid: "p", userUuids: ["editor", "admin"],
    });
    expect(fixture.events.every((e) => !e.inTransaction)).toBe(true);
    expect((await computeProjectAccess(actor, "p")).level).toBe("none");
    await expect(requireProjectAccess(actor, "p", "viewer")).rejects.toMatchObject({ status: 404 });
  });

  it("retains a lower direct grant after another user becomes explicit Admin", async () => {
    project("p", null, "private");
    localMember("p", "admin", "viewer");
    await addMember(auth(), "p", "editor", "admin");
    expect((await listMembers(auth(), "p")).find((m) => m.userUuid === "admin")).toMatchObject({ role: "viewer" });
    expect((await computeProjectAccess(auth(), "p")).level).toBe("viewer");
  });

  it("keeps the fallback lazy when adding a non-Admin", async () => {
    project("p", null, "private");
    await addMember(auth(), "p", "viewer", "viewer");
    expect(fixture.state.projectMember.map((m) => m.userUuid)).toEqual(["viewer"]);
    expect(fixture.events.find((e) => e.type === "access")?.data.userUuids).toEqual(["viewer"]);
    expect((await listMembers(auth(), "p")).find((m) => m.userUuid === "admin")?.implicit).toBe(true);
  });

  it.each(["remove", "demote"] as const)("protects the last explicit ungrouped Admin from %s despite the potential fallback", async (mutation) => {
    project("p", null, "private");
    localMember("p", "editor", "admin");
    const before = structuredClone(fixture.state);
    await expect(mutation === "remove"
      ? removeMember(auth("editor"), "p", "editor")
      : updateMemberRole(auth("editor"), "p", "editor", "viewer")).rejects.toBeInstanceOf(LastAdminError);
    expect(fixture.state).toEqual(before);
    expect(fixture.events).toEqual([]);
  });

  it.each(["missing", "foreign"])("does not let a stale membership in a %s group bypass last explicit Admin protection", async (groupUuid) => {
    if (groupUuid === "foreign") {
      group("foreign", "private", false);
      fixture.state.projectGroup[0].companyUuid = "another-company";
    }
    project("p", groupUuid, "private");
    groupMember(groupUuid, "viewer", "admin");
    localMember("p", "editor", "admin");
    const before = structuredClone(fixture.state);
    await expect(removeMember(auth("editor"), "p", "editor")).rejects.toBeInstanceOf(LastAdminError);
    expect(fixture.state).toEqual(before);
    expect(fixture.events).toEqual([]);
  });

  it("rechecks automatic authority after the lock before creating a grant", async () => {
    project("p", null, "private");
    fixture.onLock = () => localMember("p", "editor", "admin");
    await expect(addMember(auth(), "p", "viewer", "viewer")).rejects.toMatchObject({ status: 404 });
    expect(fixture.state.projectMember.map((m) => m.userUuid)).toEqual(["editor"]);
    expect(fixture.writes).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it("rolls back explicit Admin creation with a failed audit without revoking the fallback", async () => {
    project("p", null, "private");
    const actor = auth();
    await requireProjectAccess(actor, "p", "admin");
    const before = structuredClone(fixture.state);
    fixture.failWrite = "activity";
    await expect(addMember(actor, "p", "editor", "admin")).rejects.toThrow("forced activity failure");
    expect(fixture.state).toEqual(before);
    expect(fixture.events).toEqual([]);
    expect((await requireProjectAccess(actor, "p", "admin")).accessLevel).toBe("admin");
  });

  it("keeps the automatic Admin lazy during an authorized visibility conversion", async () => {
    project("p", null, "public");
    const preview = await getProjectVisibilityPreview(auth(), "p", "private");
    await setVisibility(auth(), "p", "private", preview.confirmationToken);
    expect(fixture.state.project[0].visibility).toBe("private");
    expect(fixture.state.projectMember).toEqual([]);
    expect((await listMembers(auth(), "p"))[0]).toMatchObject({ role: "admin", implicit: true });
  });
});
