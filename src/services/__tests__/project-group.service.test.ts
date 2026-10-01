import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, events, auth, group, groupMember, project, localMember } from "./project-group.fixture";
vi.mock("@/lib/prisma", async () => ({ prisma: (await import("./project-group.fixture")).fixture.prisma }));
vi.mock("@/lib/event-bus", async () => ({ eventBus: (await import("./project-group.fixture")).events }));
vi.mock("@/services/activity.service", () => ({ createActivityInTx: vi.fn(async () => ({ publish: vi.fn() })) }));
import { createProjectGroup, updateProjectGroup, deleteProjectGroup, getProjectGroup, listProjectGroups, getGroupDashboard, moveProjectToGroup } from "@/services/project-group.service";
import { getGroupAccess, requireGroupOperation, accessibleGroupWhere } from "@/services/project-group-access.service";
import { getGroupVisibilityPreview, getProjectGroupMovePreview } from "@/services/project-group-preview.service";
import { addGroupMember, updateGroupMember, removeGroupMember, listGroupMembers } from "@/services/project-group-member.service";
import { computeProjectAccess } from "@/services/project-access.service";
import { createProject, updateProject, deleteProject } from "@/services/project.service";
import { createProjectWithAgentCwds, updateProjectWithAgentCwds } from "@/services/project-agent-cwd.service";

beforeEach(() => { vi.clearAllMocks(); fixture.reset(); });
const state = () => structuredClone(fixture.state);
const convert = async (visibility: "public" | "private", extra = {}) => {
  const preview = await getGroupVisibilityPreview(auth(), "g", visibility);
  return updateProjectGroup({ companyUuid: "c", groupUuid: "g", visibility, confirmationToken: preview.confirmationToken, ...extra }, auth());
};

