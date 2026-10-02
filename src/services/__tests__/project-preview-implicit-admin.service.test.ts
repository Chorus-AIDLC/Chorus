import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, auth, group, groupMember, project, localMember } from "./project-group.fixture";
import type { AuthContext } from "@/types/auth";
import type { ProjectAccessClient } from "@/services/project-access.service";

vi.mock("@/lib/prisma", async () => ({ prisma: (await import("./project-group.fixture")).fixture.prisma }));
// Keep the group authorization gate constant while changing the first User.
// Authorization itself is exercised by the existing preview and access tests.
vi.mock("@/services/project-group-access.service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/services/project-group-access.service")>();
  return {
    ...original,
    requireGroupOperation: vi.fn(async (
      actor: AuthContext, groupUuid: string, _operation: string, client: ProjectAccessClient,
    ) => {
      const row = await client.projectGroup.findFirst({ where: { companyUuid: actor.companyUuid, uuid: groupUuid } });
      if (!row) throw new original.GroupNotFoundError();
      return row;
    }),
  };
});

import { accessConfirmationToken, getProjectVisibilityPreview } from "@/services/project-access-preview.service";
import { getGroupVisibilityPreview, getProjectGroupMovePreview } from "@/services/project-group-preview.service";
import * as projectAccess from "@/services/project-access.service";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.reset();
  fixture.state.user.forEach((user, index) => Object.assign(user, {
    id: index + 1, createdAt: new Date("2026-01-01T00:00:00Z"),
  }));
  // Honor ordering and the UUID projection so fallback changes and the
  // helper's identity-free reads are observable within this focused fixture.
  fixture.prisma.user.findFirst.mockImplementation(async ({
    where, orderBy, select,
  }: {
    where: Record<string, string>; orderBy?: Array<Record<string, string>>; select?: Record<string, boolean>;
  }) => {
    const rows = fixture.state.user.filter((user) => Object.entries(where).every(([key, value]) => user[key] === value));
    for (const order of [...(orderBy ?? [])].reverse()) {
      const [key, direction] = Object.entries(order)[0];
      rows.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (direction === "desc" ? -1 : 1));
    }
    const row = rows[0];
    return row ? select
      ? Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]))
      : structuredClone(row) : null;
  });
  group("source", "public", false);
  group("target", "public", false);
  project("p", "source", "public");
  localMember("p", "local", "admin");
});

afterEach(() => vi.restoreAllMocks());

const previews = [
  { name: "project", get: () => getProjectVisibilityPreview(auth("local"), "p", "private"), deactivatedGroup: "source" },
  { name: "group", get: () => getGroupVisibilityPreview(auth("local"), "source", "private"), deactivatedGroup: "source" },
  { name: "move source", get: () => getProjectGroupMovePreview(auth("local"), "p", "target"), deactivatedGroup: "source" },
  { name: "move target", get: () => getProjectGroupMovePreview(auth("local"), "p", "target"), deactivatedGroup: "target" },
];

