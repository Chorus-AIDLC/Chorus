import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, auth, group, groupMember, project, localMember } from "./project-group.fixture";
import type { AuthContext } from "@/types/auth";

vi.mock("@/lib/prisma", async () => ({ prisma: (await import("./project-group.fixture")).fixture.prisma }));

import { accessConfirmationToken, getProjectVisibilityPreview, summarizeAccessChanges } from "@/services/project-access-preview.service";
import { getGroupVisibilityPreview, getProjectGroupMovePreview } from "@/services/project-group-preview.service";

const previews = [
  { name: "project visibility", get: (actor: AuthContext) => getProjectVisibilityPreview(actor, "p", "private") },
  { name: "group visibility", get: (actor: AuthContext) => getGroupVisibilityPreview(actor, "source", "private") },
  { name: "group move", get: (actor: AuthContext) => getProjectGroupMovePreview(actor, "p", "target") },
];

beforeEach(() => {
  vi.clearAllMocks();
  fixture.reset();
  group("source", "public");
  group("target", "public");
  project("p", "source", "public");
  groupMember("source", "viewer", "viewer");
  groupMember("target", "outside", "admin");
  fixture.state.user.find((user) => user.uuid === "outside")!.name = "Sam Example";
  fixture.state.user.push({ uuid: "foreign", companyUuid: "other", name: "Foreign User", email: "foreign@example.com" });
  // Unlike the shared fixture, honor the projection so accidental identity
  // reads and changes to the UUID-only confirmation input are observable.
  fixture.prisma.user.findMany.mockImplementation(async ({
    where, select,
  }: { where: { companyUuid: string }; select: Record<string, boolean> }) =>
    fixture.state.user.filter((user) => user.companyUuid === where.companyUuid)
      .sort((a, b) => a.uuid.localeCompare(b.uuid))
      .map((user) => Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, user[key]]))),
  );
});