describe("group discovery and filtered aggregates", () => {
  it("hides private metadata from an outsider through get/list/dashboard and shared query", async () => {
    group(); project();
    expect((await getGroupAccess(auth("outside"), "g")).group).toBeNull();
    expect(await getProjectGroup("c", "g", auth("outside"))).toBeNull();
    expect(await getGroupDashboard("c", "g", auth("outside"))).toBeNull();
    expect((await listProjectGroups("c", auth("outside"))).groups).toEqual([]);
    expect(await fixture.prisma.projectGroup.findMany({ where: await accessibleGroupWhere(auth("outside")) })).toEqual([]);
  });
  it("project-only visitor has Viewer presentation and no group or roster authority", async () => {
    group(); project(); project("hidden"); localMember("p", "local", "admin");
    expect(await getGroupAccess(auth("local"), "g")).toMatchObject({ level: "viewer", explicitRole: null, canManage: false, canCreateProject: false, accessInitialized: true });
    expect(await getProjectGroup("c", "g", auth("local"))).toMatchObject({ accessLevel: "viewer", explicitRole: null, projectCount: 1, projects: [{ uuid: "p" }] });
    expect((await listProjectGroups("c", auth("local"))).groups).toHaveLength(1);
    await expect(listGroupMembers(auth("local"), "g")).rejects.toMatchObject({ status: 403 });
    for (const op of ["manage_group", "create_project", "manage_members", "delete_group"] as const) await expect(requireGroupOperation(auth("local"), "g", op)).rejects.toMatchObject({ status: 403 });
  });
  it("filters dashboard tasks, ideas, proposals and activities to the readable project", async () => {
    group(); project(); project("hidden"); localMember("p", "local", "viewer");
    for (const p of ["p", "hidden"]) {
      fixture.state.task.push({ uuid: `task-${p}`, companyUuid: "c", projectUuid: p, status: p === "p" ? "done" : "open" });
      fixture.state.idea.push({ uuid: `idea-${p}`, companyUuid: "c", projectUuid: p, status: "open" });
      fixture.state.proposal.push({ uuid: `prop-${p}`, companyUuid: "c", projectUuid: p, status: "pending" });
      fixture.state.activity.push({ uuid: `act-${p}`, companyUuid: "c", projectUuid: p, targetType: "task", targetUuid: "t", action: "created", actorType: "user", actorUuid: "admin", createdAt: new Date() });
    }
    const dashboard = await getGroupDashboard("c", "g", auth("local"));
    expect(dashboard?.stats).toEqual({ projectCount: 1, totalTasks: 1, completedTasks: 1, completionRate: 100, openIdeas: 1, activeProposals: 1 });
    expect(dashboard?.recentActivity.map((a) => a.projectUuid)).toEqual(["p"]);
    expect(dashboard?.projects[0]).toMatchObject({ uuid: "p", visibility: "private", taskCount: 1, completionRate: 100 });
  });
  it("empty dashboard and ungrouped counts expose only public or granted projects", async () => {
    group("g", "public"); project("open", null, "public"); project("hidden", null); project("mine", null); localMember("mine", "local", "viewer");
    expect((await listProjectGroups("c", auth("local"))).ungroupedCount).toBe(2);
    expect((await getGroupDashboard("c", "g", auth("local")))?.stats).toMatchObject({ projectCount: 0, completionRate: 0 });
  });
  it("public group editor baseline never exposes a private child", async () => {
    group("g", "public"); project();
    expect(await getGroupAccess(auth("outside"), "g")).toMatchObject({ level: "editor", canManage: true, canCreateProject: true, explicitRole: null });
    expect(await computeProjectAccess(auth("outside"), "p")).toMatchObject({ level: "none", project: null });
    expect((await getProjectGroup("c", "g", auth("outside")))?.projectCount).toBe(0);
  });
  it.each(["viewer", "editor", "admin"])("explicit %s discovers private groups via owner-backed agents", async (role) => {
    group(); groupMember("g", "viewer", role);
    const agent = { type: "agent" as const, companyUuid: "c", actorUuid: "agent", ownerUuid: "viewer" };
    expect((await getGroupAccess(agent, "g")).level).toBe(role);
    expect(await getProjectGroup("c", "g", agent)).toMatchObject({ explicitRole: role });
    expect((await listProjectGroups("c", agent)).groups[0]).toMatchObject({ explicitRole: role });
    expect((await getGroupDashboard("c", "g", agent))?.group).toMatchObject({ explicitRole: role });
    expect((await getGroupAccess({ ...agent, ownerUuid: undefined }, "g")).group).toBeNull();
  });
  it("never crosses company boundaries", async () => {
    group(); project();
    expect((await getGroupAccess({ ...auth(), companyUuid: "foreign" }, "g")).group).toBeNull();
    await expect(getProjectGroup("c", "g", { ...auth(), companyUuid: "foreign" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("creator and explicit legacy initialization", () => {
  it.each(["private", "public"] as const)("atomically assigns the %s group creator as Admin", async (visibility) => {
    const response = await createProjectGroup({ companyUuid: "c", name: "new", visibility }, auth());
    expect(response).toMatchObject({ visibility, accessLevel: "admin", accessInitialized: true, projectCount: 0 });
    expect(fixture.state.projectGroupMember).toMatchObject([{ userUuid: "admin", role: "admin", groupUuid: response.uuid }]);
    expect(fixture.state.comment).toHaveLength(1);
    expect(fixture.events.every((e) => !e.inTransaction)).toBe(true);
  });
  it("agent creation records its owner as creator and never creates an agent grant", async () => {
    const response = await createProjectGroup({ companyUuid: "c", name: "new", visibility: "private" }, { type: "agent", actorUuid: "agent", ownerUuid: "admin", companyUuid: "c" });
    expect(fixture.state.projectGroup[0].createdByUuid).toBe("admin");
    expect(fixture.state.projectGroupMember[0]).toMatchObject({ userUuid: "admin", groupUuid: response.uuid });
  });
  it("ownerless agents can create public legacy-style groups but cannot create private or initialize", async () => {
    const agent = { type: "agent" as const, companyUuid: "c", actorUuid: "agent" };
    expect(await createProjectGroup({ companyUuid: "c", name: "public" }, agent)).toMatchObject({ accessInitialized: false });
    await expect(createProjectGroup({ companyUuid: "c", name: "private", visibility: "private" }, agent)).rejects.toMatchObject({ status: 400 });
    group("g", "public", false);
    await expect(updateProjectGroup({ companyUuid: "c", groupUuid: "g", initializeAccess: true }, agent)).rejects.toMatchObject({ status: 400 });
  });
  it("creator membership failure rolls back the group and emits nothing", async () => {
    fixture.failWrite = "projectGroupMember";
    await expect(createProjectGroup({ companyUuid: "c", name: "new" }, auth())).rejects.toThrow("forced");
    expect(fixture.state.projectGroup).toEqual([]); expect(fixture.events).toEqual([]);
  });
  it("initializes only an explicit common Admin, preserving all child configuration", async () => {
    group("g", "public", false); project("p", "g", "public"); project("q"); localMember("p", "admin", "admin"); localMember("q", "admin", "admin");
    const before = state();
    expect(await updateProjectGroup({ companyUuid: "c", groupUuid: "g", initializeAccess: true }, auth())).toMatchObject({ accessInitialized: true, accessLevel: "admin" });
    expect(fixture.state.project).toEqual(before.project); expect(fixture.state.projectMember).toEqual(before.projectMember);
    expect(fixture.locks.map((l) => `${l.table}:${l.uuid}`)).toEqual(["group:g", "project:p", "project:q"]);
    expect(fixture.events.filter((e) => e.type === "access").map((e) => e.data.projectUuid)).toEqual(["p", "q"]);
  });
  it.each(["private", "public"])("rejects initialization without explicit Admin on a %s child", async (visibility) => {
    group("g", "public", false); project("p", "g", visibility); localMember("p", "local", "editor");
    const before = state();
    await expect(updateProjectGroup({ companyUuid: "c", groupUuid: "g", initializeAccess: true, name: "bad" }, auth("local"))).rejects.toMatchObject({ status: 403 });
    expect(state()).toEqual(before); expect(fixture.writes).toEqual([]); expect(fixture.events).toEqual([]);
  });
  it("rejects duplicate initialization and allows ordinary public metadata edits", async () => {
    group("g", "public");
    await expect(updateProjectGroup({ companyUuid: "c", groupUuid: "g", initializeAccess: true }, auth())).rejects.toMatchObject({ status: 409 });
    expect(await updateProjectGroup({ companyUuid: "c", groupUuid: "g", name: "renamed", description: "details" }, auth("outside"))).toMatchObject({ name: "renamed", description: "details" });
  });
});

describe("group member mutations and revocation", () => {
  it("locks and rechecks Admin, bumps freshness and publishes each child only after commit", async () => {
    group(); project(); project("q");
    await addGroupMember(auth(), "g", "editor", "editor");
    expect((await computeProjectAccess(auth("editor"), "p")).level).toBe("editor");
    expect(fixture.state.projectGroup[0].accessVersion).toBe(2);
    expect(fixture.events.filter((e) => e.type === "access").map((e) => e.data)).toEqual([{ companyUuid: "c", projectUuid: "p", userUuids: ["editor"] }, { companyUuid: "c", projectUuid: "q", userUuids: ["editor"] }]);
    expect(fixture.events.every((e) => !e.inTransaction)).toBe(true);
    expect(await listGroupMembers(auth("editor"), "g")).toEqual(expect.arrayContaining([expect.objectContaining({ userUuid: "editor", role: "editor", name: "editor" })]));
    await updateGroupMember(auth(), "g", "editor", "viewer");
    expect((await computeProjectAccess(auth("editor"), "p")).level).toBe("viewer");
  });
  it("revocation retains independent local roles and public baseline is never inherited", async () => {
    group("g", "public"); project(); project("q"); groupMember("g", "editor", "editor"); localMember("p", "editor", "viewer");
    await removeGroupMember(auth(), "g", "editor");
    expect((await computeProjectAccess(auth("editor"), "p")).level).toBe("viewer");
    expect((await computeProjectAccess(auth("editor"), "q")).level).toBe("none");
  });
  it.each(["viewer", "editor", null])("protects the final Admin against role %s", async (role) => {
    group(); project(); const before = state();
    await expect(role ? updateGroupMember(auth(), "g", "admin", role as "viewer" | "editor") : removeGroupMember(auth(), "g", "admin")).rejects.toMatchObject({ status: 400 });
    expect(state()).toEqual(before); expect(fixture.writes).toEqual([]); expect(fixture.events).toEqual([]);
  });
  it("permits removing one of two Admins but rejects removing the remaining Admin", async () => {
    group(); groupMember("g", "local", "admin");
    await removeGroupMember(auth(), "g", "admin");
    await expect(removeGroupMember(auth("local"), "g", "local")).rejects.toMatchObject({ status: 400 });
    expect(fixture.state.projectGroupMember.map((m) => m.userUuid)).toEqual(["local"]);
  });
  it("rechecks lost Admin authority after acquiring the lock", async () => {
    group(); groupMember("g", "local", "admin");
    fixture.onLock = () => { fixture.state.projectGroupMember.find((m) => m.userUuid === "admin")!.role = "viewer"; };
    await expect(addGroupMember(auth(), "g", "editor", "editor")).rejects.toMatchObject({ status: 403 });
    expect(fixture.writes).toEqual([]); expect(fixture.events).toEqual([]);
  });
  it("rejects foreign users, duplicate adds and missing local membership rows", async () => {
    group(); fixture.state.user.push({ uuid: "foreign", companyUuid: "other" });
    await expect(addGroupMember(auth(), "g", "foreign", "viewer")).rejects.toMatchObject({ status: 404 });
    await expect(addGroupMember(auth(), "g", "admin", "viewer")).rejects.toMatchObject({ status: 409 });
    await expect(updateGroupMember(auth(), "g", "editor", "viewer")).rejects.toMatchObject({ status: 404 });
    await expect(removeGroupMember(auth(), "g", "editor")).rejects.toMatchObject({ status: 404 });
    expect(fixture.writes).toEqual([]);
  });
});

describe("preview-bound group conversion", () => {
  it("privatizes all public children atomically and retains direct and inherited grants", async () => {
    group("g", "public"); project("p", "g", "public"); project("q"); groupMember("g", "viewer", "viewer"); localMember("q", "local", "editor");
    const members = state();
    const preview = await getGroupVisibilityPreview(auth(), "g", "private");
    expect(preview).toMatchObject({ companyAccess: "closed", projects: [{ projectUuid: "p", companyAccess: "closed" }, { projectUuid: "q", companyAccess: "unchanged" }] });
    expect(preview.projects[0].changes).toContainEqual({ userUuid: "outside", beforeRole: "editor", afterRole: "none" });
    await updateProjectGroup({ companyUuid: "c", groupUuid: "g", visibility: "private", confirmationToken: preview.confirmationToken }, auth());
    expect(fixture.state.project.map((p) => p.visibility)).toEqual(["private", "private"]);
    expect(fixture.state.projectMember).toEqual(members.projectMember); expect(fixture.state.projectGroupMember).toEqual(members.projectGroupMember);
    expect(fixture.locks.map((l) => `${l.table}:${l.uuid}`)).toEqual(["group:g", "project:p", "project:q"]);
  });
  it("publishing the group keeps every child private and both membership layers unchanged", async () => {
    group(); project(); groupMember("g", "viewer", "viewer"); localMember("p", "local", "admin"); const before = state();
    await convert("public");
    expect(fixture.state.project).toEqual(before.project); expect(fixture.state.projectMember).toEqual(before.projectMember); expect(fixture.state.projectGroupMember).toEqual(before.projectGroupMember);
    expect((await computeProjectAccess(auth("outside"), "p")).level).toBe("none");
  });
  it.each([undefined, "bad", "0".repeat(64)])("rejects confirmation %s with zero settings/audit/access writes", async (confirmationToken) => {
    group("g", "public"); project("p", "g", "public"); const before = state();
    await expect(updateProjectGroup({ companyUuid: "c", groupUuid: "g", visibility: "private", name: "bad", confirmationToken }, auth())).rejects.toMatchObject({ status: 409 });
    expect(state()).toEqual(before); expect(fixture.writes).toEqual([]); expect(fixture.events).toEqual([]);
  });
  it.each(["direct", "group", "version", "child", "actor"])("rejects a preview stale due to %s", async (source) => {
    group("g", "public"); project("p", "g", "public"); groupMember("g", "local", "admin");
    const token = (await getGroupVisibilityPreview(auth(), "g", "private")).confirmationToken;
    if (source === "direct") localMember("p", "outside", "viewer");
    if (source === "group") groupMember("g", "outside", "viewer");
    if (source === "version") fixture.state.projectGroup[0].accessVersion++;
    if (source === "child") project("q", "g", "public");
    const before = state();
    await expect(updateProjectGroup({ companyUuid: "c", groupUuid: "g", visibility: "private", name: "bad", confirmationToken: token }, auth(source === "actor" ? "local" : "admin"))).rejects.toMatchObject({ status: 409 });
    expect(state()).toEqual(before); expect(fixture.writes).toEqual([]);
  });
  it.each([true, false])("competing conversion cannot bypass %s-token validation to apply a name", async (supplied) => {
    group("g", "public"); project("p", "g", "public");
    const token = (await getGroupVisibilityPreview(auth(), "g", "private")).confirmationToken;
    fixture.onLock = () => { fixture.state.projectGroup[0].visibility = "private"; fixture.state.projectGroup[0].accessVersion++; fixture.state.project[0].visibility = "private"; };
    await expect(updateProjectGroup({ companyUuid: "c", groupUuid: "g", visibility: "private", name: "unconfirmed", ...(supplied ? { confirmationToken: token } : {}) }, auth())).rejects.toMatchObject({ status: 409 });
    expect(fixture.state.projectGroup[0]).toMatchObject({ visibility: "private", name: "g" }); expect(fixture.writes).toEqual([]); expect(fixture.events).toEqual([]);
  });
  it("a failing conversion rolls back children, settings, visibility and audit", async () => {
    group("g", "public"); project("p", "g", "public"); const before = state(); fixture.failWrite = "activity";
    await expect(convert("private", { name: "new" })).rejects.toThrow("forced");
    expect(state()).toEqual(before); expect(fixture.events).toEqual([]);
  });
});

describe("protected moves and retained grants", () => {
  it("ordinary public editing can move when no effective role expands", async () => {
    group("z", "public", false); group("a", "public", false); project("p", "z", "public");
    const preview = await getProjectGroupMovePreview(auth("outside"), "p", "a");
    expect(preview.requiresConfirmation).toBe(false);
    await moveProjectToGroup("c", "p", "a", auth("outside"));
    expect(fixture.state.project[0].groupUuid).toBe("a");
    expect(fixture.locks.map((l) => `${l.table}:${l.uuid}`)).toEqual(["group:a", "group:z", "project:p"]);
  });
  it("public role expansion requires source-project Admin and its fresh confirmation", async () => {
    group("source", "public", false); group("target", "public"); project("p", "source", "public");
    await expect(getProjectGroupMovePreview(auth("outside"), "p", "target")).rejects.toMatchObject({ status: 403 });
    await expect(moveProjectToGroup("c", "p", "target", auth("outside"), "0".repeat(64))).rejects.toMatchObject({ status: 403 });
    localMember("p", "local", "admin");
    const preview = await getProjectGroupMovePreview(auth("local"), "p", "target");
    expect(preview.changes).toContainEqual({ userUuid: "admin", beforeRole: "editor", afterRole: "admin" });
    await expect(moveProjectToGroup("c", "p", "target", auth("local"))).rejects.toMatchObject({ status: 409 });
    expect(fixture.writes).toEqual([]);
    await moveProjectToGroup("c", "p", "target", auth("local"), preview.confirmationToken);
    expect((await computeProjectAccess(auth(), "p")).level).toBe("admin");
  });
  it("local project Admin without source group Admin cannot cross a private boundary", async () => {
    group(); group("target"); project(); localMember("p", "local", "admin"); groupMember("target", "local", "admin");
    await expect(moveProjectToGroup("c", "p", "target", auth("local"))).rejects.toMatchObject({ status: 403 });
    expect(fixture.writes).toEqual([]);
  });
  it("source Admin also needs target Admin even for a public target", async () => {
    group(); group("target", "public", false); project();
    await expect(getProjectGroupMovePreview(auth(), "p", "target")).rejects.toMatchObject({ status: 403 });
  });
  it("moving a public project into private group is confirmed and atomically privatized", async () => {
    group("source", "public"); group("target"); project("p", "source", "public"); localMember("p", "local", "viewer");
    const before = state(); const preview = await getProjectGroupMovePreview(auth(), "p", "target");
    await expect(moveProjectToGroup("c", "p", "target", auth())).rejects.toMatchObject({ status: 409 });
    expect(state()).toEqual(before);
    await moveProjectToGroup("c", "p", "target", auth(), preview.confirmationToken);
    expect(fixture.state.project[0]).toMatchObject({ groupUuid: "target", visibility: "private" }); expect(fixture.state.projectMember).toEqual(before.projectMember);
  });
  it("detaches by saving all max explicit roles including inherited-only Admin", async () => {
    group(); project(); groupMember("g", "editor", "editor"); groupMember("g", "viewer", "viewer"); localMember("p", "editor", "viewer"); localMember("p", "viewer", "admin");
    const preview = await getProjectGroupMovePreview(auth(), "p", null);
    expect(preview.changes).toEqual([]);
    await moveProjectToGroup("c", "p", null, auth(), preview.confirmationToken);
    expect(fixture.state.projectMember).toEqual(expect.arrayContaining([expect.objectContaining({ userUuid: "admin", role: "admin" }), expect.objectContaining({ userUuid: "editor", role: "editor" }), expect.objectContaining({ userUuid: "viewer", role: "admin" })]));
    expect(fixture.state.projectMember).toHaveLength(3);
    expect(fixture.state.project[0]).toMatchObject({ groupUuid: null, visibility: "private" });
  });
  it("retains inherited project administration when detaching public projects", async () => {
    group("g", "public"); project("p", "g", "public");
    await moveProjectToGroup("c", "p", null, auth());
    expect(fixture.state.projectMember).toMatchObject([{ userUuid: "admin", role: "admin" }]);
  });
  it("moving an ungrouped private project requires project Admin and target Admin", async () => {
    group(); project("p", null); localMember("p", "local", "admin");
    await expect(getProjectGroupMovePreview(auth("local"), "p", "g")).rejects.toMatchObject({ status: 404 });
    groupMember("g", "local", "admin");
    const preview = await getProjectGroupMovePreview(auth("local"), "p", "g");
    await moveProjectToGroup("c", "p", "g", auth("local"), preview.confirmationToken);
    expect(fixture.state.project[0].groupUuid).toBe("g");
  });
  it("rejects a stale move token and the same token after a competing move commits", async () => {
    group(); group("target"); project();
    const preview = await getProjectGroupMovePreview(auth(), "p", "target");
    fixture.onLock = () => { fixture.state.project[0].groupUuid = "target"; };
    await expect(moveProjectToGroup("c", "p", "target", auth(), preview.confirmationToken)).rejects.toMatchObject({ status: 409 });
    expect(fixture.writes).toEqual([]);
    await expect(moveProjectToGroup("c", "p", "target", auth(), preview.confirmationToken)).rejects.toMatchObject({ status: 409 });
    expect(fixture.writes).toEqual([]);
  });
  it("cannot use a token for a different target or altered direct grants", async () => {
    group(); group("target"); group("other"); project();
    const token = (await getProjectGroupMovePreview(auth(), "p", "target")).confirmationToken;
    await expect(moveProjectToGroup("c", "p", "other", auth(), token)).rejects.toMatchObject({ status: 409 });
    localMember("p", "outside", "viewer");
    await expect(moveProjectToGroup("c", "p", "target", auth(), token)).rejects.toMatchObject({ status: 409 });
    expect(fixture.writes).toEqual([]);
  });
  it.each([false, true])("group delete requires explicit group Admin (deleteProjects=%s)", async (deleteProjects) => {
    group("g", "public"); project("p", "g", "public"); localMember("p", "local", "admin");
    await expect(deleteProjectGroup("c", "g", deleteProjects, auth("local"))).rejects.toMatchObject({ status: 403 }); expect(fixture.writes).toEqual([]);
  });
  it("deleting a public group retains full private effective grants without making projects public", async () => {
    group("g", "public"); project(); groupMember("g", "editor", "editor"); localMember("p", "editor", "viewer");
    expect(await deleteProjectGroup("c", "g", false, auth())).toBe(true);
    expect(fixture.state.project[0]).toMatchObject({ groupUuid: null, visibility: "private" });
    expect(fixture.state.projectMember).toEqual(expect.arrayContaining([expect.objectContaining({ userUuid: "admin", role: "admin" }), expect.objectContaining({ userUuid: "editor", role: "editor" })]));
    expect(fixture.state.projectGroup).toEqual([]); expect(fixture.events.every((e) => !e.inTransaction)).toBe(true);
  });
  it("deleteProjects explicitly removes children before deleting the group", async () => {
    group(); project(); await deleteProjectGroup("c", "g", true, auth());
    expect(fixture.state.project).toEqual([]); expect(fixture.state.projectGroup).toEqual([]);
    expect(fixture.writes.filter((w) => w.data.delete).map((w) => w.table)).toEqual(["project", "projectGroup"]);
  });
});

describe("shared locked project creation paths", () => {
  const paths = ["service", "cwd"] as const;
  const create = (path: typeof paths[number], actor = "editor", visibility?: "public" | "private") => path === "service"
    ? createProject({ companyUuid: "c", name: "new", groupUuid: "g", createdByUuid: actor, visibility, auth: auth(actor) })
    : createProjectWithAgentCwds({ companyUuid: "c", userUuid: actor, name: "new", description: null, groupUuid: "g", agentCwds: [], createdByUuid: actor, visibility, auth: auth(actor) });
  it.each(paths)("%s defaults to private, locks before insert and gives only local creator Admin", async (path) => {
    group(); groupMember("g", "editor", "editor"); await create(path);
    expect(fixture.state.project[0]).toMatchObject({ visibility: "private", groupUuid: "g" });
    expect(fixture.state.projectMember).toMatchObject([{ userUuid: "editor", role: "admin" }]);
    expect(fixture.state.projectGroupMember.find((m) => m.userUuid === "editor")?.role).toBe("editor");
    expect(fixture.locks).toMatchObject([{ table: "group", uuid: "g", companyUuid: "c" }]);
  });
  it.each(paths)("%s rejects public child and project-only creator with zero inserts", async (path) => {
    group(); groupMember("g", "editor", "editor");
    await expect(create(path, "editor", "public")).rejects.toMatchObject({ status: 400 });
    project(); localMember("p", "local", "admin");
    await expect(create(path, "local")).rejects.toMatchObject({ status: 403 });
    expect(fixture.writes).toEqual([]);
  });
  it.each(paths)("%s rechecks group visibility and membership after acquiring its lock", async (path) => {
    group("g", "public"); groupMember("g", "editor", "editor");
    fixture.onLock = () => { fixture.state.projectGroup[0].visibility = "private"; fixture.state.projectGroupMember.find((m) => m.userUuid === "editor")!.role = "viewer"; };
    await expect(create(path)).rejects.toMatchObject({ status: 403 }); expect(fixture.writes).toEqual([]);
  });
});

describe("project lifecycle rechecks under group and project locks", () => {
  const paths = ["settings", "delete", "cwd-settings"] as const;
  const mutate = (path: typeof paths[number], actor = "admin") => path === "settings"
    ? updateProject("c", "p", { name: "updated" }, auth(actor))
    : path === "delete" ? deleteProject("c", "p", auth(actor))
      : updateProjectWithAgentCwds({ companyUuid: "c", userUuid: actor, projectUuid: "p", name: "updated", agentCwds: { upserts: [], clears: [] }, auth: auth(actor) });
  it.each(paths)("%s cannot use inherited Admin demoted before lock acquisition", async (path) => {
    group(); project(); groupMember("g", "local", "admin");
    expect((await computeProjectAccess(auth(), "p")).level).toBe("admin");
    fixture.onLock = () => { fixture.state.projectGroupMember.find((m) => m.userUuid === "admin")!.role = "viewer"; };
    await expect(mutate(path)).rejects.toMatchObject({ status: 403 });
    expect(fixture.state.project[0].name).toBe("p"); expect(fixture.writes).toEqual([]); expect(fixture.events).toEqual([]);
    expect(fixture.locks.map((l) => `${l.table}:${l.uuid}`)).toEqual(["group:g", "project:p"]);
  });
  it.each(paths)("%s returns 404 after inherited access is revoked and retains the competing revocation", async (path) => {
    group(); project(); groupMember("g", "local", "admin");
    fixture.onLock = () => { fixture.state.projectGroupMember = fixture.state.projectGroupMember.filter((m) => m.userUuid !== "admin"); };
    await expect(mutate(path)).rejects.toMatchObject({ status: 404 });
    expect(fixture.state.projectGroupMember.map((m) => m.userUuid)).toEqual(["local"]);
    expect(fixture.writes).toEqual([]); expect(fixture.events).toEqual([]);
  });
  it.each(paths)("%s detects a competing move before writing against an unlocked group", async (path) => {
    group(); group("target"); project();
    fixture.onLock = () => { fixture.state.project[0].groupUuid = "target"; };
    await expect(mutate(path)).rejects.toMatchObject({ status: 409 });
    expect(fixture.state.project[0]).toMatchObject({ groupUuid: "target", name: "p" });
    expect(fixture.writes).toEqual([]); expect(fixture.events).toEqual([]);
  });
  it.each(paths)("%s keeps ordinary public management available", async (path) => {
    group("g", "public"); project("p", "g", "public");
    await mutate(path, "outside");
    expect(fixture.locks.map((l) => `${l.table}:${l.uuid}`)).toEqual(["group:g", "project:p"]);
    if (path === "delete") {
      expect(fixture.state.project).toEqual([]);
      expect(fixture.state.projectGroup[0].accessVersion).toBe(2);
      expect(fixture.events.every((e) => !e.inTransaction)).toBe(true);
    } else expect(fixture.state.project[0].name).toBe("updated");
  });
  it.each(paths)("%s rechecks ungrouped local Admin changes under the project lock", async (path) => {
    project("p", null); localMember("p", "admin", "admin");
    fixture.onLock = () => { fixture.state.projectMember[0].role = "editor"; };
    await expect(mutate(path)).rejects.toMatchObject({ status: 403 });
    expect(fixture.locks.map((l) => `${l.table}:${l.uuid}`)).toEqual(["project:p"]);
    expect(fixture.writes).toEqual([]);
  });
});