describe("implicit group Admin preview roles", () => {
  it("overlays the fallback Admin over a lower stored role in both project conversion directions without writing membership", async () => {
    groupMember("source", "admin", "viewer");
    const membership = structuredClone(fixture.state.projectGroupMember);
    const closed = await getProjectVisibilityPreview(auth("local"), "p", "private");
    expect(closed.changes.map((change) => change.userUuid)).toEqual(["editor", "outside", "viewer"]);
    expect(closed.summary).toEqual({
      affectedUserCount: 3, gainedAccessCount: 0, lostAccessCount: 3,
      increasedPermissionsCount: 0, decreasedPermissionsCount: 0, affectedProjectCount: 1,
    });
    fixture.state.project[0].visibility = "private";
    const opened = await getProjectVisibilityPreview(auth("local"), "p", "public");
    expect(opened.changes.map((change) => change.userUuid)).toEqual(["editor", "outside", "viewer"]);
    expect(opened.summary).toEqual({
      affectedUserCount: 3, gainedAccessCount: 3, lostAccessCount: 0,
      increasedPermissionsCount: 0, decreasedPermissionsCount: 0, affectedProjectCount: 1,
    });
    expect(fixture.prisma.user.findFirst).toHaveBeenCalledWith({
      where: { companyUuid: "c" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { uuid: true },
    });
    expect(fixture.state.projectGroupMember).toEqual(membership);
    expect(fixture.writes).toEqual([]);
  });

  it("retains the fallback Admin throughout group child closure", async () => {
    groupMember("source", "admin", "editor");
    project("q", "source", "public");
    const preview = await getGroupVisibilityPreview(auth("local"), "source", "private");
    expect(preview.projects).toHaveLength(2);
    for (const impact of preview.projects) {
      expect(impact.visibility).toBe("private");
      expect(impact.changes.some((change) => change.userUuid === "admin")).toBe(false);
    }
    expect(preview.summary).toEqual({
      affectedUserCount: 4, gainedAccessCount: 0, lostAccessCount: 4,
      increasedPermissionsCount: 0, decreasedPermissionsCount: 1, affectedProjectCount: 2,
    });
    expect(fixture.writes).toEqual([]);
  });

  it("overlays both source and target fallback Admins when a move closes company access", async () => {
    groupMember("source", "admin", "viewer");
    groupMember("target", "admin", "editor");
    fixture.state.projectGroup.find((row) => row.uuid === "target")!.visibility = "private";
    const preview = await getProjectGroupMovePreview(auth("local"), "p", "target");
    expect(preview.changes.map((change) => change.userUuid)).toEqual(["editor", "outside", "viewer"]);
    expect(preview.summary).toEqual({
      affectedUserCount: 3, gainedAccessCount: 0, lostAccessCount: 3,
      increasedPermissionsCount: 0, decreasedPermissionsCount: 0, affectedProjectCount: 1,
    });
    expect(fixture.writes).toEqual([]);
  });

  it("retains the source fallback Admin in a detached project's explicit role snapshot preview", async () => {
    groupMember("source", "admin", "viewer");
    fixture.state.projectGroup[0].visibility = "private";
    fixture.state.project[0].visibility = "private";
    const preview = await getProjectGroupMovePreview(auth("local"), "p", null);
    expect(preview.changes).toEqual([]);
    expect(preview.summary).toEqual({
      affectedUserCount: 0, gainedAccessCount: 0, lostAccessCount: 0,
      increasedPermissionsCount: 0, decreasedPermissionsCount: 0, affectedProjectCount: 1,
    });
  });

  it("counts target fallback Admin inheritance when attaching an ungrouped private project", async () => {
    fixture.state.project[0].groupUuid = null;
    fixture.state.project[0].visibility = "private";
    fixture.state.projectGroup.find((row) => row.uuid === "target")!.visibility = "private";
    const preview = await getProjectGroupMovePreview(auth("local"), "p", "target");
    expect(preview.changes).toEqual([expect.objectContaining({
      userUuid: "admin", beforeRole: "none", afterRole: "admin",
    })]);
    expect(preview.summary).toEqual({
      affectedUserCount: 1, gainedAccessCount: 1, lostAccessCount: 0,
      increasedPermissionsCount: 0, decreasedPermissionsCount: 0, affectedProjectCount: 1,
    });
  });
});

describe.each(previews)("$name implicit Admin fingerprint", ({ name, get, deactivatedGroup }) => {
  it.each(["createdAt", "id"])("invalidates confirmation when the first User changes by %s with the same company user UUIDs", async (field) => {
    if (name === "move source") groupMember("target", "local", "admin");
    if (name === "move target") groupMember("source", "local", "admin");
    // Keep every child/project role constant, isolating the implicit UUID in
    // the fingerprint from role changes and the authenticated actor.
    for (const user of fixture.state.user) if (user.uuid !== "local") localMember("p", user.uuid, "admin");
    const before = await get();
    const uuids = fixture.state.user.map((user) => user.uuid);
    const next = fixture.state.user.find((user) => user.uuid === "viewer")!;
    next[field] = field === "id" ? 0 : new Date("2025-01-01T00:00:00Z");
    const after = await get();
    expect(after.confirmationToken).not.toBe(before.confirmationToken);
    expect(fixture.state.user.map((user) => user.uuid)).toEqual(uuids);
    const impacts = "projects" in after ? after.projects : [after];
    expect(impacts.flatMap((impact) => impact.changes)).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });

  it("keeps confirmation stable across display identity edits with an active fallback", async () => {
    const before = await get();
    Object.assign(fixture.state.user[0], { name: "Updated Name", email: "updated@example.com" });
    const after = await get();
    expect(after.confirmationToken).toBe(before.confirmationToken);
  });

  it("deactivates the fallback as soon as a new explicit Admin exists", async () => {
    fixture.state.user = fixture.state.user.filter((user) => ["admin", "local"].includes(user.uuid));
    groupMember("source", "admin", "viewer");
    groupMember("target", "admin", "viewer");
    fixture.state.projectGroup.find((row) => row.uuid === "target")!.visibility = "private";
    const before = await get();
    const beforeImpacts = "projects" in before ? before.projects : [before];
    expect(beforeImpacts.flatMap((impact) => impact.changes)).toEqual([]);
    groupMember(deactivatedGroup, "local", "admin");
    const after = await get();
    const afterImpacts = "projects" in after ? after.projects : [after];
    const beforeRole = name === "move target" ? "admin" : "editor";
    const afterRole = name === "move source" ? "admin" : "viewer";
    expect(afterImpacts.flatMap((impact) => impact.changes)).toEqual([expect.objectContaining({
      userUuid: "admin", beforeRole, afterRole,
    })]);
    expect(after.confirmationToken).not.toBe(before.confirmationToken);
    expect(after.summary).toEqual({
      affectedUserCount: 1, gainedAccessCount: 0, lostAccessCount: 0,
      increasedPermissionsCount: name === "move source" ? 1 : 0,
      decreasedPermissionsCount: name === "move source" ? 0 : 1, affectedProjectCount: 1,
    });
    expect(fixture.writes).toEqual([]);
  });
});

const projectFallbackPreviews = [
  { name: "visibility", get: (actor = "admin") => getProjectVisibilityPreview(auth(actor), "p", "private") },
  { name: "move", get: (actor = "admin") => getProjectGroupMovePreview(auth(actor), "p", "target") },
];

describe.each(projectFallbackPreviews)("$name project fallback fingerprint", ({ name, get }) => {
  function ungroupedProject() {
    fixture.state.project[0].groupUuid = null;
    fixture.state.projectMember = [];
    groupMember("target", "local", "admin");
  }

  it.each(["createdAt", "id"])("binds the project fallback UUID when the first User changes by %s", async (field) => {
    ungroupedProject();
    // Keep source authority fixed so the fingerprint is compared for the same
    // actor even after that actor ceases to be the computed project Admin.
    const authorized = await projectAccess.computeProjectAccess(auth(), "p");
    vi.spyOn(projectAccess, "computeProjectAccess").mockResolvedValue(authorized);
    const before = await get();
    const uuids = fixture.state.user.map((user) => user.uuid);
    const next = fixture.state.user.find((user) => user.uuid === "viewer")!;
    next[field] = field === "id" ? 0 : new Date("2025-01-01T00:00:00Z");
    const after = await get();
    expect(after.confirmationToken).not.toBe(before.confirmationToken);
    expect(fixture.state.user.map((user) => user.uuid)).toEqual(uuids);
    expect(fixture.writes).toEqual([]);
  });

  it("keeps a project fallback confirmation stable across display identity changes", async () => {
    ungroupedProject();
    const before = await get();
    Object.assign(fixture.state.user[0], { name: "Updated Name", email: "updated@example.com" });
    const after = await get();
    expect(after.confirmationToken).toBe(before.confirmationToken);
  });

  it.each(["local Admin", "live group Admin"])("keeps the token stable across first User changes when a %s suppresses the project fallback", async (suppression) => {
    groupMember("target", "local", "admin");
    if (suppression === "local Admin") fixture.state.project[0].groupUuid = null;
    else {
      fixture.state.projectMember = [];
      groupMember("source", "local", "admin");
    }
    const before = await get("local");
    fixture.state.user.find((user) => user.uuid === "viewer")!.createdAt = new Date("2025-01-01T00:00:00Z");
    const after = await get("local");
    expect(after.confirmationToken).toBe(before.confirmationToken);
    expect(fixture.writes).toEqual([]);
  });

  it("deactivates the computed project Admin when an explicit local Admin is added", async () => {
    ungroupedProject();
    const before = await get();
    localMember("p", "admin", "admin");
    const after = await get();
    expect(after.confirmationToken).not.toBe(before.confirmationToken);
    if (name === "visibility") {
      expect(after.changes).toEqual(before.changes);
      expect(after.summary).toEqual(before.summary);
    } else {
      expect(before.changes).toContainEqual(expect.objectContaining({
        userUuid: "admin", beforeRole: "admin", afterRole: "editor",
      }));
      expect(after.changes.some((change) => change.userUuid === "admin")).toBe(false);
      expect(after.summary).toEqual({
        affectedUserCount: 1, gainedAccessCount: 0, lostAccessCount: 0,
        increasedPermissionsCount: 1, decreasedPermissionsCount: 0, affectedProjectCount: 1,
      });
    }
    expect(fixture.writes).toEqual([]);
  });
});

it("includes the project fallback UUID explicitly in an ungrouped visibility confirmation", async () => {
  fixture.state.project[0].groupUuid = null;
  fixture.state.projectMember = [];
  const preview = await getProjectVisibilityPreview(auth(), "p", "private");
  const p = fixture.state.project[0];
  expect(preview.confirmationToken).toBe(accessConfirmationToken({
    operation: "project_visibility", companyUuid: "c",
    principal: "admin", actorType: "user", actorUuid: "admin",
    project: { uuid: p.uuid, visibility: p.visibility, groupUuid: null },
    visibility: "private", group: null, direct: [], inherited: [],
    implicitAdminUuid: null, projectImplicitAdminUuid: "admin",
    users: fixture.state.user.slice().sort((a, b) => a.uuid.localeCompare(b.uuid)).map(({ uuid }) => ({ uuid })),
  }));
  expect(fixture.writes).toEqual([]);
});
