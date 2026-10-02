/**
 * Opt-in acceptance against the isolated, already migrated PostgreSQL database:
 * PROJECT_GROUP_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5441/group_review \
 * pnpm exec vitest run src/__tests__/integration/project-implicit-admin.database.integration.test.ts
 *
 * Only the Prisma singleton and request-auth resolution are injected. The
 * generated client, authorization, SQL discovery, previews, member mutations,
 * notification/search services, event bus and SSE route are production code.
 * Each case owns unique tenants; no migration is run or modified.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { NextRequest } from "next/server";
// Bypass Vitest's generated-client alias, which is a unit-test stub.
import { PrismaClient } from "../../generated/prisma/client";
import type { AgentAuthContext, AuthContext } from "@/types/auth";
import type { ProjectAccessClient } from "@/services/project-access.service";
import type { ProjectAccessChangedEvent } from "@/lib/event-bus";

const state = vi.hoisted(() => ({ db: null as unknown, auth: null as AuthContext | null }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAuthContext: async () => state.auth,
}));

const url = process.env.PROJECT_GROUP_DATABASE_URL;
const migrationName = "20261001053611_add_private_project_access";
const migrationFile = new URL(`../../../prisma/migrations/${migrationName}/migration.sql`, import.meta.url);
const createDatabase = (pool: pg.Pool) => new PrismaClient({
  adapter: new PrismaPg(pool), log: [{ emit: "event", level: "query" }],
});

describe.skipIf(!url)("lazy implicit project Admin — real PostgreSQL acceptance", () => {
  let db: ReturnType<typeof createDatabase>;
  let pool: pg.Pool;
  let accessClient: ProjectAccessClient;
  let access: typeof import("@/services/project-access.service");
  let implicit: typeof import("@/services/project-group-implicit-admin.service");
  let projects: typeof import("@/services/project.service");
  let members: typeof import("@/services/project-member.service");
  let previews: typeof import("@/services/project-access-preview.service");
  let movePreviews: typeof import("@/services/project-group-preview.service");
  let groups: typeof import("@/services/project-group.service");
  let notifications: typeof import("@/services/notification.service");
  let search: typeof import("@/services/search.service");
  let eventsRoute: typeof import("@/app/api/events/route");
  let eventBus: typeof import("@/lib/event-bus").eventBus;
  let tenantTables: string[];
  let migrationBefore: unknown[];
  let migrationChecksum: string;
  const queries: string[] = [];
  let companyUuid: string;
  let foreignCompanyUuid: string;
  let emptyCompanyUuid: string;
  let token: string;
  let ids: Record<"first" | "next" | "later" | "foreign" | "ownedAgent" | "ownerlessAgent", string>;

  const actor = (key: "first" | "next" | "later" = "first"): AuthContext => ({
    type: "user", actorUuid: ids[key], companyUuid,
  });
  const foreignActor = (): AuthContext => ({
    type: "user", actorUuid: ids.foreign, companyUuid: foreignCompanyUuid,
  });
  const agent = (owned = true): AgentAuthContext => ({
    type: "agent", actorUuid: owned ? ids.ownedAgent : ids.ownerlessAgent,
    companyUuid, ownerUuid: owned ? ids.first : undefined,
    roles: ["admin_agent"], permissions: ["project:read", "project:admin", "task:read"],
    agentName: token,
  });
  const superAdmin = (): AuthContext => ({
    type: "super_admin", actorUuid: ids.first, companyUuid,
  });
  async function project(
    visibility = "private", groupUuid: string | null = null, tenant = companyUuid,
  ) {
    return db.project.create({ data: {
      companyUuid: tenant, name: `${token} project`, visibility, groupUuid, createdByUuid: null,
    } });
  }
  async function group(tenant = companyUuid) {
    return db.projectGroup.create({ data: {
      companyUuid: tenant, name: `${token} group`, visibility: "private",
      createdByUuid: null, accessVersion: 0,
    } });
  }
  async function snapshot() {
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const sql = tenantTables.map((table) => `
      SELECT '${table.replaceAll("'", "''")}' AS name,
        COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows
      FROM ${quote(table)} AS t WHERE "companyUuid" = ANY($1::text[])
    `).join(" UNION ALL ");
    const companies = await pool.query(
      'SELECT * FROM "Company" WHERE uuid = ANY($1::text[]) ORDER BY uuid',
      [[companyUuid, foreignCompanyUuid, emptyCompanyUuid]],
    );
    const tables = await pool.query(sql, [[companyUuid, foreignCompanyUuid, emptyCompanyUuid]]);
    return { companies: companies.rows, tables: tables.rows };
  }
  async function withoutWrites(read: () => Promise<void>) {
    const before = await snapshot();
    queries.length = 0;
    await read();
    expect(queries.filter((query) =>
      /^\s*(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(query),
    )).toEqual([]);
    expect(await snapshot()).toEqual(before);
  }
  async function eventually(predicate: () => boolean) {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(predicate()).toBe(true);
  }
  async function openStream(auth: AuthContext) {
    state.auth = auth;
    const abort = new AbortController();
    // Invoke the actual route's heartbeat without replacing PostgreSQL timers.
    const originalInterval = globalThis.setInterval;
    let heartbeat = () => {};
    const timerSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay, ...args) => {
      if (delay === 30_000 && typeof callback === "function") heartbeat = () => callback(...args);
      return originalInterval(callback, delay, ...args);
    });
    let response: Response;
    try {
      response = await eventsRoute.GET(new NextRequest("http://localhost/api/events", { signal: abort.signal }));
    } finally { timerSpy.mockRestore(); }
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
      } catch { /* Cancelled during cleanup. */ }
    })();
    return {
      heartbeat,
      events: () => chunks.join("").split("\n\n").filter((chunk) => chunk.startsWith("data: "))
        .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>),
      async close() { abort.abort(); await reader.cancel(); await pump; },
    };
  }
  function emitTask(projectUuid: string, entityUuid: string) {
    eventBus.emitChange({
      companyUuid, projectUuid, entityType: "task", entityUuid, action: "updated",
    });
  }

  beforeAll(async () => {
    const target = new URL(url!);
    // A supplied URL never authorizes another database, even another localhost DB.
    expect(target.protocol).toMatch(/^postgres(ql)?:$/);
    expect(target.hostname).toBe("127.0.0.1");
    expect(target.port).toBe("5441");
    expect(target.pathname).toBe("/group_review");
    expect(target.username).toBe("postgres");
    expect(target.password).toBe("postgres");
    expect(target.search).toBe("");
    // The real event bus must stay local; a developer's Redis is not a test target.
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("REDIS_HOST", "");
    pool = new pg.Pool({ connectionString: url, max: 8 });
    expect((await pool.query("SELECT current_database() AS name")).rows).toEqual([{ name: "group_review" }]);
    migrationChecksum = createHash("sha256").update(await readFile(migrationFile)).digest("hex");
    migrationBefore = (await pool.query(
      'SELECT * FROM "_prisma_migrations" WHERE migration_name = $1 ORDER BY started_at',
      [migrationName],
    )).rows;
    expect(migrationBefore).toEqual([
      expect.objectContaining({ checksum: migrationChecksum, finished_at: expect.any(Date), rolled_back_at: null }),
    ]);
    db = createDatabase(pool);
    accessClient = db as unknown as ProjectAccessClient;
    db.$on("query", (event) => queries.push(event.query));
    state.db = db;
    implicit = await import("@/services/project-group-implicit-admin.service");
    access = await import("@/services/project-access.service");
    projects = await import("@/services/project.service");
    members = await import("@/services/project-member.service");
    previews = await import("@/services/project-access-preview.service");
    movePreviews = await import("@/services/project-group-preview.service");
    groups = await import("@/services/project-group.service");
    notifications = await import("@/services/notification.service");
    search = await import("@/services/search.service");
    eventsRoute = await import("@/app/api/events/route");
    ({ eventBus } = await import("@/lib/event-bus"));
    tenantTables = (await pool.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'companyUuid' ORDER BY table_name
    `)).rows.map((row) => row.table_name);
    expect(tenantTables).toEqual(expect.arrayContaining(["User", "Project", "ProjectMember", "ProjectGroupMember"]));
  }, 30_000);

  beforeEach(async () => {
    companyUuid = randomUUID(); foreignCompanyUuid = randomUUID(); emptyCompanyUuid = randomUUID();
    token = `lazy-project-${randomUUID()}`;
    ids = {
      first: randomUUID(), next: randomUUID(), later: randomUUID(), foreign: randomUUID(),
      ownedAgent: randomUUID(), ownerlessAgent: randomUUID(),
    };
    for (const uuid of [companyUuid, foreignCompanyUuid, emptyCompanyUuid]) {
      await db.company.create({ data: { uuid, name: token } });
    }
    // Earliest id is "later"; equal earliest createdAt is resolved by first/next id.
    for (const [key, createdAt] of [
      ["later", "2025-02-01"], ["first", "2025-01-01"], ["next", "2025-01-01"], ["foreign", "2020-01-01"],
    ] as const) {
      await db.user.create({ data: {
        uuid: ids[key], companyUuid: key === "foreign" ? foreignCompanyUuid : companyUuid,
        oidcSub: ids[key], name: key, email: `${key}-${token}@example.test`, createdAt: new Date(createdAt),
      } });
    }
    await db.agent.create({ data: { uuid: ids.ownedAgent, companyUuid, name: token, ownerUuid: ids.first } });
    await db.agent.create({ data: { uuid: ids.ownerlessAgent, companyUuid, name: token, roles: ["admin_agent"] } });
  });

  afterEach(async () => {
    state.auth = null;
    if (!db || !companyUuid) return;
    for (const uuid of [companyUuid, foreignCompanyUuid, emptyCompanyUuid]) {
      const tenant = { companyUuid: uuid };
      await db.notification.deleteMany({ where: tenant });
      await db.activity.deleteMany({ where: tenant });
      await db.comment.deleteMany({ where: tenant });
      await db.task.deleteMany({ where: tenant });
      await db.projectVisit.deleteMany({ where: tenant });
      await db.projectAgentCwdPreference.deleteMany({ where: tenant });
      // Explicitly clean orphan grant rows too: the database has relationMode=prisma.
      await db.projectMember.deleteMany({ where: tenant });
      await db.project.deleteMany({ where: tenant });
      await db.projectGroupMember.deleteMany({ where: tenant });
      await db.projectGroup.deleteMany({ where: tenant });
      await db.agent.deleteMany({ where: tenant });
      await db.user.deleteMany({ where: tenant });
      await db.company.deleteMany({ where: { uuid } });
      expect(await db.company.count({ where: { uuid } })).toBe(0);
    }
  }, 30_000);

  afterAll(async () => {
    try {
      if (pool && migrationBefore) {
        expect((await pool.query(
          'SELECT * FROM "_prisma_migrations" WHERE migration_name = $1 ORDER BY started_at', [migrationName],
        )).rows).toEqual(migrationBefore);
        expect(createHash("sha256").update(await readFile(migrationFile)).digest("hex")).toBe(migrationChecksum);
      }
    } finally {
      await db?.$disconnect();
      await pool?.end();
      vi.unstubAllEnvs();
    }
  });

  it("selects earliest createdAt/id for private unowned projects without backfill, and fails closed across tenants", async () => {
    const unowned = await project();
    const foreign = await project("private", null, foreignCompanyUuid);
    const empty = await project("private", null, emptyCompanyUuid);
    expect((await db.user.findMany({
      where: { companyUuid }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })).map((row) => row.uuid)).toEqual([ids.first, ids.next, ids.later]);
    await withoutWrites(async () => {
      expect(await implicit.implicitProjectAdmin(companyUuid, unowned.uuid, accessClient)).toBe(ids.first);
      expect(await implicit.implicitProjectAdmin(companyUuid, unowned.uuid)).toBe(ids.first);
      expect(await implicit.implicitProjectAdmin(companyUuid, randomUUID(), accessClient)).toBeNull();
      expect(await implicit.implicitProjectAdmin(companyUuid, foreign.uuid, accessClient)).toBeNull();
      expect(await implicit.implicitProjectAdmin(emptyCompanyUuid, empty.uuid, accessClient)).toBeNull();
      expect(await implicit.implicitProjectAdmin(foreignCompanyUuid, foreign.uuid, accessClient)).toBe(ids.foreign);
      expect((await access.computeProjectAccess(actor(), unowned.uuid)).level).toBe("admin");
      expect((await access.requireProjectOperation(actor(), unowned.uuid, "manage_members")).accessLevel).toBe("admin");
      expect((await access.computeProjectAccess(actor("next"), unowned.uuid)).project).toBeNull();
      expect((await access.computeProjectAccess(actor(), foreign.uuid)).project).toBeNull();
      expect((await access.computeProjectAccess(foreignActor(), unowned.uuid)).project).toBeNull();
      expect(await access.accessibleProjectUuids(actor())).toEqual([unowned.uuid]);
      expect(await access.accessibleProjectUuids(actor("next"))).toEqual([]);
      expect(await access.accessibleProjectUuids(foreignActor())).toEqual([foreign.uuid]);
      expect(await projects.listProjects({ companyUuid, auth: actor(), skip: 0, take: 100 })).toMatchObject({
        total: 1, projects: [expect.objectContaining({ uuid: unowned.uuid })],
      });
      expect(await db.projectMember.count({ where: { companyUuid } })).toBe(0);
      expect(await db.project.findUniqueOrThrow({ where: { uuid: unowned.uuid } })).toMatchObject({
        createdByUuid: null, groupUuid: null, visibility: "private",
      });
    });
  });

  it("owned agents inherit fallback while ownerless Admin agents and super admins gain no private content", async () => {
    const unowned = await project();
    await withoutWrites(async () => {
      expect((await access.computeProjectAccess(agent(), unowned.uuid)).level).toBe("admin");
      for (const context of [agent(false), superAdmin()]) {
        expect(await access.computeProjectAccess(context, unowned.uuid)).toEqual({ project: null, level: "none" });
        expect(await access.accessibleProjectUuids(context)).toEqual([]);
      }
      expect(await access.accessibleProjectUuids(agent())).toEqual([unowned.uuid]);
      expect(await access.canActorAccessProject(companyUuid, { type: "agent", uuid: ids.ownedAgent }, unowned.uuid, "admin")).toBe(true);
      expect(await access.canActorAccessProject(companyUuid, { type: "agent", uuid: ids.ownerlessAgent }, unowned.uuid, "viewer")).toBe(false);
      expect(await access.privateProjectMemberUuids(companyUuid, unowned.uuid)).toEqual([ids.first]);
    });
  });

  it("presents a synthetic local Admin roster without inserting a membership", async () => {
    const unowned = await project();
    await withoutWrites(async () => {
      const rows = await members.listMembers(actor(), unowned.uuid);
      expect(rows).toEqual([expect.objectContaining({
        userUuid: ids.first, name: "first", role: "admin", source: "project",
        directRole: null, inheritedRole: null, effectiveRole: "admin", implicit: true, automaticAdmin: true,
      })]);
      expect(await db.projectMember.count({ where: { projectUuid: unowned.uuid } })).toBe(0);
      await expect(members.removeMember(actor(), unowned.uuid, ids.first)).rejects.toMatchObject({ status: 400 });
    });
  });

  it("overlays the first user's stored Viewer role and preserves the row identity, role and creator", async () => {
    const unowned = await project();
    await db.project.update({ where: { uuid: unowned.uuid }, data: { createdByUuid: ids.later } });
    const viewer = await db.projectMember.create({ data: {
      companyUuid, projectUuid: unowned.uuid, userUuid: ids.first, role: "viewer", addedByUuid: ids.later,
    } });
    await withoutWrites(async () => {
      expect((await access.computeProjectAccess(actor(), unowned.uuid)).level).toBe("admin");
      expect(await members.listMembers(actor(), unowned.uuid)).toEqual([expect.objectContaining({
        uuid: viewer.uuid, userUuid: ids.first, role: "admin", source: "project",
        directRole: "viewer", inheritedRole: null, effectiveRole: "admin", implicit: true, automaticAdmin: true,
      })]);
      expect(await db.projectMember.findUniqueOrThrow({ where: { uuid: viewer.uuid } })).toEqual(viewer);
      expect((await db.project.findUniqueOrThrow({ where: { uuid: unowned.uuid } })).createdByUuid).toBe(ids.later);
    });
  });

  it("an explicit local Admin suppresses fallback without changing existing local Viewer authority", async () => {
    const unowned = await project();
    const viewer = await db.projectMember.create({ data: {
      companyUuid, projectUuid: unowned.uuid, userUuid: ids.first, role: "viewer",
    } });
    const admin = await db.projectMember.create({ data: {
      companyUuid, projectUuid: unowned.uuid, userUuid: ids.next, role: "admin",
    } });
    await withoutWrites(async () => {
      expect(await implicit.implicitProjectAdmin(companyUuid, unowned.uuid, accessClient)).toBeNull();
      expect((await access.computeProjectAccess(actor(), unowned.uuid)).level).toBe("viewer");
      expect((await access.computeProjectAccess(actor("next"), unowned.uuid)).level).toBe("admin");
      await expect(access.requireProjectOperation(actor(), unowned.uuid, "manage_members")).rejects.toMatchObject({ status: 403 });
      const rows = await members.listMembers(actor(), unowned.uuid);
      expect(rows.find((row) => row.userUuid === ids.first)).toMatchObject({ uuid: viewer.uuid, role: "viewer" });
      expect(rows.find((row) => row.userUuid === ids.next)).toMatchObject({ uuid: admin.uuid, role: "admin" });
      expect(rows.some((row) => row.implicit || row.automaticAdmin)).toBe(false);
      expect(await db.projectMember.findUniqueOrThrow({ where: { uuid: viewer.uuid } })).toEqual(viewer);
    });
    await db.projectMember.delete({ where: { uuid: admin.uuid } });
    await withoutWrites(async () => {
      expect(await implicit.implicitProjectAdmin(companyUuid, unowned.uuid, accessClient)).toBe(ids.first);
      expect((await access.computeProjectAccess(actor(), unowned.uuid)).level).toBe("admin");
      expect(await db.projectMember.findUniqueOrThrow({ where: { uuid: viewer.uuid } })).toEqual(viewer);
    });
  });

  it("a live same-company group supplies Admin and never adds company-first Admin beside another explicit group Admin", async () => {
    const automatic = await group();
    const explicit = await group();
    const inherited = await project("private", automatic.uuid);
    const suppressed = await project("private", explicit.uuid);
    await db.projectGroupMember.create({ data: {
      companyUuid, groupUuid: explicit.uuid, userUuid: ids.next, role: "admin",
    } });
    await withoutWrites(async () => {
      expect(await implicit.implicitProjectAdmin(companyUuid, inherited.uuid, accessClient)).toBeNull();
      expect(await implicit.implicitProjectAdmin(companyUuid, suppressed.uuid, accessClient)).toBeNull();
      expect((await access.computeProjectAccess(actor(), inherited.uuid)).level).toBe("admin");
      expect((await access.computeProjectAccess(actor(), suppressed.uuid)).project).toBeNull();
      expect((await access.computeProjectAccess(actor("next"), suppressed.uuid)).level).toBe("admin");
      expect(await access.accessibleProjectUuids(actor())).toEqual([inherited.uuid]);
      expect(await access.privateProjectMemberUuids(companyUuid, suppressed.uuid)).toEqual([ids.next]);
      expect(await members.listMembers(actor("next"), suppressed.uuid)).toEqual([
        expect.objectContaining({ userUuid: ids.next, role: "admin", source: "group" }),
      ]);
      expect(await db.projectMember.count({ where: { companyUuid } })).toBe(0);
    });
  });

  it("missing and foreign group references act as ungrouped projects in both SQL and direct access, without foreign grant leakage", async () => {
    const foreignGroup = await group(foreignCompanyUuid);
    await db.projectGroupMember.create({ data: {
      companyUuid: foreignCompanyUuid, groupUuid: foreignGroup.uuid, userUuid: ids.foreign, role: "admin",
    } });
    const missing = await project("private", randomUUID());
    const foreignReference = await project("private", foreignGroup.uuid);
    const foreignProject = await project("private", foreignGroup.uuid, foreignCompanyUuid);
    await withoutWrites(async () => {
      const wanted = [missing.uuid, foreignReference.uuid].sort();
      for (const row of [missing, foreignReference]) {
        expect(await implicit.implicitProjectAdmin(companyUuid, row.uuid, accessClient)).toBe(ids.first);
        expect((await access.computeProjectAccess(actor(), row.uuid)).level).toBe("admin");
        expect((await access.computeProjectAccess(actor("next"), row.uuid)).project).toBeNull();
        expect((await access.computeProjectAccess(foreignActor(), row.uuid)).project).toBeNull();
        expect(await access.privateProjectMemberUuids(companyUuid, row.uuid)).toEqual([ids.first]);
        expect(await access.filterRecipientsByProjectAccess(companyUuid, row.uuid, [
          { type: "user", uuid: ids.first }, { type: "user", uuid: ids.foreign },
        ])).toEqual([{ type: "user", uuid: ids.first }]);
      }
      expect((await access.accessibleProjectUuids(actor())).sort()).toEqual(wanted);
      expect((await db.project.findMany({ where: await access.accessibleProjectWhere(actor()) })).map((row) => row.uuid).sort()).toEqual(wanted);
      expect(await access.accessibleProjectUuids(actor("next"))).toEqual([]);
      expect(await access.accessibleProjectUuids(foreignActor())).toEqual([foreignProject.uuid]);
      const listed = await projects.listProjects({ companyUuid, auth: actor(), skip: 0, take: 100 });
      expect(listed.total).toBe(2);
      expect(listed.projects.map((row) => row.uuid).sort()).toEqual(wanted);
      expect((await search.search({ companyUuid, auth: actor(), query: token, entityTypes: ["project"] }))
        .results.map((row) => row.uuid).sort()).toEqual(wanted);
      expect(await implicit.implicitProjectAdminUuids(companyUuid)).toEqual(expect.arrayContaining(wanted));
    });
  });

  it("real notification filters, stored notification lists and search follow lazy access and explicit Admin suppression", async () => {
    const unowned = await project();
    const task = await db.task.create({ data: {
      companyUuid, projectUuid: unowned.uuid, title: token, createdByUuid: ids.later,
    } });
    const recipients = [
      { type: "user", uuid: ids.first }, { type: "user", uuid: ids.next },
      { type: "agent", uuid: ids.ownedAgent }, { type: "agent", uuid: ids.ownerlessAgent },
    ];
    const pending = recipients.map((recipient) => ({
      companyUuid, projectUuid: unowned.uuid, recipientType: recipient.type, recipientUuid: recipient.uuid,
      entityType: "task", entityUuid: task.uuid, entityTitle: token, projectName: unowned.name,
      action: "task_assigned", message: token, actorType: "user", actorUuid: ids.later, actorName: "later",
    }));
    // Stale outsider notifications are deliberate: list/count must re-check current access.
    await db.notification.createMany({ data: pending });
    async function assertDiscovery(context: AuthContext, allowed: boolean) {
      expect(await notifications.list({
        companyUuid, recipientType: context.type, recipientUuid: context.actorUuid, auth: context,
      })).toMatchObject({
        total: allowed ? 1 : 0, unreadCount: allowed ? 1 : 0,
        notifications: allowed ? [expect.objectContaining({ entityUuid: task.uuid })] : [],
      });
      expect((await search.search({
        companyUuid, auth: context, query: token, entityTypes: ["project", "task"],
      })).results.map((row) => row.uuid).sort()).toEqual(allowed ? [unowned.uuid, task.uuid].sort() : []);
    }
    await withoutWrites(async () => {
      expect(await access.filterRecipientsByProjectAccess(companyUuid, unowned.uuid, recipients)).toEqual([recipients[0], recipients[2]]);
      expect(await notifications.filterNotificationsByProjectAccess(pending)).toEqual([pending[0], pending[2]]);
      await assertDiscovery(actor(), true);
      await assertDiscovery(agent(), true);
      await assertDiscovery(actor("next"), false);
      await assertDiscovery(agent(false), false);
    });
    await db.projectMember.create({ data: {
      companyUuid, projectUuid: unowned.uuid, userUuid: ids.next, role: "admin",
    } });
    await withoutWrites(async () => {
      expect(await access.filterRecipientsByProjectAccess(companyUuid, unowned.uuid, recipients)).toEqual([recipients[1]]);
      expect(await notifications.filterNotificationsByProjectAccess(pending)).toEqual([pending[1]]);
      expect(await access.privateProjectMemberUuids(companyUuid, unowned.uuid)).toEqual([ids.next]);
      await assertDiscovery(actor(), false);
      await assertDiscovery(agent(), false);
      await assertDiscovery(actor("next"), true);
      await assertDiscovery(agent(false), false);
    });
  });

  it("visibility previews retain the implicit Admin over a stored Viewer without modifying membership", async () => {
    const unowned = await project("public");
    const viewer = await db.projectMember.create({ data: {
      companyUuid, projectUuid: unowned.uuid, userUuid: ids.first, role: "viewer",
    } });
    await withoutWrites(async () => {
      const preview = await previews.getProjectVisibilityPreview(actor(), unowned.uuid, "private");
      expect(preview.changes.map((row) => row.userUuid).sort()).toEqual([ids.next, ids.later].sort());
      expect(preview.changes.every((row) => row.beforeRole === "editor" && row.afterRole === "none")).toBe(true);
      expect(preview.summary).toMatchObject({
        affectedUserCount: 2, lostAccessCount: 2, decreasedPermissionsCount: 0, affectedProjectCount: 1,
      });
      expect(await db.projectMember.findUniqueOrThrow({ where: { uuid: viewer.uuid } })).toEqual(viewer);
    });
  });

  it("real notification creation persists and emits only for currently authorized recipients", async () => {
    const unowned = await project();
    const task = await db.task.create({ data: {
      companyUuid, projectUuid: unowned.uuid, title: token, createdByUuid: ids.later,
    } });
    const recipients = [
      { type: "user", uuid: ids.first }, { type: "user", uuid: ids.next },
      { type: "agent", uuid: ids.ownedAgent }, { type: "agent", uuid: ids.ownerlessAgent },
    ];
    const pending = recipients.map((recipient) => ({
      companyUuid, projectUuid: unowned.uuid, recipientType: recipient.type, recipientUuid: recipient.uuid,
      entityType: "task", entityUuid: task.uuid, entityTitle: token, projectName: unowned.name,
      action: "comment_added", message: token, actorType: "user", actorUuid: ids.later, actorName: "later",
    }));
    const delivered: string[] = [];
    const listeners = recipients.map((recipient) => {
      const channel = `notification:${recipient.type}:${recipient.uuid}`;
      const listener = (event: { projectUuid?: string }) => {
        if (event.projectUuid === unowned.uuid) delivered.push(recipient.uuid);
      };
      eventBus.on(channel, listener);
      return { channel, listener };
    });
    try {
      expect((await notifications.createBatch(pending)).map((row) => row.recipientUuid).sort())
        .toEqual([ids.first, ids.ownedAgent].sort());
      expect(delivered.sort()).toEqual([ids.first, ids.ownedAgent].sort());
      await db.projectMember.create({ data: {
        companyUuid, projectUuid: unowned.uuid, userUuid: ids.next, role: "admin",
      } });
      delivered.length = 0;
      expect((await notifications.createBatch(pending)).map((row) => row.recipientUuid)).toEqual([ids.next]);
      expect(delivered).toEqual([ids.next]);
      const rows = await db.notification.findMany({ where: { companyUuid, projectUuid: unowned.uuid } });
      expect(rows.map((row) => row.recipientUuid).sort()).toEqual([ids.first, ids.ownedAgent, ids.next].sort());
      expect(await db.daemonSession.count({ where: { companyUuid } })).toBe(0);
    } finally {
      for (const { channel, listener } of listeners) eventBus.off(channel, listener);
    }
  });

  it("first-user deletion transfers private Admin and rejects old visibility confirmation with 403/409", async () => {
    const privateProject = await project();
    const publicProject = await project("public");
    const preview = await previews.getProjectVisibilityPreview(actor(), publicProject.uuid, "private");
    await db.agent.update({ where: { uuid: ids.ownedAgent }, data: { ownerUuid: null } });
    await db.user.delete({ where: { uuid: ids.first } });
    await withoutWrites(async () => {
      expect(await implicit.implicitProjectAdmin(companyUuid, privateProject.uuid, accessClient)).toBe(ids.next);
      expect((await access.computeProjectAccess(actor("next"), privateProject.uuid)).level).toBe("admin");
      expect((await access.computeProjectAccess(actor(), privateProject.uuid)).project).toBeNull();
      expect((await previews.getProjectVisibilityPreview(actor("next"), publicProject.uuid, "private")).confirmationToken)
        .not.toBe(preview.confirmationToken);
      await expect(members.setVisibility(actor(), publicProject.uuid, "private", preview.confirmationToken))
        .rejects.toMatchObject({ status: 403 });
      await expect(members.setVisibility(actor("next"), publicProject.uuid, "private", preview.confirmationToken))
        .rejects.toMatchObject({ status: 409 });
      expect(await db.projectMember.count({ where: { companyUuid } })).toBe(0);
    });
  });

  it("move confirmation fingerprints fallback identity even when the actor, roster and project rows stay identical", async () => {
    const unowned = await project("public");
    const before = await movePreviews.getProjectGroupMovePreview(actor("later"), unowned.uuid, null);
    const rowBefore = await db.project.findUniqueOrThrow({ where: { uuid: unowned.uuid } });
    await db.user.update({ where: { uuid: ids.first }, data: { createdAt: new Date("2025-01-02") } });
    await withoutWrites(async () => {
      expect(await implicit.implicitProjectAdmin(companyUuid, unowned.uuid, accessClient)).toBe(ids.next);
      const after = await movePreviews.getProjectGroupMovePreview(actor("later"), unowned.uuid, null);
      expect(after.changes).toEqual(before.changes);
      expect(after.confirmationToken).not.toBe(before.confirmationToken);
      await expect(groups.moveProjectToGroup(companyUuid, unowned.uuid, null, actor("later"), before.confirmationToken))
        .rejects.toMatchObject({ status: 409 });
      expect(await db.project.findUniqueOrThrow({ where: { uuid: unowned.uuid } })).toEqual(rowBefore);
    });
  });

  it("adding the first explicit Admin through the real mutation revokes old user and owned-agent SSE streams", async () => {
    const unowned = await project();
    const streams: Awaited<ReturnType<typeof openStream>>[] = [];
    const changes: ProjectAccessChangedEvent[] = [];
    const onAccess = (event: ProjectAccessChangedEvent) => {
      if (event.companyUuid === companyUuid) changes.push(event);
    };
    try {
      const old = await openStream(actor()); streams.push(old);
      const owned = await openStream(agent()); streams.push(owned);
      const next = await openStream(actor("next")); streams.push(next);
      const ownerless = await openStream(agent(false)); streams.push(ownerless);
      emitTask(unowned.uuid, "before-explicit-admin");
      await eventually(() => old.events().some((event) => event.entityUuid === "before-explicit-admin")
        && owned.events().some((event) => event.entityUuid === "before-explicit-admin"));
      expect(next.events()).toEqual([]);
      expect(ownerless.events()).toEqual([]);
      eventBus.on("project_access_changed", onAccess);
      await members.addMember(actor(), unowned.uuid, ids.next, "admin");
      // Emit immediately after commit: the SSE gate must wait for fresh authority.
      emitTask(unowned.uuid, "after-explicit-admin");
      await eventually(() => next.events().some((event) => event.entityUuid === "after-explicit-admin"));
      expect(old.events().some((event) => event.entityUuid === "after-explicit-admin")).toBe(false);
      expect(owned.events().some((event) => event.entityUuid === "after-explicit-admin")).toBe(false);
      expect(ownerless.events()).toEqual([]);
      expect(changes).toHaveLength(1);
      expect(changes[0].projectUuid).toBe(unowned.uuid);
      expect(changes[0].userUuids.length === 0 || changes[0].userUuids.includes(ids.first)).toBe(true);
      await withoutWrites(async () => {
        expect((await access.computeProjectAccess(actor(), unowned.uuid)).project).toBeNull();
        expect((await access.computeProjectAccess(agent(), unowned.uuid)).project).toBeNull();
        expect(await members.listMembers(actor("next"), unowned.uuid)).toEqual([
          expect.objectContaining({ userUuid: ids.next, role: "admin" }),
        ]);
      });
      expect(await db.projectMember.findMany({ where: { projectUuid: unowned.uuid } })).toEqual([
        expect.objectContaining({ userUuid: ids.next, role: "admin" }),
      ]);
      expect(await db.activity.count({ where: { companyUuid, targetUuid: unowned.uuid, action: "project_member_added" } })).toBe(1);
    } finally {
      eventBus.off("project_access_changed", onAccess);
      await Promise.all(streams.map((stream) => stream.close()));
    }
  });

  it("first-user deletion heartbeat transfers private project SSE delivery without writes or broadcasts", async () => {
    const unowned = await project();
    const streams: Awaited<ReturnType<typeof openStream>>[] = [];
    const refresh = vi.spyOn(access, "accessibleProjectUuids");
    const publication = vi.spyOn(eventBus, "emitProjectAccessChanged");
    try {
      const old = await openStream(actor()); streams.push(old);
      const next = await openStream(actor("next")); streams.push(next);
      emitTask(unowned.uuid, "before-first-delete");
      await eventually(() => old.events().some((event) => event.entityUuid === "before-first-delete"));
      expect(next.events()).toEqual([]);
      await db.agent.update({ where: { uuid: ids.ownedAgent }, data: { ownerUuid: null } });
      await db.user.delete({ where: { uuid: ids.first } });
      await withoutWrites(async () => {
        for (const stream of streams) stream.heartbeat();
        await eventually(() => refresh.mock.calls.length >= 4);
        await Promise.all(refresh.mock.results.map((result) => result.value));
        for (let i = 0; i < 25; i++) await Promise.resolve();
        expect(publication).not.toHaveBeenCalled();
        emitTask(unowned.uuid, "after-first-delete");
        await eventually(() => next.events().some((event) => event.entityUuid === "after-first-delete"));
        expect(old.events().some((event) => event.entityUuid === "after-first-delete")).toBe(false);
        expect(await db.projectMember.count({ where: { companyUuid } })).toBe(0);
      });
    } finally {
      await Promise.all(streams.map((stream) => stream.close()));
      refresh.mockRestore(); publication.mockRestore();
    }
  });

  it.each(["remove", "demote"] as const)("keeps the last explicit local Admin %s guard at 400 despite lazy fallback eligibility", async (mutation) => {
    const unowned = await project();
    const admin = await db.projectMember.create({ data: {
      companyUuid, projectUuid: unowned.uuid, userUuid: ids.next, role: "admin",
    } });
    const before = await snapshot();
    const changes: ProjectAccessChangedEvent[] = [];
    const onAccess = (event: ProjectAccessChangedEvent) => {
      if (event.companyUuid === companyUuid) changes.push(event);
    };
    eventBus.on("project_access_changed", onAccess);
    try {
      await expect(mutation === "remove"
        ? members.removeMember(actor("next"), unowned.uuid, ids.next)
        : members.updateMemberRole(actor("next"), unowned.uuid, ids.next, "viewer"))
        .rejects.toMatchObject({ name: "LastAdminError", status: 400 });
      expect(await snapshot()).toEqual(before);
      expect(await db.projectMember.findUniqueOrThrow({ where: { uuid: admin.uuid } })).toEqual(admin);
      expect(changes).toEqual([]);
      expect(await implicit.implicitProjectAdmin(companyUuid, unowned.uuid, accessClient)).toBeNull();
    } finally {
      eventBus.off("project_access_changed", onAccess);
    }
  });
});
