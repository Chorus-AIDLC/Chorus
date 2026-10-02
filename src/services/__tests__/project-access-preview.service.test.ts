import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, auth, group, groupMember, project, localMember } from "./project-group.fixture";
import type { AuthContext } from "@/types/auth";

vi.mock("@/lib/prisma", async () => ({ prisma: (await import("./project-group.fixture")).fixture.prisma }));

import { accessConfirmationToken, getProjectVisibilityPreview } from "@/services/project-access-preview.service";
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
      users: fixture.state.user.filter((user) => user.companyUuid === "c")
        .sort((a, b) => a.uuid.localeCompare(b.uuid)).map(({ uuid }) => ({ uuid })),
    }));
  });
});