describe("compact impact summaries", () => {
  it("deduplicates users across resources and counts each kind of effect", () => {
    expect(summarizeAccessChanges([
      { userUuid: "loss", beforeRole: "editor", afterRole: "none" },
      { userUuid: "loss", beforeRole: "viewer", afterRole: "none" },
      { userUuid: "gain", beforeRole: "none", afterRole: "viewer" },
      { userUuid: "raise", beforeRole: "viewer", afterRole: "admin" },
      { userUuid: "lower", beforeRole: "admin", afterRole: "editor" },
      { userUuid: "lower", beforeRole: "editor", afterRole: "none" },
      { userUuid: "same", beforeRole: "admin", afterRole: "admin" },
    ], 3)).toEqual({
      affectedUserCount: 4, gainedAccessCount: 1, lostAccessCount: 2,
      increasedPermissionsCount: 1, decreasedPermissionsCount: 1, affectedProjectCount: 3,
    });
  });

  it("counts group discovery loss even when the group has no child projects", async () => {
    fixture.state.project = [];
    const impact = await getGroupVisibilityPreview(auth(), "source", "private");
    expect(impact.projects).toEqual([]);
    expect(impact.summary).toEqual({
      affectedUserCount: 4, gainedAccessCount: 0, lostAccessCount: 3,
      increasedPermissionsCount: 0, decreasedPermissionsCount: 1, affectedProjectCount: 0,
    });
  });

  it("deduplicates a user's group and child losses and retains project-only discovery", async () => {
    project("q", "source", "public");
    localMember("p", "local", "viewer");
    const impact = await getGroupVisibilityPreview(auth(), "source", "private");
    expect(impact.summary).toEqual({
      affectedUserCount: 4, gainedAccessCount: 0, lostAccessCount: 3,
      increasedPermissionsCount: 0, decreasedPermissionsCount: 2, affectedProjectCount: 2,
    });
    // local loses q but retains p and basic group visibility, so also loses
    // the public editing baseline rather than being reported as hidden entirely.
    expect(impact.projects[0].changes).toContainEqual(expect.objectContaining({
      userUuid: "local", beforeRole: "editor", afterRole: "viewer",
    }));
  });

  it("counts company access opening while private child projects remain private", async () => {
    fixture.state.projectGroup.find((group) => group.uuid === "source")!.visibility = "private";
    fixture.state.project[0].visibility = "private";
    const impact = await getGroupVisibilityPreview(auth(), "source", "public");
    expect(impact.summary).toEqual({
      affectedUserCount: 4, gainedAccessCount: 3, lostAccessCount: 0,
      increasedPermissionsCount: 1, decreasedPermissionsCount: 0, affectedProjectCount: 0,
    });
    expect(impact.projects[0].visibility).toBe("private");
  });

  it("counts settings permission changes for an Editor whose role is unchanged", async () => {
    groupMember("source", "editor", "editor");
    fixture.state.project = [];
    const closed = await getGroupVisibilityPreview(auth(), "source", "private");
    expect(closed.summary).toEqual({
      affectedUserCount: 4, gainedAccessCount: 0, lostAccessCount: 2,
      increasedPermissionsCount: 0, decreasedPermissionsCount: 2, affectedProjectCount: 0,
    });
    fixture.state.projectGroup.find((group) => group.uuid === "source")!.visibility = "private";
    const opened = await getGroupVisibilityPreview(auth(), "source", "public");
    expect(opened.summary).toEqual({
      affectedUserCount: 4, gainedAccessCount: 2, lostAccessCount: 0,
      increasedPermissionsCount: 2, decreasedPermissionsCount: 0, affectedProjectCount: 0,
    });
  });

  it("returns a zero summary for no-op previews and one affected project for conversion", async () => {
    const same = await getProjectVisibilityPreview(auth(), "p", "public");
    expect(same.summary).toEqual({
      affectedUserCount: 0, gainedAccessCount: 0, lostAccessCount: 0,
      increasedPermissionsCount: 0, decreasedPermissionsCount: 0, affectedProjectCount: 0,
    });
    const convert = await getProjectVisibilityPreview(auth(), "p", "private");
    expect(convert.summary).toEqual({
      affectedUserCount: 4, gainedAccessCount: 0, lostAccessCount: 3,
      increasedPermissionsCount: 0, decreasedPermissionsCount: 1, affectedProjectCount: 1,
    });
  });

  it.each(["local", "inherited", "both"])(
    "counts retained %s Editor management permission changes in both directions without role diffs",
    async (grant) => {
      fixture.state.user = fixture.state.user.filter((user) => ["admin", "editor"].includes(user.uuid));
      if (grant !== "inherited") localMember("p", "editor", "editor");
      if (grant !== "local") groupMember("source", "editor", "editor");
      const closed = await getProjectVisibilityPreview(auth(), "p", "private");
      expect(closed.changes).toEqual([]);
      expect(closed.summary).toEqual({
        affectedUserCount: 1, gainedAccessCount: 0, lostAccessCount: 0,
        increasedPermissionsCount: 0, decreasedPermissionsCount: 1, affectedProjectCount: 1,
      });
      fixture.state.project[0].visibility = "private";
      const opened = await getProjectVisibilityPreview(auth(), "p", "public");
      expect(opened.changes).toEqual([]);
      expect(opened.summary).toEqual({
        affectedUserCount: 1, gainedAccessCount: 0, lostAccessCount: 0,
        increasedPermissionsCount: 1, decreasedPermissionsCount: 0, affectedProjectCount: 1,
      });
    },
  );

  it.each(["local", "inherited"])(
    "deduplicates retained %s Editor management losses across group child closure",
    async (grant) => {
      fixture.state.user = fixture.state.user.filter((user) => ["admin", "editor"].includes(user.uuid));
      project("q", "source", "public");
      if (grant === "local") {
        localMember("p", "editor", "editor");
        localMember("q", "editor", "editor");
      } else groupMember("source", "editor", "editor");
      const closed = await getGroupVisibilityPreview(auth(), "source", "private");
      expect(closed.projects.map((impact) => impact.changes)).toEqual([[], []]);
      expect(closed.summary).toEqual({
        affectedUserCount: 1, gainedAccessCount: 0, lostAccessCount: 0,
        increasedPermissionsCount: 0, decreasedPermissionsCount: 1, affectedProjectCount: 2,
      });
      fixture.state.projectGroup.find((row) => row.uuid === "source")!.visibility = "private";
      for (const row of fixture.state.project) row.visibility = "private";
      const opened = await getGroupVisibilityPreview(auth(), "source", "public");
      // Reopening the group restores settings editing, leaving children private.
      expect(opened.projects.map((impact) => impact.visibility)).toEqual(["private", "private"]);
      expect(opened.summary).toEqual({
        affectedUserCount: 1, gainedAccessCount: 0, lostAccessCount: 0,
        increasedPermissionsCount: 1, decreasedPermissionsCount: 0, affectedProjectCount: 0,
      });
    },
  );

  it.each(["local", "inherited"])(
    "counts retained %s Editor management loss when moving a public project into a private group",
    async (grant) => {
      fixture.state.user = fixture.state.user.filter((user) => ["admin", "editor"].includes(user.uuid));
      fixture.state.projectGroup.find((row) => row.uuid === "target")!.visibility = "private";
      if (grant === "local") localMember("p", "editor", "editor");
      else {
        groupMember("source", "editor", "editor");
        groupMember("target", "editor", "editor");
      }
      const preview = await getProjectGroupMovePreview(auth(), "p", "target");
      expect(preview.changes).toEqual([]);
      expect(preview.visibility).toBe("private");
      expect(preview.requiresConfirmation).toBe(true);
      expect(preview.summary).toEqual({
        affectedUserCount: 1, gainedAccessCount: 0, lostAccessCount: 0,
        increasedPermissionsCount: 0, decreasedPermissionsCount: 1, affectedProjectCount: 1,
      });
    },
  );

  it("does not count an unchanged Admin twice when a Viewer gains public Editor access", async () => {
    fixture.state.user = fixture.state.user.filter((user) => ["admin", "viewer"].includes(user.uuid));
    fixture.state.project[0].visibility = "private";
    const opened = await getProjectVisibilityPreview(auth(), "p", "public");
    expect(opened.changes).toEqual([expect.objectContaining({
      userUuid: "viewer", beforeRole: "viewer", afterRole: "editor",
    })]);
    expect(opened.summary).toEqual({
      affectedUserCount: 1, gainedAccessCount: 0, lostAccessCount: 0,
      increasedPermissionsCount: 1, decreasedPermissionsCount: 0, affectedProjectCount: 1,
    });
  });
});

