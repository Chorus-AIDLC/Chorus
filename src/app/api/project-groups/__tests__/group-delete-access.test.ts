import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fixture, auth, group, groupMember, project, localMember } from "@/services/__tests__/project-group.fixture";

const requestAuth = vi.hoisted(() => ({ actor: null as any, permission: true }));
vi.mock("@/lib/prisma", async () => ({ prisma: (await import("@/services/__tests__/project-group.fixture")).fixture.prisma }));
vi.mock("@/lib/event-bus", async () => ({ eventBus: (await import("@/services/__tests__/project-group.fixture")).events }));
vi.mock("@/lib/auth", async () => {
  const { errors } = await import("@/lib/api-response");
  return {
  getAuthContext: async () => requestAuth.actor,
  isUser: (a: any) => a.type === "user", isAgent: (a: any) => a.type === "agent",
  hasPermission: () => requestAuth.permission,
  checkAgentPermission: () => requestAuth.permission ? null : errors.forbidden("Missing permission"),
  };
});
vi.mock("@/services/activity.service", () => ({ createActivityInTx: vi.fn(async () => ({ activity: { uuid: "act" }, publish: vi.fn() })) }));
import { DELETE, PATCH, GET } from "@/app/api/project-groups/[uuid]/route";
import { POST as createGroup, GET as listGroups } from "@/app/api/project-groups/route";
import { GET as groupPreview } from "@/app/api/project-groups/[uuid]/access-preview/route";
import { GET as getMembers, POST as addMember } from "@/app/api/project-groups/[uuid]/members/route";
import { PATCH as updateMember, DELETE as removeMember } from "@/app/api/project-groups/[uuid]/members/[userUuid]/route";
import { GET as dashboard } from "@/app/api/project-groups/[uuid]/dashboard/route";
import { PATCH as move } from "@/app/api/projects/[uuid]/group/route";
import { GET as movePreview } from "@/app/api/projects/[uuid]/group/preview/route";
import { POST as createProject } from "@/app/api/projects/route";

