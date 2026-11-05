/**
 * Real PostgreSQL acceptance. Point PROJECT_GROUP_DATABASE_URL only at an
 * isolated, migrated test database. Request authentication and the event
 * transport are substituted; REST, services, queries and MCP are real.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "../../generated/prisma/client";
import type { AgentAuthContext, AuthContext } from "@/types/auth";

const state = vi.hoisted(() => ({ db: null as unknown, auth: null as unknown }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAuthContext: async () => state.auth,
}));
vi.mock("@/lib/auth-server", () => ({ getServerAuthContext: async () => state.auth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
const { bus } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  class TestBus extends EventEmitter {
    emitChange(event: unknown) { this.emit("change", event); }
    emitPresence(event: unknown) { this.emit("presence", event); }
    emitProjectAccessChanged(event: unknown) { this.emit("project_access_changed", event); }
  }
  const bus = new TestBus();
  bus.setMaxListeners(0);
  return { bus };
});
vi.mock("@/lib/event-bus", () => ({
  eventBus: bus, controlEventName: (uuid: string) => `control:${uuid}`,
}));

type Handler<P extends Record<string, string>> =
  (request: NextRequest, context: { params: Promise<P> }) => Promise<Response>;
interface Entity {
  uuid: string;
  name: string;
  visibility?: string;
  groupUuid?: string | null;
  accessLevel?: string;
  canManage?: boolean;
  canCreateProject?: boolean;
  accessInitialized?: boolean;
  projects?: Entity[];
  projectCount?: number;
}
interface Member { userUuid: string; role: string; source?: string; inheritedRole?: string; directRole?: string }
interface Preview { confirmationToken: string; changes?: unknown[]; projects?: unknown[] }
const url = process.env.PROJECT_GROUP_DATABASE_URL;

describe.skipIf(!url)("Project group access — real PostgreSQL acceptance", () => {
  let db: PrismaClient;
  let pool: pg.Pool;
  let routes: {
    groups: typeof import("@/app/api/project-groups/route");
    group: typeof import("@/app/api/project-groups/[uuid]/route");
    dashboard: typeof import("@/app/api/project-groups/[uuid]/dashboard/route");
    groupMembers: typeof import("@/app/api/project-groups/[uuid]/members/route");
    groupMember: typeof import("@/app/api/project-groups/[uuid]/members/[userUuid]/route");
    groupPreview: typeof import("@/app/api/project-groups/[uuid]/access-preview/route");
    projects: typeof import("@/app/api/projects/route");
    project: typeof import("@/app/api/projects/[uuid]/route");
    projectPreview: typeof import("@/app/api/projects/[uuid]/access-preview/route");
    projectMembers: typeof import("@/app/api/projects/[uuid]/members/route");
    projectMember: typeof import("@/app/api/projects/[uuid]/members/[userUuid]/route");
    move: typeof import("@/app/api/projects/[uuid]/group/route");
    movePreview: typeof import("@/app/api/projects/[uuid]/group/preview/route");
    events: typeof import("@/app/api/events/route");
  };
  let access: typeof import("@/services/project-access.service");
  let search: typeof import("@/services/search.service");
  let createMcpServer: typeof import("@/mcp/server").createMcpServer;
  const companyUuid = randomUUID();
  const foreignCompanyUuid = randomUUID();
  const ids = Object.fromEntries(["A", "B", "E", "V", "P", "N", "F"].map((key) => [key, randomUUID()]));
  const agentUuid = randomUUID();
  const token = `group-db-${randomUUID().slice(0, 8)}`;
  let group: Entity;
  let project: Entity;
  let sibling: Entity;

  const actor = (key: string): AuthContext => ({
    type: "user", actorUuid: ids[key], companyUuid: key === "F" ? foreignCompanyUuid : companyUuid,
  });
  const agent = (key: string, permissions?: AgentAuthContext["permissions"]): AgentAuthContext => ({
    type: "agent", actorUuid: agentUuid, companyUuid, ownerUuid: key === "O" ? undefined : ids[key],
    roles: ["admin_agent"], agentName: token,
    permissions: permissions ?? [
      "project:read", "project:write", "project:admin", "idea:read", "idea:write", "idea:admin",
      "task:read", "task:write", "task:admin", "proposal:read", "proposal:write", "proposal:admin",
      "document:read", "document:write", "document:admin",
    ],
  });
  async function invoke<T, P extends Record<string, string>>(
    auth: AuthContext, handler: Handler<P>, path: string, params: P, method = "GET", body?: unknown,
  ): Promise<{ status: number; data: T; error?: { code: string; message: string } }> {
    state.auth = auth;
    const response = await handler(new NextRequest(`http://localhost${path}`, {
      method, ...(body === undefined ? {} : {
        body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
      }),
    }), { params: Promise.resolve(params) });
    const json = await response.json();
    return { status: response.status, data: json.data as T, error: json.error };
  }
  const getGroup = (key: string, uuid = group.uuid) =>
    invoke<Entity, { uuid: string }>(actor(key), routes.group.GET, `/api/project-groups/${uuid}`, { uuid });
  const getProject = (key: string, uuid = project.uuid) =>
    invoke<Entity, { uuid: string }>(actor(key), routes.project.GET, `/api/projects/${uuid}`, { uuid });
  async function createGroup(key: string, visibility = "private"): Promise<Entity> {
    const result = await invoke<Entity, Record<string, string>>(
      actor(key), routes.groups.POST, "/api/project-groups", {}, "POST", { name: token, visibility },
    );
    expect(result.status).toBe(200);
    return result.data;
  }
  async function createProject(key: string, groupUuid?: string, visibility?: string): Promise<Entity> {
    const result = await invoke<Entity, Record<string, string>>(
      actor(key), routes.projects.POST, "/api/projects", {}, "POST", {
        name: token, ...(groupUuid && { groupUuid }), ...(visibility && { visibility }),
      },
    );
    expect(result.status).toBe(200);
    const persisted = await db.project.findUniqueOrThrow({ where: { uuid: result.data.uuid } });
    return { ...result.data, visibility: persisted.visibility, groupUuid: persisted.groupUuid };
  }
  async function grantGroup(key: string, groupUuid: string, userKey: string, role: string) {
    return invoke<Member, { uuid: string }>(actor(key), routes.groupMembers.POST,
      `/api/project-groups/${groupUuid}/members`, { uuid: groupUuid }, "POST", { userUuid: ids[userKey], role });
  }
  async function groupPreview(key: string, uuid: string, visibility: string) {
    const result = await invoke<Preview, { uuid: string }>(actor(key), routes.groupPreview.GET,
      `/api/project-groups/${uuid}/access-preview?visibility=${visibility}`, { uuid });
    expect(result.status).toBe(200);
    expect(result.data.confirmationToken).toMatch(/^[a-f0-9]{64}$/);
    return result.data;
  }
  async function movePreview(key: string, uuid: string, target: string | null) {
    const result = await invoke<Preview, { uuid: string }>(actor(key), routes.movePreview.GET,
      `/api/projects/${uuid}/group/preview?groupUuid=${target ?? ""}`, { uuid });
    expect(result.status).toBe(200);
    return result.data;
  }
  async function moveProject(key: string, uuid: string, groupUuid: string | null, confirmationToken?: string) {
    return invoke<Entity, { uuid: string }>(actor(key), routes.move.PATCH, `/api/projects/${uuid}/group`,
      { uuid }, "PATCH", { groupUuid, confirmationToken });
  }
  async function mcp(auth: AgentAuthContext, name: string, args: Record<string, unknown>) {
    const server = createMcpServer(auth);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: token, version: "1" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name, arguments: args });
      return {
        isError: result.isError === true,
        text: (result.content as { type: string; text: string }[])[0]?.text ?? "",
      };
    } finally { await client.close(); await server.close(); }
  }
  async function openStream(key: string) {
    state.auth = actor(key);
    const abort = new AbortController();
    const response = await routes.events.GET(new NextRequest("http://localhost/api/events", {
      signal: abort.signal,
    }));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const events: string[] = [];
    const decoder = new TextDecoder();
    const pump = (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          events.push(decoder.decode(chunk.value));
        }
      } catch { /* Closing the acceptance stream also ends the pump. */ }
    })();
    return { events, async close() { abort.abort(); await reader.cancel(); await pump; } };
  }
  async function eventually(predicate: () => boolean) {
    const end = Date.now() + 3000;
    while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(predicate()).toBe(true);
  }
  async function waitForGroupLock() {
    const deadline = Date.now() + 3000;
    let blocked = false;
    do {
      const result = await pool.query<{ waiting: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%ProjectGroup%' AND pid <> pg_backend_pid()) AS waiting`,
      );
      blocked = result.rows[0].waiting;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
    } while (!blocked && Date.now() < deadline);
    expect(blocked).toBe(true);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 8 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    access = await import("@/services/project-access.service");
    search = await import("@/services/search.service");
    ({ createMcpServer } = await import("@/mcp/server"));
    routes = {
      groups: await import("@/app/api/project-groups/route"),
      group: await import("@/app/api/project-groups/[uuid]/route"),
      dashboard: await import("@/app/api/project-groups/[uuid]/dashboard/route"),
      groupMembers: await import("@/app/api/project-groups/[uuid]/members/route"),
      groupMember: await import("@/app/api/project-groups/[uuid]/members/[userUuid]/route"),
      groupPreview: await import("@/app/api/project-groups/[uuid]/access-preview/route"),
      projects: await import("@/app/api/projects/route"),
      project: await import("@/app/api/projects/[uuid]/route"),
      projectPreview: await import("@/app/api/projects/[uuid]/access-preview/route"),
      projectMembers: await import("@/app/api/projects/[uuid]/members/route"),
      projectMember: await import("@/app/api/projects/[uuid]/members/[userUuid]/route"),
      move: await import("@/app/api/projects/[uuid]/group/route"),
      movePreview: await import("@/app/api/projects/[uuid]/group/preview/route"),
      events: await import("@/app/api/events/route"),
    };
    for (const uuid of [companyUuid, foreignCompanyUuid]) {
      await db.company.create({ data: { uuid, name: token } });
    }
    for (const [key, uuid] of Object.entries(ids)) {
      await db.user.create({ data: {
        uuid, companyUuid: key === "F" ? foreignCompanyUuid : companyUuid,
        oidcSub: uuid, name: key, email: `${key}-${token}@example.test`,
      } });
    }
    await db.agent.create({ data: { uuid: agentUuid, companyUuid, name: token, ownerUuid: ids.E } });
    group = await createGroup("A");
    for (const [key, role] of [["B", "admin"], ["E", "editor"], ["V", "viewer"]]) {
      expect((await grantGroup("A", group.uuid, key, role)).status).toBe(200);
    }
    project = await createProject("A", group.uuid);
    sibling = await createProject("A", group.uuid);
    for (const key of ["P", "E"]) {
      expect((await invoke<Member, { uuid: string }>(actor("A"), routes.projectMembers.POST,
        `/api/projects/${project.uuid}/members`, { uuid: project.uuid }, "POST",
        { userUuid: ids[key], role: "viewer" })).status).toBe(200);
    }
  }, 60_000);

  afterAll(async () => {
    bus.removeAllListeners();
    if (!db) return;
    for (const uuid of [companyUuid, foreignCompanyUuid]) {
      const tenant = { companyUuid: uuid };
      await db.activity.deleteMany({ where: tenant });
      await db.comment.deleteMany({ where: tenant });
      await db.projectVisit.deleteMany({ where: tenant });
      await db.projectMember.deleteMany({ where: tenant });
      await db.projectAgentCwdPreference.deleteMany({ where: tenant });
      await db.project.deleteMany({ where: tenant });
      await db.projectGroupMember.deleteMany({ where: tenant });
      await db.projectGroup.deleteMany({ where: tenant });
      await db.agent.deleteMany({ where: tenant });
      await db.user.deleteMany({ where: tenant });
      await db.company.deleteMany({ where: { uuid } });
    }
    await db.$disconnect();
    await pool.end();
  }, 60_000);

  it("creates one explicit group Admin and defaults private children without copying inherited grants", async () => {
    expect(group).toMatchObject({ visibility: "private", canManage: true, accessInitialized: true });
    expect(project.visibility).toBe("private");
    expect(await db.projectGroupMember.findMany({ where: { groupUuid: group.uuid, userUuid: ids.A } }))
      .toEqual([expect.objectContaining({ role: "admin" })]);
    expect(await db.projectMember.count({ where: { projectUuid: project.uuid, userUuid: ids.B } })).toBe(0);
    expect((await getProject("B")).data.accessLevel).toBe("admin");
    const denied = await invoke<Entity, Record<string, string>>(actor("A"), routes.projects.POST,
      "/api/projects", {}, "POST", { name: token, groupUuid: group.uuid, visibility: "public" });
    expect(denied.status).toBe(400);
    expect(await db.project.count({ where: { groupUuid: group.uuid, visibility: "public" } })).toBe(0);
  });

  it("resolves live explicit roles and keeps project-only discovery separate from group authority", async () => {
    expect((await getProject("E")).data.accessLevel).toBe("editor");
    expect((await getProject("V")).data.accessLevel).toBe("viewer");
    expect((await getProject("N")).status).toBe(404);
    expect((await getGroup("F")).status).toBe(404);
    expect((await getGroup("N")).status).toBe(404);
    const basic = await getGroup("P");
    expect(basic.data).toMatchObject({ accessLevel: "viewer", canManage: false, canCreateProject: false, projectCount: 1 });
    expect(basic.data.projects?.map((p) => p.uuid)).toEqual([project.uuid]);
    expect((await getProject("P", sibling.uuid)).status).toBe(404);
    expect((await invoke<unknown, { uuid: string }>(actor("P"), routes.groupMembers.GET,
      `/api/project-groups/${group.uuid}/members`, { uuid: group.uuid })).status).toBe(403);
    const dashboard = await invoke<{ projects: Entity[] }, { uuid: string }>(actor("P"), routes.dashboard.GET,
      `/api/project-groups/${group.uuid}/dashboard`, { uuid: group.uuid });
    expect(dashboard.data.projects.map((p) => p.uuid)).toEqual([project.uuid]);
  });

  it("allows explicit Editor creation without promoting that actor to group Admin", async () => {
    const created = await createProject("E", group.uuid);
    expect((await getProject("E", created.uuid)).data.accessLevel).toBe("admin");
    expect((await db.projectGroupMember.findUniqueOrThrow({
      where: { groupUuid_userUuid: { groupUuid: group.uuid, userUuid: ids.E } },
    })).role).toBe("editor");
    for (const key of ["V", "P"]) {
      expect((await invoke<Entity, Record<string, string>>(actor(key), routes.projects.POST,
        "/api/projects", {}, "POST", { name: token, groupUuid: group.uuid })).status).toBe(403);
    }
    expect((await grantGroup("A", group.uuid, "F", "viewer")).status).toBe(404);
  });

  it("reports both grant sources without allowing a local lower grant to reduce the group floor", async () => {
    expect((await getProject("E")).data.accessLevel).toBe("editor");
    const roster = await invoke<{ members: Member[] }, { uuid: string }>(actor("V"), routes.projectMembers.GET,
      `/api/projects/${project.uuid}/members`, { uuid: project.uuid });
    expect(roster.data.members.find((m) => m.userUuid === ids.E))
      .toMatchObject({ role: "editor", source: "both", inheritedRole: "editor", directRole: "viewer" });
    expect(roster.data.members.find((m) => m.userUuid === ids.B)).toMatchObject({ role: "admin", source: "group" });
    expect((await invoke<unknown, { uuid: string; userUuid: string }>(actor("B"), routes.projectMember.DELETE,
      `/api/projects/${project.uuid}/members/${ids.B}`, { uuid: project.uuid, userUuid: ids.B }, "DELETE")).status).toBe(404);
  });

  it("filters private group exact UUID/text discovery and MCP using the same inherited owner role", async () => {
    expect((await search.search({ companyUuid, query: group.uuid, entityTypes: ["project_group"], auth: actor("N") })).results).toEqual([]);
    expect((await search.search({ companyUuid, query: token, entityTypes: ["project_group"], auth: actor("N") })).results).toEqual([]);
    expect((await search.search({ companyUuid, query: group.uuid, entityTypes: ["project_group"], auth: actor("P") })).results)
      .toEqual([expect.objectContaining({ uuid: group.uuid })]);
    expect((await mcp(agent("E"), "chorus_get_project", { projectUuid: project.uuid })).isError).toBe(false);
    expect((await mcp(agent("O"), "chorus_get_project_group", { groupUuid: group.uuid })).isError).toBe(true);
    expect((await mcp(agent("E", ["task:read"]), "chorus_get_project", { projectUuid: project.uuid })).isError).toBe(true);
    expect((await mcp(agent("P"), "chorus_admin_update_project_group", { groupUuid: group.uuid, name: "Denied" })).isError).toBe(true);
  });

  it("uses real inherited recipients for notifications and requires effective Editor for task assignment", async () => {
    const notifications = await import("@/services/notification.service");
    const tasks = await import("@/services/task.service");
    const recipients = ["E", "V", "P", "N"].map((key) => ({ type: "user", uuid: ids[key] }))
      .concat([{ type: "agent", uuid: agentUuid }]);
    const delivered = await notifications.filterNotificationsByProjectAccess(recipients.map((recipient) => ({
      companyUuid, projectUuid: project.uuid, projectName: project.name,
      recipientType: recipient.type, recipientUuid: recipient.uuid,
      entityType: "project", entityUuid: project.uuid, entityTitle: project.name,
      action: "updated", message: "Private project notification", actorType: "user", actorUuid: ids.A, actorName: "A",
    })));
    expect(delivered.map((n) => n.recipientUuid).sort()).toEqual([ids.E, ids.V, ids.P, agentUuid].sort());
    await expect(tasks.assertAssigneeProjectAccess(companyUuid, { type: "user", uuid: ids.E }, project.uuid)).resolves.toBeUndefined();
    await expect(tasks.assertAssigneeProjectAccess(companyUuid, { type: "agent", uuid: agentUuid }, project.uuid)).resolves.toBeUndefined();
    for (const key of ["V", "P", "N"]) {
      await expect(tasks.assertAssigneeProjectAccess(companyUuid, { type: "user", uuid: ids[key] }, project.uuid)).rejects.toThrow();
    }
  });

  it("serializes concurrent removal of the final two group Admins and retains one", async () => {
    const remove = (key: string) => invoke<unknown, { uuid: string; userUuid: string }>(actor(key),
      routes.groupMember.DELETE, `/api/project-groups/${group.uuid}/members/${ids[key]}`,
      { uuid: group.uuid, userUuid: ids[key] }, "DELETE");
    const results = await Promise.all([remove("A"), remove("B")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const admins = await db.projectGroupMember.findMany({ where: { groupUuid: group.uuid, role: "admin" } });
    expect(admins).toHaveLength(1);
    const winner = admins[0].userUuid === ids.A ? "A" : "B";
    const removed = winner === "A" ? "B" : "A";
    expect((await grantGroup(winner, group.uuid, removed, "admin")).status).toBe(200);
  });

  it("rejects manual claims from every actor without changing legacy projects or grants", async () => {
    const legacy = await db.projectGroup.create({ data: { companyUuid, name: token } });
    await createProject("A", legacy.uuid, "private");
    await createProject("N", legacy.uuid, "private");
    const before = await db.project.findMany({ where: { groupUuid: legacy.uuid }, orderBy: { uuid: "asc" } });
    const grants = await db.projectMember.findMany({ where: { projectUuid: { in: before.map((p) => p.uuid) } }, orderBy: { uuid: "asc" } });
    for (const auth of [actor("A"), actor("N"), agent("A")]) {
      expect((await invoke<Entity, { uuid: string }>(auth, routes.group.PATCH,
        `/api/project-groups/${legacy.uuid}`, { uuid: legacy.uuid }, "PATCH", { initializeAccess: true })).status).toBe(422);
    }
    expect(await db.projectGroupMember.count({ where: { groupUuid: legacy.uuid } })).toBe(0);
    expect(await db.project.findMany({ where: { groupUuid: legacy.uuid }, orderBy: { uuid: "asc" } })).toEqual(before);
    expect(await db.projectMember.findMany({ where: { projectUuid: { in: before.map((p) => p.uuid) } }, orderBy: { uuid: "asc" } })).toEqual(grants);
  });

  it("rejects missing/stale publication with accompanying settings and retains both grant layers after confirmation", async () => {
    const publicGroup = await createGroup("A", "public");
    const child = await createProject("A", publicGroup.uuid, "private");
    const preview = () => invoke<Preview, { uuid: string }>(actor("A"), routes.projectPreview.GET,
      `/api/projects/${child.uuid}/access-preview?visibility=public`, { uuid: child.uuid });
    const publish = (confirmationToken?: string) => invoke<Entity, { uuid: string }>(actor("A"), routes.project.PATCH,
      `/api/projects/${child.uuid}`, { uuid: child.uuid }, "PATCH",
      { visibility: "public", name: "Confirmed publication", confirmationToken });
    expect((await publish()).status).toBe(409);
    const old = (await preview()).data;
    expect((await grantGroup("A", publicGroup.uuid, "V", "viewer")).status).toBe(200);
    const grants = await db.projectMember.findMany({ where: { projectUuid: child.uuid } });
    const inherited = await db.projectGroupMember.findMany({
      where: { groupUuid: publicGroup.uuid }, orderBy: { uuid: "asc" },
    });
    expect((await publish(old.confirmationToken)).status).toBe(409);
    expect(await db.project.findUniqueOrThrow({ where: { uuid: child.uuid } }))
      .toMatchObject({ name: token, visibility: "private" });
    expect(await db.activity.count({
      where: { projectUuid: child.uuid, action: "project_visibility_changed" },
    })).toBe(0);
    expect((await publish((await preview()).data.confirmationToken)).status).toBe(200);
    expect((await getProject("N", child.uuid)).data.accessLevel).toBe("editor");
    expect(await db.projectMember.findMany({ where: { projectUuid: child.uuid } })).toEqual(grants);
    expect(await db.projectGroupMember.findMany({
      where: { groupUuid: publicGroup.uuid }, orderBy: { uuid: "asc" },
    })).toEqual(inherited);
  });

  it("requires fresh confirmation for atomic group conversion and preserves local grants in both directions", async () => {
    const publicGroup = await createGroup("A", "public");
    expect((await grantGroup("A", publicGroup.uuid, "V", "viewer")).status).toBe(200);
    const publicChild = await createProject("A", publicGroup.uuid);
    const privateChild = await createProject("A", publicGroup.uuid, "private");
    const beforeMembers = await db.projectMember.findMany({
      where: { projectUuid: { in: [publicChild.uuid, privateChild.uuid] } }, orderBy: { uuid: "asc" },
    });
    const update = (visibility: string, confirmationToken?: string) => invoke<Entity, { uuid: string }>(
      actor("A"), routes.group.PATCH, `/api/project-groups/${publicGroup.uuid}`, { uuid: publicGroup.uuid },
      "PATCH", { visibility, confirmationToken },
    );
    expect((await update("private")).status).toBe(409);
    expect((await db.project.findUniqueOrThrow({ where: { uuid: publicChild.uuid } })).visibility).toBe("public");
    const stale = await groupPreview("A", publicGroup.uuid, "private");
    expect((await grantGroup("A", publicGroup.uuid, "E", "editor")).status).toBe(200);
    expect((await update("private", stale.confirmationToken)).status).toBe(409);
    const fresh = await groupPreview("A", publicGroup.uuid, "private");
    expect((await update("private", fresh.confirmationToken)).status).toBe(200);
    expect(await db.project.count({ where: { groupUuid: publicGroup.uuid, visibility: "public" } })).toBe(0);
    expect((await getProject("V", publicChild.uuid)).data.accessLevel).toBe("viewer");
    expect((await getProject("N", publicChild.uuid)).status).toBe(404);
    const publish = await groupPreview("A", publicGroup.uuid, "public");
    expect((await update("public", publish.confirmationToken)).status).toBe(200);
    expect((await db.project.findUniqueOrThrow({ where: { uuid: publicChild.uuid } })).visibility).toBe("private");
    expect((await getProject("N", publicChild.uuid)).status).toBe(404);
    expect(await db.projectMember.findMany({
      where: { projectUuid: { in: [publicChild.uuid, privateChild.uuid] } }, orderBy: { uuid: "asc" },
    })).toEqual(beforeMembers);
  });

  it("blocks pure-public role expansion by Editor and accepts source-project Admin confirmation", async () => {
    const source = await createGroup("A", "public");
    const target = await createGroup("B", "public");
    const child = await createProject("A", source.uuid);
    expect((await moveProject("E", child.uuid, target.uuid)).status).toBe(403);
    const preview = await movePreview("A", child.uuid, target.uuid);
    expect((await moveProject("A", child.uuid, target.uuid)).status).toBe(409);
    expect((await moveProject("A", child.uuid, target.uuid, preview.confirmationToken)).status).toBe(200);
    expect((await getProject("B", child.uuid)).data.accessLevel).toBe("admin");
  });

  it("requires source and target group Admin at a private boundary, rechecking stale movement tokens", async () => {
    const target = await createGroup("B");
    expect((await moveProject("A", project.uuid, target.uuid)).status).toBe(404);
    expect((await grantGroup("B", target.uuid, "A", "admin")).status).toBe(200);
    const stale = await movePreview("A", project.uuid, target.uuid);
    expect((await grantGroup("B", target.uuid, "N", "viewer")).status).toBe(200);
    expect((await moveProject("A", project.uuid, target.uuid, stale.confirmationToken)).status).toBe(409);
    expect((await db.project.findUniqueOrThrow({ where: { uuid: project.uuid } })).groupUuid).toBe(group.uuid);
    const fresh = await movePreview("A", project.uuid, target.uuid);
    expect((await moveProject("A", project.uuid, target.uuid, fresh.confirmationToken)).status).toBe(200);
    expect((await getProject("N")).data.accessLevel).toBe("viewer");
    expect((await getProject("E")).data.accessLevel).toBe("viewer"); // Local grant survives; source floor is gone.
    const returnPreview = await movePreview("A", project.uuid, group.uuid);
    expect((await moveProject("A", project.uuid, group.uuid, returnPreview.confirmationToken)).status).toBe(200);
  });

  it("snapshots every maximum effective private role on detach and on group deletion", async () => {
    const retained = await createProject("A", group.uuid);
    const preview = await movePreview("A", retained.uuid, null);
    expect((await moveProject("A", retained.uuid, null, preview.confirmationToken)).status).toBe(200);
    expect((await getProject("E", retained.uuid)).data.accessLevel).toBe("editor");
    expect((await getProject("V", retained.uuid)).data.accessLevel).toBe("viewer");
    expect((await getProject("B", retained.uuid)).data.accessLevel).toBe("admin");
    expect((await db.project.findUniqueOrThrow({ where: { uuid: retained.uuid } })))
      .toMatchObject({ groupUuid: null, visibility: "private" });
    const deletedGroup = await createGroup("A");
    expect((await grantGroup("A", deletedGroup.uuid, "E", "editor")).status).toBe(200);
    expect((await grantGroup("A", deletedGroup.uuid, "V", "viewer")).status).toBe(200);
    const child = await createProject("A", deletedGroup.uuid);
    expect((await invoke<unknown, { uuid: string }>(actor("A"), routes.group.DELETE,
      `/api/project-groups/${deletedGroup.uuid}`, { uuid: deletedGroup.uuid }, "DELETE")).status).toBe(200);
    expect((await getProject("E", child.uuid)).data.accessLevel).toBe("editor");
    expect((await getProject("V", child.uuid)).data.accessLevel).toBe("viewer");
    expect((await getProject("A", child.uuid)).data.accessLevel).toBe("admin");
    expect(await db.projectMember.count({ where: { projectUuid: child.uuid } })).toBe(3);
  });

  it("filters projectless private-group metadata and serializes delivery after inherited revocation", async () => {
    const [viewer, outsider, projectOnly] = await Promise.all([openStream("V"), openStream("N"), openStream("P")]);
    try {
      bus.emitChange({
        companyUuid, projectUuid: "", entityType: "project_group", entityUuid: group.uuid, action: "updated",
      });
      await eventually(() => viewer.events.some((e) => e.includes(group.uuid))
        && projectOnly.events.some((e) => e.includes(group.uuid)));
      expect(outsider.events.some((e) => e.includes(group.uuid))).toBe(false);
      const remove = await invoke<unknown, { uuid: string; userUuid: string }>(actor("A"), routes.groupMember.DELETE,
        `/api/project-groups/${group.uuid}/members/${ids.V}`, { uuid: group.uuid, userUuid: ids.V }, "DELETE");
      expect(remove.status).toBe(200);
      bus.emitChange({
        companyUuid, projectUuid: sibling.uuid, entityType: "task", entityUuid: "after-revocation", action: "updated",
      });
      bus.emitChange({
        companyUuid, projectUuid: project.uuid, entityType: "task", entityUuid: "project-only-access", action: "updated",
      });
      await eventually(() => projectOnly.events.some((e) => e.includes("project-only-access")));
      expect(viewer.events.some((e) => e.includes("after-revocation"))).toBe(false);
      expect(projectOnly.events.some((e) => e.includes("after-revocation"))).toBe(false);
      expect(outsider.events.some((e) => e.includes("project-only-access"))).toBe(false);
      expect((await getProject("V", sibling.uuid)).status).toBe(404);
    } finally {
      await Promise.all([viewer.close(), outsider.close(), projectOnly.close()]);
      expect((await grantGroup("A", group.uuid, "V", "viewer")).status).toBe(200);
    }
  });

  it("observes membership commits after a PostgreSQL row-lock wait and rejects the obsolete conversion", async () => {
    const waitingGroup = await createGroup("A", "public");
    expect((await grantGroup("A", waitingGroup.uuid, "V", "viewer")).status).toBe(200);
    const child = await createProject("A", waitingGroup.uuid);
    const preview = await groupPreview("A", waitingGroup.uuid, "private");
    const holder = await pool.connect();
    let pending: Promise<{ status: number; data: Entity }> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query('SELECT uuid FROM "ProjectGroup" WHERE uuid = $1 FOR UPDATE', [waitingGroup.uuid]);
      pending = invoke<Entity, { uuid: string }>(actor("A"), routes.group.PATCH,
        `/api/project-groups/${waitingGroup.uuid}`, { uuid: waitingGroup.uuid }, "PATCH", {
          visibility: "private", confirmationToken: preview.confirmationToken,
        });
      // Wait for an actual competing PostgreSQL lock, not a timing-only sleep.
      await waitForGroupLock();
      await holder.query('UPDATE "ProjectGroupMember" SET role = $1 WHERE "groupUuid" = $2 AND "userUuid" = $3',
        ["editor", waitingGroup.uuid, ids.V]);
      await holder.query('UPDATE "ProjectGroup" SET "accessVersion" = "accessVersion" + 1 WHERE uuid = $1', [waitingGroup.uuid]);
      await holder.query("COMMIT");
      expect((await pending).status).toBe(409);
      expect((await db.project.findUniqueOrThrow({ where: { uuid: child.uuid } })).visibility).toBe("public");
      expect((await db.projectGroup.findUniqueOrThrow({ where: { uuid: waitingGroup.uuid } })).visibility).toBe("public");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      if (pending) await pending;
    }
  });

  it.each(["PATCH", "DELETE"])("rechecks inherited management after a competing demotion commits: %s", async (method) => {
    const managedGroup = await createGroup("A");
    expect((await grantGroup("A", managedGroup.uuid, "B", "admin")).status).toBe(200);
    const child = await createProject("A", managedGroup.uuid);
    expect((await getProject("B", child.uuid)).data.accessLevel).toBe("admin");
    expect(await db.projectMember.count({ where: { projectUuid: child.uuid, userUuid: ids.B } })).toBe(0);
    const holder = await pool.connect();
    let pending: Promise<{ status: number; data: Entity }> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query('SELECT uuid FROM "ProjectGroup" WHERE uuid = $1 FOR UPDATE', [managedGroup.uuid]);
      pending = invoke<Entity, { uuid: string }>(actor("B"),
        method === "PATCH" ? routes.project.PATCH : routes.project.DELETE,
        `/api/projects/${child.uuid}`, { uuid: child.uuid }, method,
        method === "PATCH" ? { name: "Revoked Admin must not write" } : undefined);
      await waitForGroupLock();
      await holder.query('UPDATE "ProjectGroupMember" SET role = $1 WHERE "groupUuid" = $2 AND "userUuid" = $3',
        ["viewer", managedGroup.uuid, ids.B]);
      await holder.query('UPDATE "ProjectGroup" SET "accessVersion" = "accessVersion" + 1 WHERE uuid = $1', [managedGroup.uuid]);
      await holder.query("COMMIT");
      expect((await pending).status).toBe(403);
      expect(await db.project.findUniqueOrThrow({ where: { uuid: child.uuid } }))
        .toMatchObject({ name: token, visibility: "private", groupUuid: managedGroup.uuid });
      expect((await getProject("B", child.uuid)).data.accessLevel).toBe("viewer");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      if (pending) await pending;
    }
  });

  it.each(["disable", "impersonate"])("server action rejects caller-controlled identity after inherited revocation: %s", async (attack) => {
    const managedGroup = await createGroup("A");
    expect((await grantGroup("A", managedGroup.uuid, "B", "admin")).status).toBe(200);
    const child = await createProject("A", managedGroup.uuid);
    const actions = await import("@/app/(dashboard)/projects/[uuid]/actions");
    const holder = await pool.connect();
    let pending: ReturnType<typeof actions.updateProjectAction> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query('SELECT uuid FROM "ProjectGroup" WHERE uuid = $1 FOR UPDATE', [managedGroup.uuid]);
      state.auth = actor("B");
      const untrustedData = {
        name: "Untrusted identity must not write",
        agentCwds: { upserts: [], clears: [] },
        auth: attack === "disable" ? null : actor("A"),
        companyUuid,
        userUuid: ids.A,
        projectUuid: child.uuid,
      };
      pending = actions.updateProjectAction(child.uuid, untrustedData);
      await waitForGroupLock();
      await holder.query('UPDATE "ProjectGroupMember" SET role = $1 WHERE "groupUuid" = $2 AND "userUuid" = $3',
        ["viewer", managedGroup.uuid, ids.B]);
      await holder.query('UPDATE "ProjectGroup" SET "accessVersion" = "accessVersion" + 1 WHERE uuid = $1', [managedGroup.uuid]);
      await holder.query("COMMIT");
      expect((await pending).success).toBe(false);
      expect((await db.project.findUniqueOrThrow({ where: { uuid: child.uuid } })).name).toBe(token);
      expect((await db.project.findUniqueOrThrow({ where: { uuid: sibling.uuid } })).name).toBe(token);
      expect((await getProject("B", child.uuid)).data.accessLevel).toBe("viewer");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      if (pending) await pending;
    }
  });

  it.each([
    { source: "missing", detach: true },
    { source: "missing", detach: false },
    { source: "foreign", detach: true },
    { source: "foreign", detach: false },
  ])("repairs a legacy $source group reference with local grants retained (detach=$detach)", async ({ source, detach }) => {
    const foreign = source === "foreign" ? await createGroup("F") : null;
    const sourceUuid = foreign?.uuid ?? randomUUID();
    const target = detach ? null : await createGroup("A");
    // Simulate a pre-upgrade MCP assignment; the current create API forbids it.
    const orphan = await db.project.create({ data: {
      companyUuid, name: token, groupUuid: sourceUuid, visibility: "private",
    } });
    await db.projectMember.createMany({ data: [
      { companyUuid, projectUuid: orphan.uuid, userUuid: ids.A, role: "admin", addedByUuid: ids.A },
      { companyUuid, projectUuid: orphan.uuid, userUuid: ids.P, role: "viewer", addedByUuid: ids.A },
    ] });
    const localBefore = await db.projectMember.findMany({
      where: { projectUuid: orphan.uuid }, orderBy: { userUuid: "asc" },
    });
    const foreignBefore = foreign ? await db.projectGroup.findUniqueOrThrow({ where: { uuid: sourceUuid } }) : null;
    const sourceAuditBefore = await db.comment.count({
      where: { targetType: "project_group", targetUuid: sourceUuid },
    });
    const auditBefore = await db.comment.count({ where: { companyUuid } });
    const deniedPreview = await invoke<Preview, { uuid: string }>(actor("P"), routes.movePreview.GET,
      `/api/projects/${orphan.uuid}/group/preview?groupUuid=${target?.uuid ?? ""}`, { uuid: orphan.uuid });
    expect(deniedPreview.status).toBe(403);
    const missingTarget = await invoke<Preview, { uuid: string }>(actor("A"), routes.movePreview.GET,
      `/api/projects/${orphan.uuid}/group/preview?groupUuid=${randomUUID()}`, { uuid: orphan.uuid });
    expect(missingTarget.status).toBe(404);
    expect((await moveProject("A", orphan.uuid, target?.uuid ?? null, "0".repeat(64))).status).toBe(409);
    expect((await db.project.findUniqueOrThrow({ where: { uuid: orphan.uuid } })).groupUuid).toBe(sourceUuid);
    expect(await db.comment.count({ where: { companyUuid } })).toBe(auditBefore);

    const preview = await movePreview("A", orphan.uuid, target?.uuid ?? null);
    expect((await moveProject("A", orphan.uuid, target?.uuid ?? null, preview.confirmationToken)).status).toBe(200);
    expect(await db.project.findUniqueOrThrow({ where: { uuid: orphan.uuid } }))
      .toMatchObject({ groupUuid: target?.uuid ?? null, visibility: "private" });
    expect(await db.projectMember.findMany({ where: { projectUuid: orphan.uuid }, orderBy: { userUuid: "asc" } }))
      .toEqual(localBefore);
    expect((await getProject("A", orphan.uuid)).data.accessLevel).toBe("admin");
    expect((await getProject("P", orphan.uuid)).data.accessLevel).toBe("viewer");
    expect(await db.comment.count({ where: { targetType: "project_group", targetUuid: sourceUuid } }))
      .toBe(sourceAuditBefore);
    if (foreign) {
      expect(await db.projectGroup.findUniqueOrThrow({ where: { uuid: sourceUuid } })).toEqual(foreignBefore);
    }
  });
});
