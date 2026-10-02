/**
 * Run against the isolated, migrated group_review PostgreSQL database:
 * PROJECT_GROUP_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5441/group_review
 * pnpm exec vitest run src/__tests__/integration/project-group-implicit-admin.database.integration.test.ts
 *
 * Every case owns unique companies and cleans them up. Prisma and production
 * authorization, preview, search, notification and mutation services are real.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { NextRequest } from "next/server";
// Relative import intentionally bypasses Vitest's generated-client mock alias.
import { PrismaClient } from "../../generated/prisma/client";
import type { AgentAuthContext, AuthContext } from "@/types/auth";
import type { ProjectAccessClient } from "@/services/project-access.service";

const state = vi.hoisted(() => ({ db: null as unknown, auth: null as AuthContext | null }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAuthContext: async () => state.auth,
}));

const url = process.env.PROJECT_GROUP_DATABASE_URL;
const createDatabase = (pool: pg.Pool) => new PrismaClient({
  adapter: new PrismaPg(pool), log: [{ emit: "event", level: "query" }],
});

describe.skipIf(!url)("lazy implicit group Admin — real PostgreSQL acceptance", () => {
  let db: ReturnType<typeof createDatabase>;
  let accessClient: ProjectAccessClient;
  let pool: pg.Pool;
  let access: typeof import("@/services/project-access.service");
  let groupAccess: typeof import("@/services/project-group-access.service");
  let groups: typeof import("@/services/project-group.service");
  let projects: typeof import("@/services/project.service");
  let previews: typeof import("@/services/project-group-preview.service");
  let implicit: typeof import("@/services/project-group-implicit-admin.service");
  let search: typeof import("@/services/search.service");
  let notifications: typeof import("@/services/notification.service");
  let members: typeof import("@/services/project-member.service");
  let eventsRoute: typeof import("@/app/api/events/route");
  let eventBus: typeof import("@/lib/event-bus").eventBus;
  let tenantTables: string[];
  const queries: string[] = [];
  let companyUuid: string;
  let foreignCompanyUuid: string;
  let emptyCompanyUuid: string;
  let ids: Record<"first" | "next" | "later" | "foreign" | "ownedAgent" | "ownerlessAgent", string>;
  let token: string;

  const actor = (key: "first" | "next" | "later" = "first"): AuthContext => ({
    type: "user", actorUuid: ids[key], companyUuid,
  });
  const agent = (owned = true): AgentAuthContext => ({
    type: "agent", actorUuid: owned ? ids.ownedAgent : ids.ownerlessAgent, companyUuid,
    ownerUuid: owned ? ids.first : undefined, roles: ["developer_agent"], agentName: token,
    permissions: ["project:read", "task:read"],
  });
  async function legacyGroup(visibility = "private", tenant = companyUuid) {
    return db.projectGroup.create({ data: {
      companyUuid: tenant, name: `${token} legacy`, visibility,
      createdByUuid: null, accessVersion: 0,
    } });
  }
  async function child(groupUuid: string, visibility = "private", tenant = companyUuid) {
    return db.project.create({ data: {
      companyUuid: tenant, groupUuid, name: `${token} child`, visibility, createdByUuid: null,
    } });
  }
  async function snapshot() {
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const sql = tenantTables.map((table) => `
      SELECT '${table.replaceAll("'", "''")}' AS name,
        COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows
      FROM ${quote(table)} AS t WHERE "companyUuid" = ANY($1::text[])
    `).join(" UNION ALL ");
    return (await pool.query(sql, [[companyUuid, foreignCompanyUuid, emptyCompanyUuid]])).rows;
  }
  async function readWithoutWrites(read: () => Promise<void>) {
    const before = await snapshot();
    queries.length = 0;
    await read();
    expect(queries.filter((query) => /^\s*(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(query))).toEqual([]);
    expect(await snapshot()).toEqual(before);
  }
  async function openStream(auth: AuthContext) {
    state.auth = auth;
    const abort = new AbortController();
    const response = await eventsRoute.GET(new NextRequest("http://localhost/api/events", { signal: abort.signal }));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          chunks.push(decoder.decode(value, { stream: true }));
        }
      } catch { /* Stream cancelled during cleanup. */ }
    })();
    return {
      events: () => chunks.join("").split("\n\n").filter((chunk) => chunk.startsWith("data: "))
        .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>),
      async close() { abort.abort(); await reader.cancel(); await pump; },
    };
  }
  async function eventually(predicate: () => boolean) {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(predicate()).toBe(true);
  }

  beforeAll(async () => {
    const target = new URL(url!);
    expect(["127.0.0.1", "localhost"]).toContain(target.hostname);
    expect(target.port).toBe("5441");
    expect(target.pathname).toBe("/group_review");
    pool = new pg.Pool({ connectionString: url, max: 8 });
    db = createDatabase(pool);
    // Production's Prisma singleton has extensions; the same raw delegates
    // satisfy the authorization interface at runtime in this isolated fixture.
    accessClient = db as unknown as ProjectAccessClient;
    db.$on("query", (event) => queries.push(event.query));
    state.db = db;
    // Dynamic imports allow the parent worker to add the helper independently.
    implicit = await import("@/services/project-group-implicit-admin.service");
    access = await import("@/services/project-access.service");
    groupAccess = await import("@/services/project-group-access.service");
    groups = await import("@/services/project-group.service");
    projects = await import("@/services/project.service");
    previews = await import("@/services/project-group-preview.service");
    search = await import("@/services/search.service");
    notifications = await import("@/services/notification.service");
    members = await import("@/services/project-member.service");
    eventsRoute = await import("@/app/api/events/route");
    ({ eventBus } = await import("@/lib/event-bus"));
    tenantTables = (await pool.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'companyUuid' ORDER BY table_name
    `)).rows.map((row) => row.table_name);
    expect(tenantTables).toEqual(expect.arrayContaining(["User", "Project", "ProjectGroup", "ProjectGroupMember", "ProjectMember"]));
  }, 30_000);

  beforeEach(async () => {
    companyUuid = randomUUID(); foreignCompanyUuid = randomUUID(); emptyCompanyUuid = randomUUID();
    token = `lazy-admin-${randomUUID()}`;
    ids = {
      first: randomUUID(), next: randomUUID(), later: randomUUID(), foreign: randomUUID(),
      ownedAgent: randomUUID(), ownerlessAgent: randomUUID(),
    };
    for (const uuid of [companyUuid, foreignCompanyUuid, emptyCompanyUuid]) {
      await db.company.create({ data: { uuid, name: token } });
    }
    // Insert the later-created user first: id alone must not determine Admin.
    // Equal timestamps for first/next then exercise the id tiebreaker.
    for (const [key, createdAt] of [
      ["later", "2025-02-01"], ["first", "2025-01-01"], ["next", "2025-01-01"], ["foreign", "2020-01-01"],
    ] as const) {
      await db.user.create({ data: {
        uuid: ids[key], companyUuid: key === "foreign" ? foreignCompanyUuid : companyUuid,
        oidcSub: ids[key], name: key, email: `${key}-${token}@example.test`, createdAt: new Date(createdAt),
      } });
    }
    await db.agent.create({ data: { uuid: ids.ownedAgent, companyUuid, name: token, ownerUuid: ids.first } });
    await db.agent.create({ data: { uuid: ids.ownerlessAgent, companyUuid, name: token } });
  });

  afterEach(async () => {
    if (!db || !companyUuid) return;
    for (const uuid of [companyUuid, foreignCompanyUuid, emptyCompanyUuid]) {
      const tenant = { companyUuid: uuid };
      await db.notification.deleteMany({ where: tenant });
      await db.activity.deleteMany({ where: tenant });
      await db.comment.deleteMany({ where: tenant });
      await db.projectVisit.deleteMany({ where: tenant });
      await db.projectAgentCwdPreference.deleteMany({ where: tenant });
      await db.project.deleteMany({ where: tenant });
      await db.projectGroupMember.deleteMany({ where: tenant });
      await db.projectGroup.deleteMany({ where: tenant });
      await db.agent.deleteMany({ where: tenant });
      await db.user.deleteMany({ where: tenant });
      await db.company.deleteMany({ where: { uuid } });
    }
  }, 30_000);
  afterAll(async () => { await db?.$disconnect(); await pool?.end(); });

  it("selects createdAt/id dynamically and returns null for unknown, foreign or userless groups", async () => {
    const group = await legacyGroup();
    const foreign = await legacyGroup("private", foreignCompanyUuid);
    const empty = await legacyGroup("private", emptyCompanyUuid);
    const tied = await db.user.findMany({
      where: { companyUuid }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(tied.map((row) => row.uuid)).toEqual([ids.first, ids.next, ids.later]);
    await readWithoutWrites(async () => {
      expect(await implicit.implicitGroupAdmin(companyUuid, group.uuid, accessClient)).toBe(ids.first);
      expect(await implicit.implicitGroupAdmin(companyUuid, randomUUID(), accessClient)).toBeNull();
      expect(await implicit.implicitGroupAdmin(companyUuid, foreign.uuid, accessClient)).toBeNull();
      expect(await implicit.implicitGroupAdmin(emptyCompanyUuid, empty.uuid, accessClient)).toBeNull();
      expect(await implicit.implicitGroupAdmin(foreignCompanyUuid, foreign.uuid, accessClient)).toBe(ids.foreign);
      expect((await groupAccess.getGroupAccess({ ...actor(), companyUuid: foreignCompanyUuid }, group.uuid)).group).toBeNull();
    });
  });

  it("real SQL discovery, lists, details and dashboards include private children without authorization writes", async () => {
    const group = await legacyGroup();
    const project = await child(group.uuid);
    const sibling = await child(group.uuid);
    const empty = await legacyGroup();
    const publicGroup = await legacyGroup("public");
    const privateChild = await child(publicGroup.uuid);
    await db.projectGroupMember.create({ data: {
      companyUuid, groupUuid: publicGroup.uuid, userUuid: ids.later, role: "admin",
    } });
    await readWithoutWrites(async () => {
      expect((await access.computeProjectAccess(actor(), project.uuid)).level).toBe("admin");
      expect((await access.computeProjectAccess(actor("next"), project.uuid)).project).toBeNull();
      expect((await access.computeProjectAccess(actor(), privateChild.uuid)).project).toBeNull();
      expect((await groupAccess.getGroupAccess(actor(), group.uuid))).toMatchObject({
        level: "admin", explicitRole: "admin", accessInitialized: true, canManage: true, canCreateProject: true,
      });
      expect(await groupAccess.requireGroupOperation(actor(), group.uuid, "manage_members")).toMatchObject({ accessLevel: "admin" });
      const projectRows = await db.project.findMany({ where: await access.accessibleProjectWhere(actor()) });
      expect(projectRows.map((row) => row.uuid).sort()).toEqual([project.uuid, sibling.uuid].sort());
      expect(await db.project.findMany({ where: await access.accessibleProjectWhere(actor("next")) })).toEqual([]);
      const groupRows = await db.projectGroup.findMany({ where: await groupAccess.accessibleGroupWhere(actor()) });
      expect(groupRows.map((row) => row.uuid).sort()).toEqual([group.uuid, empty.uuid, publicGroup.uuid].sort());
      expect(await groupAccess.accessibleGroupUuids(actor("next"))).toEqual([publicGroup.uuid]);
      expect((await projects.listProjects({ companyUuid, auth: actor(), skip: 0, take: 100 })).total).toBe(2);
      const list = await groups.listProjectGroups(companyUuid, actor());
      expect(list.groups).toEqual(expect.arrayContaining([
        expect.objectContaining({ uuid: group.uuid, projectCount: 2, accessLevel: "admin", accessInitialized: true }),
        expect.objectContaining({ uuid: empty.uuid, projectCount: 0, accessLevel: "admin", accessInitialized: true }),
      ]));
      const detail = await groups.getProjectGroup(companyUuid, group.uuid, actor());
      expect(detail).toMatchObject({ accessLevel: "admin", accessInitialized: true, projectCount: 2 });
      expect(detail?.projects.map((row) => row.uuid).sort()).toEqual([project.uuid, sibling.uuid].sort());
      expect((await groups.getGroupDashboard(companyUuid, group.uuid, actor()))?.stats.projectCount).toBe(2);
      expect(await groups.getProjectGroup(companyUuid, group.uuid, actor("next"))).toBeNull();
      expect((await groups.getProjectGroup(companyUuid, publicGroup.uuid, actor()))?.projects).toEqual([]);
      const found = await search.search({ companyUuid, auth: actor(), query: token, entityTypes: ["project", "project_group"] });
      expect(found.results.map((row) => row.uuid)).toEqual(expect.arrayContaining([group.uuid, empty.uuid, project.uuid, sibling.uuid]));
      expect(found.results.map((row) => row.uuid)).not.toContain(privateChild.uuid);
      expect((await search.search({ companyUuid, auth: actor("next"), query: group.uuid, entityTypes: ["project_group"] })).results).toEqual([]);
    });
  });

  it("keeps stored Viewer grants unchanged while presenting effective Admin in group and child access", async () => {
    const group = await legacyGroup();
    const project = await child(group.uuid);
    await db.projectGroupMember.create({ data: { companyUuid, groupUuid: group.uuid, userUuid: ids.first, role: "viewer" } });
    await db.projectMember.create({ data: { companyUuid, projectUuid: project.uuid, userUuid: ids.first, role: "viewer" } });
    await readWithoutWrites(async () => {
      expect((await groupAccess.getGroupAccess(actor(), group.uuid)).level).toBe("admin");
      expect((await access.computeProjectAccess(actor(), project.uuid)).level).toBe("admin");
      expect((await groups.listProjectGroups(companyUuid, actor())).groups[0].accessLevel).toBe("admin");
      expect((await db.projectGroupMember.findFirstOrThrow({ where: { groupUuid: group.uuid, userUuid: ids.first } })).role).toBe("viewer");
      expect((await db.projectMember.findFirstOrThrow({ where: { projectUuid: project.uuid, userUuid: ids.first } })).role).toBe("viewer");
    });
  });

  it("explicit Admin arrival suppresses fallback immediately; removal restores it without grant writes", async () => {
    const group = await legacyGroup();
    const project = await child(group.uuid);
    await readWithoutWrites(async () => {
      expect(await implicit.implicitGroupAdmin(companyUuid, group.uuid, accessClient, actor())).toBe(ids.first);
      expect((await access.computeProjectAccess(actor(), project.uuid)).level).toBe("admin");
    });
    const grant = await db.projectGroupMember.create({ data: {
      companyUuid, groupUuid: group.uuid, userUuid: ids.next, role: "admin",
    } });
    await readWithoutWrites(async () => {
      expect(await implicit.implicitGroupAdmin(companyUuid, group.uuid, accessClient, actor())).toBeNull();
      expect((await groupAccess.getGroupAccess(actor(), group.uuid)).group).toBeNull();
      expect((await access.computeProjectAccess(actor(), project.uuid)).project).toBeNull();
      expect(await access.accessibleProjectUuids(actor())).toEqual([]);
      expect(await groupAccess.accessibleGroupUuids(actor())).toEqual([]);
      expect((await projects.listProjects({ companyUuid, auth: actor(), skip: 0, take: 100 })).total).toBe(0);
      expect((await groups.listProjectGroups(companyUuid, actor())).groups).toEqual([]);
      expect((await access.computeProjectAccess(actor("next"), project.uuid)).level).toBe("admin");
    });
    await db.projectGroupMember.delete({ where: { uuid: grant.uuid } });
    await readWithoutWrites(async () => {
      expect(await implicit.implicitGroupAdmin(companyUuid, group.uuid, accessClient, actor())).toBe(ids.first);
      expect((await access.computeProjectAccess(actor(), project.uuid)).level).toBe("admin");
      expect(await access.accessibleProjectUuids(actor())).toEqual([project.uuid]);
      expect(await db.projectGroupMember.count({ where: { groupUuid: group.uuid } })).toBe(0);
    });
  });

  it("owner-backed agents inherit lazy Admin and notification/search lists; ownerless agents stay outside", async () => {
    const group = await legacyGroup();
    const project = await child(group.uuid);
    const task = await db.task.create({ data: { companyUuid, projectUuid: project.uuid, title: token, createdByUuid: ids.later } });
    const recipients = [
      { type: "user", uuid: ids.first }, { type: "user", uuid: ids.next },
      { type: "agent", uuid: ids.ownedAgent }, { type: "agent", uuid: ids.ownerlessAgent },
    ];
    const pending = recipients.map((recipient) => ({
      companyUuid, projectUuid: project.uuid, recipientType: recipient.type, recipientUuid: recipient.uuid,
      entityType: "task", entityUuid: task.uuid, entityTitle: token, projectName: project.name,
      action: "task_assigned", message: token, actorType: "user", actorUuid: ids.later, actorName: "later",
    }));
    await db.notification.createMany({ data: pending });
    await readWithoutWrites(async () => {
      expect((await groupAccess.getGroupAccess(agent(), group.uuid)).level).toBe("admin");
      expect((await access.computeProjectAccess(agent(), project.uuid)).level).toBe("admin");
      expect((await access.computeProjectAccess(agent(false), project.uuid)).project).toBeNull();
      expect((await groupAccess.getGroupAccess(agent(false), group.uuid)).group).toBeNull();
      expect(await access.accessibleProjectUuids(agent())).toEqual([project.uuid]);
      expect(await access.accessibleProjectUuids(agent(false))).toEqual([]);
      expect(await access.filterRecipientsByProjectAccess(companyUuid, project.uuid, recipients)).toEqual([recipients[0], recipients[2]]);
      expect(await access.privateProjectMemberUuids(companyUuid, project.uuid)).toEqual([ids.first]);
      expect(await notifications.filterNotificationsByProjectAccess(pending)).toEqual([pending[0], pending[2]]);
      for (const context of [actor(), agent()]) {
        expect(await notifications.list({
          companyUuid, recipientType: context.type, recipientUuid: context.actorUuid, auth: context,
        })).toMatchObject({ total: 1, unreadCount: 1, notifications: [expect.objectContaining({ entityUuid: task.uuid })] });
        const found = await search.search({ companyUuid, auth: context, query: token, entityTypes: ["project", "task", "project_group"] });
        expect(found.results.map((row) => row.uuid).sort()).toEqual([project.uuid, task.uuid, group.uuid].sort());
      }
      for (const context of [actor("next"), agent(false)]) {
        expect(await notifications.list({
          companyUuid, recipientType: context.type, recipientUuid: context.actorUuid, auth: context,
        })).toMatchObject({ total: 0, unreadCount: 0, notifications: [] });
        expect((await search.search({ companyUuid, auth: context, query: token, entityTypes: ["project", "task", "project_group"] })).results).toEqual([]);
      }
    });
  });

  it("deleting the first user selects the next and invalidates a preview for the same surviving actor", async () => {
    const group = await legacyGroup("public");
    const project = await child(group.uuid, "public");
    await db.projectMember.create({ data: { companyUuid, projectUuid: project.uuid, userUuid: ids.later, role: "admin" } });
    const preview = await previews.getProjectGroupMovePreview(actor("later"), project.uuid, null);
    // Remove the owner FK so deletion tests authorization selection, not FK policy.
    await db.agent.update({ where: { uuid: ids.ownedAgent }, data: { ownerUuid: null } });
    await db.user.delete({ where: { uuid: ids.first } });
    await readWithoutWrites(async () => {
      expect(await implicit.implicitGroupAdmin(companyUuid, group.uuid, accessClient, actor("next"))).toBe(ids.next);
      expect((await groupAccess.getGroupAccess(actor("next"), group.uuid)).level).toBe("admin");
      expect((await access.computeProjectAccess(actor("next"), project.uuid)).level).toBe("admin");
      expect((await previews.getProjectGroupMovePreview(actor("later"), project.uuid, null)).confirmationToken).not.toBe(preview.confirmationToken);
      expect((await db.projectGroup.findUniqueOrThrow({ where: { uuid: group.uuid } })).accessVersion).toBe(0);
      await expect(groups.moveProjectToGroup(companyUuid, project.uuid, null, actor("later"), preview.confirmationToken))
        .rejects.toMatchObject({ status: 409 });
    });
  });

  it("publishes first-user deletion to real SSE gates, transferring children and empty-group discovery", async () => {
    const group = await legacyGroup();
    const project = await child(group.uuid);
    const sibling = await child(group.uuid);
    const empty = await legacyGroup();
    const explicit = await legacyGroup();
    await child(explicit.uuid);
    await db.projectGroupMember.create({ data: { companyUuid, groupUuid: explicit.uuid, userUuid: ids.later, role: "admin" } });
    const foreign = await legacyGroup("private", foreignCompanyUuid);
    await child(foreign.uuid, "private", foreignCompanyUuid);
    const streams: Awaited<ReturnType<typeof openStream>>[] = [];
    const accessEvents: unknown[] = [];
    const groupEvents: unknown[] = [];
    const onAccess = (event: { companyUuid: string }) => { if (event.companyUuid === companyUuid) accessEvents.push(event); };
    const onGroup = (event: { companyUuid: string; entityType: string }) => {
      if (event.companyUuid === companyUuid && event.entityType === "project_group") groupEvents.push(event);
    };
    try {
      const old = await openStream(actor()); streams.push(old);
      const next = await openStream(actor("next")); streams.push(next);
      const ownerless = await openStream(agent(false)); streams.push(ownerless);
      eventBus.emitChange({ companyUuid, projectUuid: project.uuid, entityType: "task", entityUuid: "before-transfer", action: "updated" });
      await eventually(() => old.events().some((event) => event.entityUuid === "before-transfer"));
      expect(next.events()).toEqual([]);
      expect(ownerless.events()).toEqual([]);
      await db.agent.update({ where: { uuid: ids.ownedAgent }, data: { ownerUuid: null } });
      await db.user.delete({ where: { uuid: ids.first } });
      eventBus.on("project_access_changed", onAccess);
      eventBus.on("change", onGroup);
      await readWithoutWrites(async () => {
        await implicit.publishImplicitGroupAdminChange(companyUuid);
        await eventually(() => next.events().filter((event) => event.entityType === "project_group").length === 2);
        await eventually(() => old.events().filter((event) => event.entityType === "project_group").length === 2);
        expect(accessEvents).toEqual(expect.arrayContaining([
          { companyUuid, projectUuid: project.uuid, userUuids: [] },
          { companyUuid, projectUuid: sibling.uuid, userUuids: [] },
        ]));
        expect(accessEvents).toHaveLength(2);
        expect(groupEvents).toEqual(expect.arrayContaining([
          { companyUuid, projectUuid: "", entityType: "project_group", entityUuid: group.uuid, action: "updated" },
          { companyUuid, projectUuid: "", entityType: "project_group", entityUuid: empty.uuid, action: "updated" },
        ]));
        expect(groupEvents).toHaveLength(2);
        // Group refreshes drain after their child access recomputes.
        eventBus.emitChange({ companyUuid, projectUuid: project.uuid, entityType: "task", entityUuid: "after-transfer", action: "updated" });
        eventBus.emitChange({ companyUuid, projectUuid: sibling.uuid, entityType: "task", entityUuid: "sibling-transfer", action: "updated" });
        await eventually(() => next.events().some((event) => event.entityUuid === "sibling-transfer"));
        expect(next.events().some((event) => event.entityUuid === "after-transfer")).toBe(true);
        expect(old.events().some((event) => event.entityUuid === "after-transfer" || event.entityUuid === "sibling-transfer")).toBe(false);
        expect(ownerless.events()).toEqual([]);
        expect((await groupAccess.getGroupAccess(actor("next"), empty.uuid)).level).toBe("admin");
      });
    } finally {
      eventBus.off("project_access_changed", onAccess);
      eventBus.off("change", onGroup);
      await Promise.all(streams.map((stream) => stream.close()));
    }
  });

  it("preview freshness includes implicit Admin identity even when the roster and accessVersion do not change", async () => {
    const group = await legacyGroup("public");
    const project = await child(group.uuid, "public");
    await db.projectMember.create({ data: { companyUuid, projectUuid: project.uuid, userUuid: ids.later, role: "admin" } });
    const preview = await previews.getProjectGroupMovePreview(actor("later"), project.uuid, null);
    await db.user.update({ where: { uuid: ids.first }, data: { createdAt: new Date("2025-01-02") } });
    await readWithoutWrites(async () => {
      expect(await implicit.implicitGroupAdmin(companyUuid, group.uuid, accessClient)).toBe(ids.next);
      expect((await previews.getProjectGroupMovePreview(actor("later"), project.uuid, null)).confirmationToken).not.toBe(preview.confirmationToken);
      await expect(groups.moveProjectToGroup(companyUuid, project.uuid, null, actor("later"), preview.confirmationToken))
        .rejects.toMatchObject({ status: 409 });
    });
  });

  it("authorized detach snapshots lazy Admin as a local grant and retains it after fallback changes", async () => {
    const group = await legacyGroup();
    const project = await child(group.uuid);
    await db.projectMember.create({ data: { companyUuid, projectUuid: project.uuid, userUuid: ids.first, role: "viewer" } });
    let confirmationToken = "";
    await readWithoutWrites(async () => {
      confirmationToken = (await previews.getProjectGroupMovePreview(actor(), project.uuid, null)).confirmationToken;
      expect((await db.projectMember.findFirstOrThrow({ where: { projectUuid: project.uuid } })).role).toBe("viewer");
    });
    expect(await groups.moveProjectToGroup(companyUuid, project.uuid, null, actor(), confirmationToken))
      .toMatchObject({ groupUuid: null, visibility: "private" });
    expect(await db.projectGroupMember.count({ where: { groupUuid: group.uuid } })).toBe(0);
    expect(await db.projectMember.findMany({ where: { projectUuid: project.uuid } })).toEqual([
      expect.objectContaining({ userUuid: ids.first, role: "admin" }),
    ]);
    await db.projectGroupMember.create({ data: { companyUuid, groupUuid: group.uuid, userUuid: ids.next, role: "admin" } });
    await readWithoutWrites(async () => {
      expect((await access.computeProjectAccess(actor(), project.uuid)).level).toBe("admin");
      expect((await access.computeProjectAccess(actor("next"), project.uuid)).project).toBeNull();
      expect((await access.computeProjectAccess(agent(), project.uuid)).level).toBe("admin");
    });
  });

  it("permits removing or demoting the final local Admin while lazy inherited Admin remains", async () => {
    const group = await legacyGroup();
    const removed = await child(group.uuid);
    const demoted = await child(group.uuid);
    for (const project of [removed, demoted]) {
      await db.projectMember.create({ data: { companyUuid, projectUuid: project.uuid, userUuid: ids.first, role: "admin" } });
    }
    await members.removeMember(actor(), removed.uuid, ids.first);
    await members.updateMemberRole(actor(), demoted.uuid, ids.first, "viewer");
    await readWithoutWrites(async () => {
      expect(await db.projectMember.count({ where: { projectUuid: removed.uuid } })).toBe(0);
      expect((await db.projectMember.findFirstOrThrow({ where: { projectUuid: demoted.uuid } })).role).toBe("viewer");
      expect((await access.computeProjectAccess(actor(), removed.uuid)).level).toBe("admin");
      expect((await access.computeProjectAccess(actor(), demoted.uuid)).level).toBe("admin");
      expect(await db.projectGroupMember.count({ where: { groupUuid: group.uuid } })).toBe(0);
    });
  });
});