type Handler = (request: NextRequest, context: any) => Promise<Response>;
function invoke(handler: Handler, method = "GET", body?: unknown, query = "", uuid = "g", userUuid = "editor") {
  return handler(new NextRequest(`http://localhost/api/project-groups/${uuid}${query}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) }), { params: Promise.resolve({ uuid, userUuid }) });
}
async function data(response: Response) { return (await response.json()).data; }
beforeEach(() => { vi.clearAllMocks(); fixture.reset(); requestAuth.actor = auth(); requestAuth.permission = true; });

describe("real group REST handlers with locked services", () => {
  it.each([false, true])("group delete requires explicit group Admin even for project-only Admin (deleteProjects=%s)", async (deleteProjects) => {
    group(); project(); localMember("p", "local", "admin"); requestAuth.actor = auth("local");
    const response = await invoke(DELETE, "DELETE", undefined, deleteProjects ? "?deleteProjects=true" : "");
    expect(response.status).toBe(403); expect(fixture.writes).toEqual([]); expect(fixture.events).toEqual([]);
  });
  it.each([false, true])("group Admin can delete or retain children (deleteProjects=%s)", async (deleteProjects) => {
    group(); project();
    expect((await invoke(DELETE, "DELETE", undefined, deleteProjects ? "?deleteProjects=true" : "")).status).toBe(200);
    if (deleteProjects) expect(fixture.state.project).toEqual([]);
    else { expect(fixture.state.project[0]).toMatchObject({ groupUuid: null, visibility: "private" }); expect(fixture.state.projectMember[0]).toMatchObject({ userUuid: "admin", role: "admin" }); }
  });
  it.each([GET, dashboard, getMembers, groupPreview, DELETE])("hidden group handler returns 404", async (handler) => {
    group(); project(); requestAuth.actor = auth("outside");
    expect((await invoke(handler, handler === DELETE ? "DELETE" : "GET", undefined, "?visibility=public")).status).toBe(404);
    expect(fixture.writes).toEqual([]);
  });
  it("project-only discovery provides filtered presentation but no roster or mutation", async () => {
    group(); project(); project("q"); localMember("p", "local", "viewer"); requestAuth.actor = auth("local");
    expect(await data(await invoke(GET))).toMatchObject({ accessLevel: "viewer", canManage: false, canCreateProject: false, projectCount: 1 });
    expect((await data(await invoke(listGroups))).groups[0].projectCount).toBe(1);
    expect((await invoke(getMembers)).status).toBe(403);
    expect((await invoke(PATCH, "PATCH", { name: "bad" })).status).toBe(403);
    expect(fixture.writes).toEqual([]);
  });
  it("REST group creation makes the owner Admin and accepts private visibility", async () => {
    requestAuth.actor = { type: "agent", actorUuid: "agent", ownerUuid: "admin", companyUuid: "c" };
    expect(await data(await invoke(createGroup, "POST", { name: " new ", visibility: "private" }))).toMatchObject({ name: "new", visibility: "private", accessLevel: "admin", accessInitialized: true });
    expect(fixture.state.projectGroupMember[0].userUuid).toBe("admin");
  });
  it("REST initializes legacy access explicitly and preserves children", async () => {
    group("g", "public", false); project(); localMember("p", "admin", "admin");
    expect(await data(await invoke(PATCH, "PATCH", { initializeAccess: true }))).toMatchObject({ accessInitialized: true });
    expect(fixture.state.project[0].visibility).toBe("private");
  });
  it("REST preview/confirmation gates both conversions and accompanying settings", async () => {
    group("g", "public"); project("p", "g", "public");
    const preview = await data(await invoke(groupPreview, "GET", undefined, "?visibility=private"));
    expect((await invoke(PATCH, "PATCH", { visibility: "private", name: "bad" })).status).toBe(409);
    expect(fixture.writes).toEqual([]);
    expect((await invoke(PATCH, "PATCH", { visibility: "private", confirmationToken: preview.confirmationToken })).status).toBe(200);
    expect(fixture.state.project[0].visibility).toBe("private");
    const publication = await data(await invoke(groupPreview, "GET", undefined, "?visibility=public"));
    expect((await invoke(PATCH, "PATCH", { visibility: "public", confirmationToken: publication.confirmationToken })).status).toBe(200);
    expect(fixture.state.project[0].visibility).toBe("private");
  });
  it.each([true, false])("REST competing conversion rejects stale/missing confirmation before name (supplied=%s)", async (supplied) => {
    group("g", "public"); project("p", "g", "public");
    const preview = await data(await invoke(groupPreview, "GET", undefined, "?visibility=private"));
    fixture.onLock = () => { fixture.state.projectGroup[0].visibility = "private"; fixture.state.projectGroup[0].accessVersion++; fixture.state.project[0].visibility = "private"; };
    expect((await invoke(PATCH, "PATCH", { visibility: "private", name: "bad", ...(supplied ? { confirmationToken: preview.confirmationToken } : {}) })).status).toBe(409);
    expect(fixture.state.projectGroup[0].name).toBe("g"); expect(fixture.writes).toEqual([]); expect(fixture.events).toEqual([]);
  });
  it("member REST is explicit-member readable, Admin writable, same-company validated and last-Admin protected", async () => {
    group(); project();
    expect((await invoke(addMember, "POST", { userUuid: "editor", role: "editor" })).status).toBe(200);
    requestAuth.actor = auth("editor");
    expect(await data(await invoke(getMembers))).toMatchObject({ members: expect.arrayContaining([expect.objectContaining({ userUuid: "editor", role: "editor" })]) });
    expect((await invoke(updateMember, "PATCH", { role: "admin" })).status).toBe(403);
    requestAuth.actor = auth();
    expect((await invoke(updateMember, "PATCH", { role: "viewer" })).status).toBe(200);
    expect((await invoke(removeMember, "DELETE")).status).toBe(200);
    expect((await invoke(removeMember, "DELETE", undefined, "", "g", "admin")).status).toBe(400);
    fixture.state.user.push({ uuid: "foreign", companyUuid: "other" });
    expect((await invoke(addMember, "POST", { userUuid: "foreign", role: "viewer" })).status).toBe(404);
  });
  it("moves preview/confirm atomically privatize and reject reused tokens on the no-op path", async () => {
    group("g", "public"); group("target"); project("p", "g", "public");
    const preview = await data(await invoke(movePreview, "GET", undefined, "?groupUuid=target", "p"));
    expect((await invoke(move, "PATCH", { groupUuid: "target" }, "", "p")).status).toBe(409);
    expect((await invoke(move, "PATCH", { groupUuid: "target", confirmationToken: preview.confirmationToken }, "", "p")).status).toBe(200);
    fixture.writes = []; fixture.events = [];
    expect((await invoke(move, "PATCH", { groupUuid: "target", confirmationToken: preview.confirmationToken }, "", "p")).status).toBe(409);
    expect(fixture.writes).toEqual([]); expect(fixture.events).toEqual([]);
  });
  it("rejects baseline Editor public moves that would expand inherited Admin", async () => {
    group("g", "public", false); group("target", "public"); project("p", "g", "public"); requestAuth.actor = auth("outside");
    expect((await invoke(movePreview, "GET", undefined, "?groupUuid=target", "p")).status).toBe(403);
    expect((await invoke(move, "PATCH", { groupUuid: "target", confirmationToken: "0".repeat(64) }, "", "p")).status).toBe(403);
    expect(fixture.writes).toEqual([]);
  });
  it("REST project creation uses the cwd service guard, private default and local creator Admin", async () => {
    group(); groupMember("g", "editor", "editor"); requestAuth.actor = auth("editor");
    const response = await invoke(createProject, "POST", { name: "child", groupUuid: "g" });
    expect(response.status).toBe(200); expect(await data(response)).toMatchObject({ visibility: "private", groupUuid: "g" });
    expect(fixture.state.projectMember[0]).toMatchObject({ userUuid: "editor", role: "admin" });
    fixture.writes = [];
    expect((await invoke(createProject, "POST", { name: "bad", groupUuid: "g", visibility: "public" })).status).toBe(400);
    expect(fixture.writes).toEqual([]);
  });
  it.each([createGroup, PATCH, DELETE, groupPreview, addMember, updateMember, removeMember, move, movePreview])("rejects unauthenticated and capability-denied agents before service writes", async (handler) => {
    group(); project(); requestAuth.actor = null;
    expect((await invoke(handler, "POST", { name: "new", role: "viewer", userUuid: "viewer", groupUuid: "g" }, "?visibility=public")).status).toBe(401);
    requestAuth.actor = { type: "agent", companyUuid: "c", actorUuid: "agent", ownerUuid: "admin" }; requestAuth.permission = false;
    expect((await invoke(handler, "POST", { name: "new", role: "viewer", userUuid: "viewer", groupUuid: "g" }, "?visibility=public")).status).toBe(403);
    expect(fixture.writes).toEqual([]);
  });
  it("validates visibility, roles, initializeAccess and missing move targets", async () => {
    group(); project();
    expect((await invoke(createGroup, "POST", { name: "new", visibility: "bogus" })).status).toBe(422);
    expect((await invoke(PATCH, "PATCH", { initializeAccess: "yes" })).status).toBe(422);
    expect((await invoke(groupPreview, "GET", undefined, "?visibility=bogus")).status).toBe(422);
    expect((await invoke(addMember, "POST", { userUuid: "viewer", role: "bogus" })).status).toBe(422);
    expect((await invoke(updateMember, "PATCH", { role: "bogus" })).status).toBe(422);
    expect((await invoke(move, "PATCH", {}, "", "p")).status).toBe(422);
    expect(fixture.writes).toEqual([]);
  });
});