describe.each(previews)("$name preview identities", ({ get }) => {
  it("includes same-company names and emails only for affected users", async () => {
    const preview = await get(auth());
    const changes = "projects" in preview ? preview.projects.flatMap((impact) => impact.changes) : preview.changes;
    expect(changes).toContainEqual(expect.objectContaining({
      userUuid: "outside", name: "Sam Example", email: "outside@test.local",
    }));
    expect(changes.some((change) => change.userUuid === "admin")).toBe(false);
    expect(JSON.stringify(preview)).not.toMatch(/foreign|Foreign User/);
    expect(fixture.prisma.user.findMany).toHaveBeenCalledWith({
      where: { companyUuid: "c" }, select: { uuid: true, name: true, email: true }, orderBy: { uuid: "asc" },
    });
  });

  it("keeps a user's UUID when both display fields are unavailable", async () => {
    Object.assign(fixture.state.user.find((user) => user.uuid === "outside")!, { name: null, email: null });
    const preview = await get(auth());
    const changes = "projects" in preview ? preview.projects.flatMap((impact) => impact.changes) : preview.changes;
    expect(changes).toContainEqual(expect.objectContaining({ userUuid: "outside", name: null, email: null }));
  });

  it("uses an agent's existing owner Admin authority", async () => {
    const preview = await get({ type: "agent", companyUuid: "c", actorUuid: "agent", ownerUuid: "admin" });
    const changes = "projects" in preview ? preview.projects.flatMap((impact) => impact.changes) : preview.changes;
    expect(changes).toContainEqual(expect.objectContaining({ userUuid: "outside", name: "Sam Example" }));
  });

  it("does not read identities across company boundaries", async () => {
    await expect(get({ ...auth(), companyUuid: "other" })).rejects.toMatchObject({ status: 404 });
    expect(fixture.prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("keeps the access fingerprint stable when only display identities change", async () => {
    const before = await get(auth());
    Object.assign(fixture.state.user.find((user) => user.uuid === "outside")!, {
      name: "Updated Name", email: "updated@example.com",
    });
    const after = await get(auth());
    expect(after.confirmationToken).toBe(before.confirmationToken);
    const changes = "projects" in after ? after.projects.flatMap((impact) => impact.changes) : after.changes;
    expect(changes).toContainEqual(expect.objectContaining({ name: "Updated Name", email: "updated@example.com" }));
  });

  it("still binds confirmation to membership, company users, and actor", async () => {
    const before = await get(auth());
    groupMember("source", "local", "admin");
    const withMember = await get(auth());
    expect(withMember.confirmationToken).not.toBe(before.confirmationToken);
    fixture.state.user.push({ uuid: "new-user", companyUuid: "c", name: "New User", email: null });
    const withUser = await get(auth());
    expect(withUser.confirmationToken).not.toBe(withMember.confirmationToken);
    localMember("p", "local", "admin");
    const admin = await get(auth());
    expect(admin.confirmationToken).not.toBe(withUser.confirmationToken);
    const otherAdmin = await get(auth("local"));
    expect(otherAdmin.confirmationToken).not.toBe(admin.confirmationToken);
  });
});

describe("preview authorization and confirmation inputs", () => {
  it.each(["editor", "viewer", "outside"])("rejects %s visibility previews before reading identities", async (actor) => {
    await expect(getProjectVisibilityPreview(auth(actor), "p", "private")).rejects.toMatchObject({ status: 403 });
    await expect(getGroupVisibilityPreview(auth(actor), "source", "private")).rejects.toMatchObject({ status: 403 });
    expect(fixture.prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("keeps editor-authorized public move role changes UUID-only", async () => {
    fixture.state.projectGroupMember = fixture.state.projectGroupMember.filter(
      (member) => !(member.groupUuid === "target" && member.userUuid === "outside"),
    );
    groupMember("source", "local", "admin");
    const preview = await getProjectGroupMovePreview(auth("editor"), "p", "target");
    expect(preview.changes).toEqual([{ userUuid: "local", beforeRole: "admin", afterRole: "editor" }]);
    expect(fixture.prisma.user.findMany).toHaveBeenCalledWith({
      where: { companyUuid: "c" }, select: { uuid: true }, orderBy: { uuid: "asc" },
    });
    expect(JSON.stringify(preview)).not.toMatch(/Sam Example|@test.local/);
  });

  it("rejects editor moves that expand access without reading names or emails", async () => {
    await expect(getProjectGroupMovePreview(auth("editor"), "p", "target")).rejects.toMatchObject({ status: 403 });
    expect(fixture.prisma.user.findMany).toHaveBeenCalledWith({
      where: { companyUuid: "c" }, select: { uuid: true }, orderBy: { uuid: "asc" },
    });
  });

  it("preserves the existing project visibility token's UUID-only user projection", async () => {
    const preview = await getProjectVisibilityPreview(auth(), "p", "private");
    const p = fixture.state.project[0];
    const g = fixture.state.projectGroup[0];
    expect(preview.confirmationToken).toBe(accessConfirmationToken({
      operation: "project_visibility", companyUuid: "c",
      principal: "admin", actorType: "user", actorUuid: "admin",
      project: { uuid: p.uuid, visibility: p.visibility, groupUuid: p.groupUuid },
      visibility: "private", group: g, direct: [],
      inherited: fixture.state.projectGroupMember.filter((member) => member.groupUuid === "source")
        .sort((a, b) => a.userUuid.localeCompare(b.userUuid)),
      implicitAdminUuid: null,
      projectImplicitAdminUuid: null,
      users: fixture.state.user.filter((user) => user.companyUuid === "c")
        .sort((a, b) => a.uuid.localeCompare(b.uuid)).map(({ uuid }) => ({ uuid })),
    }));
  });
});

describe("lazy project Admin previews without a local Admin", () => {
  const orphanGroups = [
    { name: "ungrouped", groupUuid: null },
    { name: "missing group", groupUuid: "missing" },
    { name: "foreign group", groupUuid: "foreign-group" },
  ];

  function orphanProject(groupUuid: string | null) {
    fixture.state.project[0].groupUuid = groupUuid;
    if (groupUuid === "foreign-group") {
      group(groupUuid, "private", false);
      fixture.state.projectGroup.find((row) => row.uuid === groupUuid)!.companyUuid = "other";
    }
  }

  it.each(orphanGroups)(
    "retains the first User's Admin and counts retained Editor permissions for $name projects in both visibility directions",
    async ({ groupUuid }) => {
      orphanProject(groupUuid);
      localMember("p", "admin", "viewer");
      localMember("p", "editor", "editor");
      const members = structuredClone(fixture.state.projectMember);
      const closed = await getProjectVisibilityPreview(auth(), "p", "private");
      expect(closed.changes.map((change) => change.userUuid)).toEqual(["local", "outside", "viewer"]);
      expect(closed.summary).toEqual({
        affectedUserCount: 4, gainedAccessCount: 0, lostAccessCount: 3,
        increasedPermissionsCount: 0, decreasedPermissionsCount: 1, affectedProjectCount: 1,
      });
      fixture.state.project[0].visibility = "private";
      const opened = await getProjectVisibilityPreview(auth(), "p", "public");
      expect(opened.changes.map((change) => change.userUuid)).toEqual(["local", "outside", "viewer"]);
      expect(opened.summary).toEqual({
        affectedUserCount: 4, gainedAccessCount: 3, lostAccessCount: 0,
        increasedPermissionsCount: 1, decreasedPermissionsCount: 0, affectedProjectCount: 1,
      });
      expect(fixture.state.projectMember).toEqual(members);
      expect(fixture.writes).toEqual([]);
    },
  );

  it.each(orphanGroups)(
    "suppresses the $name project fallback when moving into a group with another explicit Admin",
    async ({ groupUuid }) => {
      orphanProject(groupUuid);
      fixture.state.projectGroupMember = fixture.state.projectGroupMember.filter((member) => member.groupUuid !== "target");
      groupMember("target", "editor", "admin");
      localMember("p", "admin", "viewer");
      const preview = await getProjectGroupMovePreview(auth(), "p", "target");
      expect(preview.changes).toEqual([
        expect.objectContaining({ userUuid: "admin", beforeRole: "admin", afterRole: "editor" }),
        expect.objectContaining({ userUuid: "editor", beforeRole: "editor", afterRole: "admin" }),
      ]);
      expect(preview.summary).toEqual({
        affectedUserCount: 2, gainedAccessCount: 0, lostAccessCount: 0,
        increasedPermissionsCount: 1, decreasedPermissionsCount: 1, affectedProjectCount: 1,
      });
      expect(preview.requiresConfirmation).toBe(true);
      expect(fixture.writes).toEqual([]);
    },
  );

  it.each(orphanGroups)(
    "retains the computed project Admin when detaching a private $name project without local Admin grants",
    async ({ groupUuid }) => {
      orphanProject(groupUuid);
      fixture.state.project[0].visibility = "private";
      const preview = await getProjectGroupMovePreview(auth(), "p", null);
      expect(preview.changes).toEqual([]);
      expect(preview.summary).toEqual({
        affectedUserCount: 0, gainedAccessCount: 0, lostAccessCount: 0,
        increasedPermissionsCount: 0, decreasedPermissionsCount: 0,
        affectedProjectCount: groupUuid === null ? 0 : 1,
      });
      expect(fixture.state.projectMember).toEqual([]);
      expect(fixture.writes).toEqual([]);
    },
  );

  it("replaces an ungrouped project's fallback with the destination group's fallback without a role change", async () => {
    orphanProject(null);
    fixture.state.projectGroupMember = fixture.state.projectGroupMember.filter((member) => member.groupUuid !== "target");
    const preview = await getProjectGroupMovePreview(auth(), "p", "target");
    expect(preview.changes).toEqual([]);
    expect(preview.summary).toEqual({
      affectedUserCount: 0, gainedAccessCount: 0, lostAccessCount: 0,
      increasedPermissionsCount: 0, decreasedPermissionsCount: 0, affectedProjectCount: 1,
    });
    expect(fixture.writes).toEqual([]);
  });

  it("retains a non-first source group Admin when detaching without inventing a project fallback", async () => {
    fixture.state.projectGroupMember = fixture.state.projectGroupMember.filter((member) => member.groupUuid !== "source");
    groupMember("source", "editor", "admin");
    const preview = await getProjectGroupMovePreview(auth("editor"), "p", null);
    expect(preview.changes).toEqual([]);
    expect(preview.summary).toEqual({
      affectedUserCount: 0, gainedAccessCount: 0, lostAccessCount: 0,
      increasedPermissionsCount: 0, decreasedPermissionsCount: 0, affectedProjectCount: 1,
    });
    expect(fixture.writes).toEqual([]);
  });
});
