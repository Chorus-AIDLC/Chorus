/**
 * Opt-in end-to-end test of private-project access control against a REAL,
 * migrated PostgreSQL database. Use ONLY an isolated test database:
 *
 *   PRIVATE_PROJECT_DATABASE_URL=postgresql://chorus:chorus@localhost:5544/chorus \
 *     npx vitest run src/__tests__/integration/private-project-access.database.integration.test.ts
 *
 * Without the env var the whole suite is skipped. The test creates its own
 * company (random UUIDs) and deletes only rows belonging to that company.
 *
 * Only two things are faked: request auth resolution (`getAuthContext` returns
 * the current actor) and the event bus (a plain in-process EventEmitter instead
 * of the Redis-capable singleton). Everything else — REST route handlers, MCP
 * server + tools, services, notification listener, SSE route, Prisma — is real.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
// Relative import: the "@/generated/prisma/client" alias points at a test stub.
import { PrismaClient } from "../../generated/prisma/client";
import type { AgentAuthContext, AuthContext } from "@/types/auth";

const state = vi.hoisted(() => ({ db: null as unknown, auth: null as unknown }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthContext: async () => state.auth };
});
const { bus } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  class TestBus extends EventEmitter {
    emitChange(event: unknown) { this.emit("change", event); }
    emitPresence(event: unknown) { this.emit("presence", event); }
    emitProjectAccessChanged(event: unknown) { this.emit("project_access_changed", event); }
  }
  const b = new TestBus();
  b.setMaxListeners(0);
  return { bus: b };
});
vi.mock("@/lib/event-bus", () => ({
  eventBus: bus,
  controlEventName: (id: string) => `control:${id}`,
}));

type Json = Record<string, unknown>;
const url = process.env.PRIVATE_PROJECT_DATABASE_URL;

describe.skipIf(!url)("Private project access — real database end-to-end", () => {
  let db: PrismaClient;
  let pool: pg.Pool;

  // Modules under test (imported after mocks + db are wired).
  let projectService: typeof import("@/services/project.service");
  let memberService: typeof import("@/services/project-member.service");
  let previewService: typeof import("@/services/project-access-preview.service");
  let searchService: typeof import("@/services/search.service");
  let groupService: typeof import("@/services/project-group.service");
  let visitService: typeof import("@/services/project-visit.service");
  let assignmentService: typeof import("@/services/assignment.service");
  let createMcpServer: typeof import("@/mcp/server").createMcpServer;
  let routes: {
    projects: typeof import("@/app/api/projects/route");
    project: typeof import("@/app/api/projects/[uuid]/route");
    projectTasks: typeof import("@/app/api/projects/[uuid]/tasks/route");
    members: typeof import("@/app/api/projects/[uuid]/members/route");
    member: typeof import("@/app/api/projects/[uuid]/members/[userUuid]/route");
    task: typeof import("@/app/api/tasks/[uuid]/route");
    idea: typeof import("@/app/api/ideas/[uuid]/route");
    document: typeof import("@/app/api/documents/[uuid]/route");
    proposal: typeof import("@/app/api/proposals/[uuid]/route");
    approve: typeof import("@/app/api/proposals/[uuid]/approve/route");
    comments: typeof import("@/app/api/comments/route");
    search: typeof import("@/app/api/search/route");
    events: typeof import("@/app/api/events/route");
  };

  const token = `ppa${randomUUID().slice(0, 8)}`;
  const companyUuid = randomUUID();
  const U = { A: randomUUID(), E: randomUUID(), V: randomUUID(), N: randomUUID() };
  const AG = { E: randomUUID(), V: randomUUID(), N: randomUUID(), O: randomUUID() };
  let groupUuid: string;

  interface ProjectFixture {
    uuid: string; idea: string; task: string; document: string; proposal: string; comment: string;
  }
  let pub: ProjectFixture;
  let priv: ProjectFixture;
  // Extra private/public rows for specific scenarios.
  const extra = {} as Record<
    "privNotifyTask" | "pubNotifyTask" | "privVerifyTask" | "privMcpVerifyTask" | "privAssignTask" |
    "privTrackerN" | "privTrackerE" | "pubTrackerN" | "privMentionTask",
    string
  >;

  // ===== Actor contexts =====
  const ADMIN_PERMS = [
    "idea:read", "idea:write", "idea:admin", "proposal:read", "proposal:write", "proposal:admin",
    "document:read", "document:write", "document:admin", "task:read", "task:write", "task:admin",
    "project:read", "project:write", "project:admin",
  ] as AgentAuthContext["permissions"];
  const user = (uuid: string): AuthContext => ({ type: "user", companyUuid, actorUuid: uuid });
  const agent = (uuid: string, ownerUuid?: string): AgentAuthContext => ({
    type: "agent", companyUuid, actorUuid: uuid, ownerUuid, roles: ["admin_agent"],
    permissions: [...ADMIN_PERMS], agentName: `agent-${uuid.slice(0, 4)}`,
  });
  // Fresh object per call so the per-request access WeakMap cache never carries over.
  const actors = {
    A: () => user(U.A), E: () => user(U.E), V: () => user(U.V), N: () => user(U.N),
    agE: () => agent(AG.E, U.E), agV: () => agent(AG.V, U.V), agN: () => agent(AG.N, U.N), agO: () => agent(AG.O),
  };
  type ActorKey = keyof typeof actors;

  // ===== Route invocation =====
  type Handler<P> = (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>;
  async function call<P extends Record<string, string>>(
    actor: ActorKey, handler: Handler<P>, path: string, params: P, method = "GET", body?: unknown,
  ): Promise<{ status: number; json: Json }> {
    state.auth = actors[actor]();
    const req = new NextRequest(new URL(`http://localhost${path}`), {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
    });
    const res = await handler(req, { params: Promise.resolve(params) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {} };
  }
  const noParams = {} as Record<string, string>;

  // ===== MCP invocation through the real server factory + SDK client =====
  async function mcp(actor: "agE" | "agV" | "agN" | "agO", name: string, args: Json) {
    const server = createMcpServer(actors[actor]() as AgentAuthContext);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ppa-db-test", version: "1" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
      return { isError: res.isError === true, text };
    } finally {
      await client.close();
      await server.close();
    }
  }

  async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 8000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (ok(v)) return v;
      if (Date.now() - start > timeoutMs) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

  // ===== Fixture helpers =====
  async function seedEntities(projectUuid: string, label: string): Promise<Omit<ProjectFixture, "uuid">> {
    const idea = await db.idea.create({ data: {
      companyUuid, projectUuid, title: `${token} ${label} idea`, content: `${token} idea body`, createdByUuid: U.A,
    } });
    const task = await db.task.create({ data: {
      companyUuid, projectUuid, title: `${token} ${label} task`, createdByUuid: U.A,
    } });
    const document = await db.document.create({ data: {
      companyUuid, projectUuid, type: "prd", title: `${token} ${label} document`, content: `${token} doc`, createdByUuid: U.A,
    } });
    const proposal = await db.proposal.create({ data: {
      companyUuid, projectUuid, title: `${token} ${label} proposal`, inputType: "idea", inputUuids: [idea.uuid],
      status: "pending", createdByUuid: U.A, createdByType: "user",
    } });
    const comment = await db.comment.create({ data: {
      companyUuid, targetType: "task", targetUuid: task.uuid, content: `${token} seed comment`,
      authorType: "user", authorUuid: U.A,
    } });
    return { idea: idea.uuid, task: task.uuid, document: document.uuid, proposal: proposal.uuid, comment: comment.uuid };
  }
  async function extraTask(projectUuid: string, title: string, data: Json = {}) {
    return (await db.task.create({ data: {
      companyUuid, projectUuid, title: `${token} ${title}`, createdByUuid: U.A, ...data,
    } })).uuid;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;

    projectService = await import("@/services/project.service");
    memberService = await import("@/services/project-member.service");
    previewService = await import("@/services/project-access-preview.service");
    searchService = await import("@/services/search.service");
    groupService = await import("@/services/project-group.service");
    visitService = await import("@/services/project-visit.service");
    assignmentService = await import("@/services/assignment.service");
    await import("@/services/notification-listener"); // subscribes to "activity"
    ({ createMcpServer } = await import("@/mcp/server"));
    routes = {
      projects: await import("@/app/api/projects/route"),
      project: await import("@/app/api/projects/[uuid]/route"),
      projectTasks: await import("@/app/api/projects/[uuid]/tasks/route"),
      members: await import("@/app/api/projects/[uuid]/members/route"),
      member: await import("@/app/api/projects/[uuid]/members/[userUuid]/route"),
      task: await import("@/app/api/tasks/[uuid]/route"),
      idea: await import("@/app/api/ideas/[uuid]/route"),
      document: await import("@/app/api/documents/[uuid]/route"),
      proposal: await import("@/app/api/proposals/[uuid]/route"),
      approve: await import("@/app/api/proposals/[uuid]/approve/route"),
      comments: await import("@/app/api/comments/route"),
      search: await import("@/app/api/search/route"),
      events: await import("@/app/api/events/route"),
    };

    await db.company.create({ data: { uuid: companyUuid, name: `PPA integration ${token}` } });
    for (const [key, uuid] of Object.entries(U)) {
      await db.user.create({ data: {
        uuid, companyUuid, oidcSub: `ppa-${uuid}`, email: `${key.toLowerCase()}-${token}@example.test`, name: `User${key} ${token}`,
      } });
    }
    for (const [key, uuid] of Object.entries(AG)) {
      await db.agent.create({ data: {
        uuid, companyUuid, name: `Agent${key} ${token}`, roles: ["admin_agent"],
        ownerUuid: key === "O" ? null : U[key as "E" | "V" | "N"],
      } });
    }
    groupUuid = (await db.projectGroup.create({ data: { companyUuid, name: `${token} group` } })).uuid;

    // Projects via the real service: creator-admin membership + created Activity.
    const pubProject = await projectService.createProject({
      companyUuid, name: `${token} public project`, groupUuid, visibility: "public",
      createdByUuid: U.A, actor: { type: "user", uuid: U.A },
    });
    const privProject = await projectService.createProject({
      companyUuid, name: `${token} private project`, groupUuid, visibility: "private",
      createdByUuid: U.A, actor: { type: "user", uuid: U.A },
    });
    await memberService.addMember(actors.A(), privProject.uuid, U.E, "editor");
    await memberService.addMember(actors.A(), privProject.uuid, U.V, "viewer");

    pub = { uuid: pubProject.uuid, ...(await seedEntities(pubProject.uuid, "public")) };
    priv = { uuid: privProject.uuid, ...(await seedEntities(privProject.uuid, "private")) };

    // Stale creator N (never a member) + member assignee V.
    extra.privNotifyTask = await extraTask(priv.uuid, "private notify task", {
      createdByUuid: U.N, assigneeType: "user", assigneeUuid: U.V, status: "assigned",
    });
    extra.pubNotifyTask = await extraTask(pub.uuid, "public notify task", {
      createdByUuid: U.N, assigneeType: "user", assigneeUuid: U.V, status: "assigned",
    });
    extra.privVerifyTask = await extraTask(priv.uuid, "private verify task", { status: "to_verify" });
    extra.privMcpVerifyTask = await extraTask(priv.uuid, "private mcp verify task", { status: "to_verify" });
    extra.privAssignTask = await extraTask(priv.uuid, "private assign task");
    extra.privMentionTask = await extraTask(priv.uuid, "private mention task");
    // Legacy/stale assignment of a private task to non-member N must not surface.
    extra.privTrackerN = await extraTask(priv.uuid, "private tracker N", {
      assigneeType: "user", assigneeUuid: U.N, status: "assigned", assignedAt: new Date(),
    });
    extra.privTrackerE = await extraTask(priv.uuid, "private tracker E", {
      assigneeType: "user", assigneeUuid: U.E, status: "assigned", assignedAt: new Date(),
    });
    extra.pubTrackerN = await extraTask(pub.uuid, "public tracker N", {
      assigneeType: "user", assigneeUuid: U.N, status: "assigned", assignedAt: new Date(),
    });

    // Sidebar visit rows (written directly: recordVisit refuses invisible projects).
    for (const userUuid of [U.N, U.E]) {
      for (const projectUuid of [pub.uuid, priv.uuid]) {
        await db.projectVisit.create({ data: { companyUuid, userUuid, projectUuid, lastVisitedAt: new Date() } });
      }
    }
  }, 60_000);

  afterAll(async () => {
    bus.removeAllListeners();
    if (!db) return;
    await settle(500); // let fire-and-forget writes (mentions/notifications) land before cleanup
    const tenant = { companyUuid };
    const taskUuids = (await db.task.findMany({ where: tenant, select: { uuid: true } })).map((t) => t.uuid);
    const steps: (() => Promise<unknown>)[] = [
      () => db.mention.deleteMany({ where: tenant }),
      () => db.daemonSessionTurn.deleteMany({ where: { session: tenant } }),
      () => db.daemonSession.deleteMany({ where: tenant }),
      () => db.notification.deleteMany({ where: tenant }),
      () => db.notificationPreference.deleteMany({ where: tenant }),
      () => db.activity.deleteMany({ where: tenant }),
      () => db.comment.deleteMany({ where: tenant }),
      () => db.referenceArtifact.deleteMany({ where: tenant }),
      () => db.acceptanceCriterion.deleteMany({ where: { taskUuid: { in: taskUuids } } }),
      () => db.taskDependency.deleteMany({ where: { taskUuid: { in: taskUuids } } }),
      () => db.sessionTaskCheckin.deleteMany({ where: { taskUuid: { in: taskUuids } } }),
      () => db.agentSession.deleteMany({ where: tenant }),
      () => db.task.deleteMany({ where: tenant }),
      () => db.document.deleteMany({ where: tenant }),
      () => db.proposal.deleteMany({ where: tenant }),
      () => db.elaborationQuestion.deleteMany({ where: { round: tenant } }),
      () => db.elaborationRound.deleteMany({ where: tenant }),
      () => db.idea.updateMany({ where: tenant, data: { parentUuid: null } }),
      () => db.idea.deleteMany({ where: tenant }),
      () => db.projectVisit.deleteMany({ where: tenant }),
      () => db.projectMember.deleteMany({ where: tenant }),
      () => db.projectAgentCwdPreference.deleteMany({ where: tenant }),
      () => db.project.deleteMany({ where: tenant }),
      () => db.projectGroup.deleteMany({ where: tenant }),
      () => db.daemonExecution.deleteMany({ where: tenant }),
      () => db.daemonDirectoryRequest.deleteMany({ where: tenant }),
      () => db.daemonConnection.deleteMany({ where: tenant }),
      () => db.agentInstance.deleteMany({ where: tenant }),
      () => db.apiKey.deleteMany({ where: tenant }),
      () => db.agent.deleteMany({ where: tenant }),
      () => db.user.deleteMany({ where: tenant }),
      () => db.company.deleteMany({ where: { uuid: companyUuid } }),
    ];
    for (const step of steps) {
      try { await step(); } catch (err) { console.error("cleanup step failed", err); }
    }
    await db.$disconnect();
    await pool.end();
  }, 60_000);

  // ========================================================================
  describe("fixture sanity", () => {
    it("records creator-admin membership and a project created Activity via the real service", async () => {
      const members = await db.projectMember.findMany({ where: { projectUuid: priv.uuid }, orderBy: { createdAt: "asc" } });
      expect(members.map((m) => [m.userUuid, m.role])).toEqual([[U.A, "admin"], [U.E, "editor"], [U.V, "viewer"]]);
      const pubMembers = await db.projectMember.findMany({ where: { projectUuid: pub.uuid } });
      expect(pubMembers.map((m) => [m.userUuid, m.role])).toEqual([[U.A, "admin"]]);
      const project = await db.project.findUniqueOrThrow({ where: { uuid: priv.uuid } });
      expect(project).toMatchObject({ visibility: "private", createdByUuid: U.A });
      expect(await db.activity.count({ where: { companyUuid, targetUuid: priv.uuid, action: "created" } })).toBe(1);
    });
  });

  // ========================================================================
  describe("REST — private project", () => {
    const reads = () => [
      ["project", routes.project.GET, `/api/projects/${priv.uuid}`, { uuid: priv.uuid }],
      ["project tasks", routes.projectTasks.GET, `/api/projects/${priv.uuid}/tasks`, { uuid: priv.uuid }],
      ["members", routes.members.GET, `/api/projects/${priv.uuid}/members`, { uuid: priv.uuid }],
      ["task", routes.task.GET, `/api/tasks/${priv.task}`, { uuid: priv.task }],
      ["idea", routes.idea.GET, `/api/ideas/${priv.idea}`, { uuid: priv.idea }],
      ["document", routes.document.GET, `/api/documents/${priv.document}`, { uuid: priv.document }],
      ["proposal", routes.proposal.GET, `/api/proposals/${priv.proposal}`, { uuid: priv.proposal }],
      ["comments", routes.comments.GET, `/api/comments?targetType=task&targetUuid=${priv.task}`, noParams],
    ] as [string, Handler<Record<string, string>>, string, Record<string, string>][];

    it.each(["N", "agN", "agO"] as const)("%s gets 404 on every private read", async (actor) => {
      for (const [label, handler, path, params] of reads()) {
        const res = await call(actor, handler, path, params);
        expect(res.status, `${actor} GET ${label}`).toBe(404);
        expect(res.json.success).toBe(false);
      }
    });

    it.each(["N", "agN", "agO"] as const)("%s gets 404 (not 403) on private writes and nothing changes", async (actor) => {
      const before = await db.task.findUniqueOrThrow({ where: { uuid: priv.task } });
      const taskCount = await db.task.count({ where: { projectUuid: priv.uuid } });
      const commentCount = await db.comment.count({ where: { companyUuid } });
      const writes: [string, Promise<{ status: number }>][] = [
        ["PATCH task", call(actor, routes.task.PATCH, `/api/tasks/${priv.task}`, { uuid: priv.task }, "PATCH", { title: "hacked" })],
        ["POST comment", call(actor, routes.comments.POST, "/api/comments", noParams, "POST", { targetType: "task", targetUuid: priv.task, content: "hi" })],
        ["POST task", call(actor, routes.projectTasks.POST, `/api/projects/${priv.uuid}/tasks`, { uuid: priv.uuid }, "POST", { title: "new" })],
        ["approve", call(actor, routes.approve.POST, `/api/proposals/${priv.proposal}/approve`, { uuid: priv.proposal }, "POST", {})],
        ["PATCH project", call(actor, routes.project.PATCH, `/api/projects/${priv.uuid}`, { uuid: priv.uuid }, "PATCH", { name: "hacked" })],
        ["PATCH visibility", call(actor, routes.project.PATCH, `/api/projects/${priv.uuid}`, { uuid: priv.uuid }, "PATCH", { visibility: "public" })],
        ["POST member", call(actor, routes.members.POST, `/api/projects/${priv.uuid}/members`, { uuid: priv.uuid }, "POST", { userUuid: U.N, role: "admin" })],
        ["DELETE project", call(actor, routes.project.DELETE, `/api/projects/${priv.uuid}`, { uuid: priv.uuid }, "DELETE")],
      ];
      for (const [label, p] of writes) expect((await p).status, `${actor} ${label}`).toBe(404);
      expect(await db.task.findUniqueOrThrow({ where: { uuid: priv.task } })).toMatchObject({ title: before.title });
      expect(await db.task.count({ where: { projectUuid: priv.uuid } })).toBe(taskCount);
      expect(await db.comment.count({ where: { companyUuid } })).toBe(commentCount);
      expect(await db.project.findUniqueOrThrow({ where: { uuid: priv.uuid } })).toMatchObject({ visibility: "private" });
      expect(await db.projectMember.count({ where: { projectUuid: priv.uuid } })).toBe(3);
    });

    it("hidden and nonexistent entities return the same 404 body", async () => {
      const hidden = await call("N", routes.task.GET, `/api/tasks/${priv.task}`, { uuid: priv.task });
      const missing = randomUUID();
      const absent = await call("N", routes.task.GET, `/api/tasks/${missing}`, { uuid: missing });
      expect(hidden).toEqual(absent);
    });

    it.each(["V", "agV"] as const)("%s (viewer) can read everything", async (actor) => {
      for (const [label, handler, path, params] of reads()) {
        const res = await call(actor, handler, path, params);
        expect(res.status, `${actor} GET ${label}`).toBe(200);
      }
      const project = await call(actor, routes.project.GET, `/api/projects/${priv.uuid}`, { uuid: priv.uuid });
      expect(project.json.data).toMatchObject({ visibility: "private", accessLevel: "viewer" });
    });

    it("viewer V gets 403 on every write and nothing is created", async () => {
      const taskCount = await db.task.count({ where: { projectUuid: priv.uuid } });
      const commentCount = await db.comment.count({ where: { companyUuid } });
      const writes: [string, Promise<{ status: number }>][] = [
        ["PATCH task", call("V", routes.task.PATCH, `/api/tasks/${priv.task}`, { uuid: priv.task }, "PATCH", { title: "v" })],
        ["PATCH idea", call("V", routes.idea.PATCH, `/api/ideas/${priv.idea}`, { uuid: priv.idea }, "PATCH", { title: "v" })],
        ["PATCH document", call("V", routes.document.PATCH, `/api/documents/${priv.document}`, { uuid: priv.document }, "PATCH", { title: "v" })],
        ["POST comment", call("V", routes.comments.POST, "/api/comments", noParams, "POST", { targetType: "task", targetUuid: priv.task, content: "v" })],
        ["POST task", call("V", routes.projectTasks.POST, `/api/projects/${priv.uuid}/tasks`, { uuid: priv.uuid }, "POST", { title: "v" })],
        ["approve", call("V", routes.approve.POST, `/api/proposals/${priv.proposal}/approve`, { uuid: priv.proposal }, "POST", {})],
        ["PATCH project", call("V", routes.project.PATCH, `/api/projects/${priv.uuid}`, { uuid: priv.uuid }, "PATCH", { name: "v" })],
        ["POST member", call("V", routes.members.POST, `/api/projects/${priv.uuid}/members`, { uuid: priv.uuid }, "POST", { userUuid: U.N, role: "viewer" })],
        ["DELETE project", call("V", routes.project.DELETE, `/api/projects/${priv.uuid}`, { uuid: priv.uuid }, "DELETE")],
        ["agV PATCH task", call("agV", routes.task.PATCH, `/api/tasks/${priv.task}`, { uuid: priv.task }, "PATCH", { title: "v" })],
        ["agV POST comment", call("agV", routes.comments.POST, "/api/comments", noParams, "POST", { targetType: "task", targetUuid: priv.task, content: "v" })],
      ];
      for (const [label, p] of writes) expect((await p).status, `V ${label}`).toBe(403);
      expect(await db.task.count({ where: { projectUuid: priv.uuid } })).toBe(taskCount);
      expect(await db.comment.count({ where: { companyUuid } })).toBe(commentCount);
      expect(await db.proposal.findUniqueOrThrow({ where: { uuid: priv.proposal } })).toMatchObject({ status: "pending" });
    });

    it("editor E can write content, approve the proposal and verify a task", async () => {
      expect((await call("E", routes.task.PATCH, `/api/tasks/${priv.task}`, { uuid: priv.task }, "PATCH",
        { title: `${token} private task edited` })).status).toBe(200);
      expect((await call("E", routes.idea.PATCH, `/api/ideas/${priv.idea}`, { uuid: priv.idea }, "PATCH",
        { title: `${token} private idea edited` })).status).toBe(200);
      expect((await call("E", routes.document.PATCH, `/api/documents/${priv.document}`, { uuid: priv.document }, "PATCH",
        { title: `${token} private document edited` })).status).toBe(200);
      const comment = await call("E", routes.comments.POST, "/api/comments", noParams, "POST",
        { targetType: "task", targetUuid: priv.task, content: `${token} editor comment` });
      expect(comment.status).toBe(200);
      const created = await call("E", routes.projectTasks.POST, `/api/projects/${priv.uuid}/tasks`, { uuid: priv.uuid }, "POST",
        { title: `${token} editor created task` });
      expect(created.status).toBe(200);
      expect(await db.task.count({ where: { projectUuid: priv.uuid, title: `${token} editor created task` } })).toBe(1);

      const approved = await call("E", routes.approve.POST, `/api/proposals/${priv.proposal}/approve`, { uuid: priv.proposal }, "POST", {});
      expect(approved.status).toBe(200);
      expect(await db.proposal.findUniqueOrThrow({ where: { uuid: priv.proposal } })).toMatchObject({ status: "approved" });

      const verified = await call("E", routes.task.PATCH, `/api/tasks/${extra.privVerifyTask}`, { uuid: extra.privVerifyTask }, "PATCH",
        { status: "done" });
      expect(verified.status).toBe(200);
      expect(await db.task.findUniqueOrThrow({ where: { uuid: extra.privVerifyTask } })).toMatchObject({ status: "done" });

      const project = await call("E", routes.project.GET, `/api/projects/${priv.uuid}`, { uuid: priv.uuid });
      expect(project.json.data).toMatchObject({ visibility: "private", accessLevel: "editor" });
    });

    it("editor E gets 403 on members, visibility, private settings and delete", async () => {
      const attempts: [string, Promise<{ status: number }>][] = [
        ["POST member", call("E", routes.members.POST, `/api/projects/${priv.uuid}/members`, { uuid: priv.uuid }, "POST", { userUuid: U.N, role: "viewer" })],
        ["PATCH member", call("E", routes.member.PATCH, `/api/projects/${priv.uuid}/members/${U.V}`, { uuid: priv.uuid, userUuid: U.V }, "PATCH", { role: "editor" })],
        ["DELETE member", call("E", routes.member.DELETE, `/api/projects/${priv.uuid}/members/${U.V}`, { uuid: priv.uuid, userUuid: U.V }, "DELETE")],
        ["PATCH visibility", call("E", routes.project.PATCH, `/api/projects/${priv.uuid}`, { uuid: priv.uuid }, "PATCH", { visibility: "public" })],
        ["PATCH settings", call("E", routes.project.PATCH, `/api/projects/${priv.uuid}`, { uuid: priv.uuid }, "PATCH", { name: "renamed by editor" })],
        ["DELETE project", call("E", routes.project.DELETE, `/api/projects/${priv.uuid}`, { uuid: priv.uuid }, "DELETE")],
      ];
      for (const [label, p] of attempts) expect((await p).status, `E ${label}`).toBe(403);
      const project = await db.project.findUniqueOrThrow({ where: { uuid: priv.uuid } });
      expect(project).toMatchObject({ visibility: "private", name: `${token} private project` });
      const members = await db.projectMember.findMany({ where: { projectUuid: priv.uuid } });
      expect(members).toHaveLength(3);
      expect(members.find((m) => m.userUuid === U.V)?.role).toBe("viewer");
    });

    it("admin A can list/add/change/remove members and edit private settings", async () => {
      const list = await call("A", routes.members.GET, `/api/projects/${priv.uuid}/members`, { uuid: priv.uuid });
      expect(list.status).toBe(200);
      expect((list.json.data as { members: { userUuid: string }[] }).members.map((m) => m.userUuid).sort())
        .toEqual([U.A, U.E, U.V].sort());

      // Temporary: grant N viewer, promote, then remove again.
      expect((await call("A", routes.members.POST, `/api/projects/${priv.uuid}/members`, { uuid: priv.uuid }, "POST",
        { userUuid: U.N, role: "viewer" })).status).toBe(200);
      expect((await call("N", routes.task.GET, `/api/tasks/${priv.task}`, { uuid: priv.task })).status).toBe(200);
      expect((await call("A", routes.member.PATCH, `/api/projects/${priv.uuid}/members/${U.N}`, { uuid: priv.uuid, userUuid: U.N },
        "PATCH", { role: "editor" })).status).toBe(200);
      expect((await call("A", routes.member.DELETE, `/api/projects/${priv.uuid}/members/${U.N}`, { uuid: priv.uuid, userUuid: U.N },
        "DELETE")).status).toBe(200);
      expect((await call("N", routes.task.GET, `/api/tasks/${priv.task}`, { uuid: priv.task })).status).toBe(404);

      const renamed = await call("A", routes.project.PATCH, `/api/projects/${priv.uuid}`, { uuid: priv.uuid }, "PATCH",
        { name: `${token} private project` });
      expect(renamed.status).toBe(200);
      const actions = (await db.activity.findMany({ where: { companyUuid, targetUuid: priv.uuid }, select: { action: true } }))
        .map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(["project_member_added", "project_member_role_changed", "project_member_removed"]));
    });

    it("rejects adding a user from another company", async () => {
      const otherCompany = randomUUID();
      const foreignUser = randomUUID();
      await db.company.create({ data: { uuid: otherCompany, name: `PPA foreign ${token}` } });
      await db.user.create({ data: { uuid: foreignUser, companyUuid: otherCompany, oidcSub: `ppa-${foreignUser}` } });
      try {
        const res = await call("A", routes.members.POST, `/api/projects/${priv.uuid}/members`, { uuid: priv.uuid }, "POST",
          { userUuid: foreignUser, role: "viewer" });
        expect(res.status).toBe(400);
        expect(await db.projectMember.count({ where: { userUuid: foreignUser } })).toBe(0);
      } finally {
        await db.user.deleteMany({ where: { uuid: foreignUser } });
        await db.company.deleteMany({ where: { uuid: otherCompany } });
      }
    });
  });

  // ========================================================================
  describe("REST — public project", () => {
    it.each(["N", "agN", "agO", "V", "E"] as const)("%s has full content read/write", async (actor) => {
      expect((await call(actor, routes.project.GET, `/api/projects/${pub.uuid}`, { uuid: pub.uuid })).status).toBe(200);
      expect((await call(actor, routes.task.GET, `/api/tasks/${pub.task}`, { uuid: pub.task })).status).toBe(200);
      expect((await call(actor, routes.idea.GET, `/api/ideas/${pub.idea}`, { uuid: pub.idea })).status).toBe(200);
      expect((await call(actor, routes.document.GET, `/api/documents/${pub.document}`, { uuid: pub.document })).status).toBe(200);
      expect((await call(actor, routes.proposal.GET, `/api/proposals/${pub.proposal}`, { uuid: pub.proposal })).status).toBe(200);
      expect((await call(actor, routes.task.PATCH, `/api/tasks/${pub.task}`, { uuid: pub.task }, "PATCH",
        { title: `${token} public task by ${actor}` })).status).toBe(200);
      expect((await call(actor, routes.comments.POST, "/api/comments", noParams, "POST",
        { targetType: "task", targetUuid: pub.task, content: `${token} public comment by ${actor}` })).status).toBe(200);
    });

    it("a non-member reports accessLevel editor on a public project, the creator admin", async () => {
      const n = await call("N", routes.project.GET, `/api/projects/${pub.uuid}`, { uuid: pub.uuid });
      expect(n.json.data).toMatchObject({ visibility: "public", accessLevel: "editor" });
      const a = await call("A", routes.project.GET, `/api/projects/${pub.uuid}`, { uuid: pub.uuid });
      expect(a.json.data).toMatchObject({ visibility: "public", accessLevel: "admin" });
    });

    it("non-member N can approve, edit settings (manage_project stays open)", async () => {
      expect((await call("N", routes.approve.POST, `/api/proposals/${pub.proposal}/approve`, { uuid: pub.proposal }, "POST", {})).status).toBe(200);
      expect((await call("N", routes.project.PATCH, `/api/projects/${pub.uuid}`, { uuid: pub.uuid }, "PATCH",
        { name: `${token} public project renamed` })).status).toBe(200);
      expect((await call("V", routes.project.PATCH, `/api/projects/${pub.uuid}`, { uuid: pub.uuid }, "PATCH",
        { name: `${token} public project` })).status).toBe(200);
      expect(await db.project.findUniqueOrThrow({ where: { uuid: pub.uuid } })).toMatchObject({ name: `${token} public project` });
    });

    it.each(["N", "E", "agO"] as const)("%s cannot change visibility or manage members (403)", async (actor) => {
      expect((await call(actor, routes.project.PATCH, `/api/projects/${pub.uuid}`, { uuid: pub.uuid }, "PATCH",
        { visibility: "private" })).status).toBe(403);
      expect((await call(actor, routes.members.POST, `/api/projects/${pub.uuid}/members`, { uuid: pub.uuid }, "POST",
        { userUuid: U.N, role: "admin" })).status).toBe(403);
      expect(await db.project.findUniqueOrThrow({ where: { uuid: pub.uuid } })).toMatchObject({ visibility: "public" });
      expect(await db.projectMember.count({ where: { projectUuid: pub.uuid } })).toBe(1);
    });

    it("admin A can manage members of the public project", async () => {
      expect((await call("A", routes.members.POST, `/api/projects/${pub.uuid}/members`, { uuid: pub.uuid }, "POST",
        { userUuid: U.E, role: "viewer" })).status).toBe(200);
      // Membership floors at editor on public projects: a "viewer" row does not reduce access.
      expect((await call("E", routes.task.PATCH, `/api/tasks/${pub.task}`, { uuid: pub.task }, "PATCH",
        { title: `${token} public task` })).status).toBe(200);
      expect((await call("A", routes.member.DELETE, `/api/projects/${pub.uuid}/members/${U.E}`, { uuid: pub.uuid, userUuid: U.E },
        "DELETE")).status).toBe(200);
      expect(await db.projectMember.count({ where: { projectUuid: pub.uuid } })).toBe(1);
    });
  });

  // ========================================================================
  describe("MCP", () => {
    it("agent-of-N gets the same not-found as a nonexistent task", async () => {
      const hidden = await mcp("agN", "chorus_get_task", { taskUuid: priv.task });
      const missing = await mcp("agN", "chorus_get_task", { taskUuid: randomUUID() });
      expect(hidden).toEqual({ isError: true, text: "Task not found" });
      expect(missing).toEqual(hidden);
      expect(await mcp("agO", "chorus_get_task", { taskUuid: priv.task })).toEqual({ isError: true, text: "Task not found" });
      expect(await mcp("agN", "chorus_get_project", { projectUuid: priv.uuid })).toEqual({ isError: true, text: "Project not found" });
    });

    it("agent-of-V can read but writes are forbidden", async () => {
      const read = await mcp("agV", "chorus_get_task", { taskUuid: priv.task });
      expect(read.isError).toBe(false);
      expect(JSON.parse(read.text)).toMatchObject({ uuid: priv.task });
      const write = await mcp("agV", "chorus_update_task", { taskUuid: priv.task, title: "viewer agent write" });
      expect(write).toEqual({ isError: true, text: "Insufficient project access" });
      const verify = await mcp("agV", "chorus_admin_verify_task", { taskUuid: extra.privMcpVerifyTask });
      expect(verify).toEqual({ isError: true, text: "Insufficient project access" });
      expect(await db.task.findUniqueOrThrow({ where: { uuid: priv.task } })).not.toMatchObject({ title: "viewer agent write" });
      expect(await db.task.findUniqueOrThrow({ where: { uuid: extra.privMcpVerifyTask } })).toMatchObject({ status: "to_verify" });
    });

    it("agent-of-E can update and verify", async () => {
      const write = await mcp("agE", "chorus_update_task", { taskUuid: priv.task, title: `${token} private task by agE` });
      expect(write.isError, write.text).toBe(false);
      expect(await db.task.findUniqueOrThrow({ where: { uuid: priv.task } })).toMatchObject({ title: `${token} private task by agE` });
      const verify = await mcp("agE", "chorus_admin_verify_task", { taskUuid: extra.privMcpVerifyTask });
      expect(verify.isError, verify.text).toBe(false);
      expect(await db.task.findUniqueOrThrow({ where: { uuid: extra.privMcpVerifyTask } })).toMatchObject({ status: "done" });
    });

    it("chorus_get_project returns visibility and the caller's accessLevel", async () => {
      const e = await mcp("agE", "chorus_get_project", { projectUuid: priv.uuid });
      expect(e.isError).toBe(false);
      expect(JSON.parse(e.text)).toMatchObject({ uuid: priv.uuid, visibility: "private", accessLevel: "editor" });
      const v = await mcp("agV", "chorus_get_project", { projectUuid: priv.uuid });
      expect(JSON.parse(v.text)).toMatchObject({ visibility: "private", accessLevel: "viewer" });
      const o = await mcp("agO", "chorus_get_project", { projectUuid: pub.uuid });
      expect(JSON.parse(o.text)).toMatchObject({ visibility: "public", accessLevel: "editor" });
    });

    it("chorus_list_projects hides the private project from agent-of-N", async () => {
      const n = await mcp("agN", "chorus_list_projects", { page: 1, pageSize: 100 });
      expect(n.text).toContain(pub.uuid);
      expect(n.text).not.toContain(priv.uuid);
      const e = await mcp("agE", "chorus_list_projects", { page: 1, pageSize: 100 });
      expect(e.text).toContain(priv.uuid);
    });

    it("chorus_search exact UUID returns nothing to agent-of-N", async () => {
      const n = await mcp("agN", "chorus_search", { query: priv.task });
      expect(n.text).not.toContain(priv.task);
      const e = await mcp("agE", "chorus_search", { query: priv.task });
      expect(e.text).toContain(priv.task);
    });
  });

  // ========================================================================
  describe("Search", () => {
    type R = { uuid: string; projectUuid: string | null };
    const run = (actor: ActorKey, query: string) =>
      searchService.search({ query, companyUuid, auth: actors[actor](), limit: 100 });

    it("text search: N sees no private hits, E does", async () => {
      const n = await run("N", token);
      const nUuids = n.results.map((r: R) => r.uuid);
      expect(nUuids).toContain(pub.task);
      expect(nUuids).toContain(pub.uuid);
      expect(n.results.filter((r: R) => r.projectUuid === priv.uuid || r.uuid === priv.uuid)).toEqual([]);

      const e = await run("E", token);
      const eUuids = e.results.map((r: R) => r.uuid);
      expect(eUuids).toEqual(expect.arrayContaining([priv.uuid, priv.task, priv.idea, priv.document, priv.proposal]));
    });

    it("exact-UUID search: N gets nothing, E gets the task", async () => {
      for (const uuid of [priv.task, priv.idea, priv.document, priv.proposal, priv.uuid]) {
        expect((await run("N", uuid)).results.filter((r: R) => r.uuid === uuid)).toEqual([]);
        expect((await run("E", uuid)).results.map((r: R) => r.uuid)).toContain(uuid);
      }
    });

    it("REST /api/search applies the same filtering", async () => {
      const n = await call("N", routes.search.GET, `/api/search?q=${token}&limit=100`, noParams);
      expect(n.status).toBe(200);
      expect(JSON.stringify(n.json)).not.toContain(priv.uuid);
      expect(JSON.stringify(n.json)).toContain(pub.uuid);
      const e = await call("E", routes.search.GET, `/api/search?q=${token}&limit=100`, noParams);
      expect(JSON.stringify(e.json)).toContain(priv.uuid);
    });
  });

  // ========================================================================
  describe("Listings", () => {
    it("project list (service + REST) excludes private for N, includes for E", async () => {
      const n = await projectService.listProjects({ companyUuid, auth: actors.N(), skip: 0, take: 100 });
      expect(n.projects.map((p: { uuid: string }) => p.uuid)).toEqual([pub.uuid]);
      const e = await projectService.listProjects({ companyUuid, auth: actors.E(), skip: 0, take: 100 });
      expect(e.projects.map((p: { uuid: string }) => p.uuid).sort()).toEqual([pub.uuid, priv.uuid].sort());

      const restN = await call("N", routes.projects.GET, "/api/projects?pageSize=100", noParams);
      expect(restN.status).toBe(200);
      expect(JSON.stringify(restN.json)).not.toContain(priv.uuid);
      const restE = await call("E", routes.projects.GET, "/api/projects?pageSize=100", noParams);
      expect(JSON.stringify(restE.json)).toContain(priv.uuid);
      const restAgO = await call("agO", routes.projects.GET, "/api/projects?pageSize=100", noParams);
      expect(JSON.stringify(restAgO.json)).not.toContain(priv.uuid);
    });

    it("group listing, detail and dashboard count only accessible projects", async () => {
      const nGroups = await groupService.listProjectGroups(companyUuid, actors.N());
      expect(nGroups.groups.find((g: { uuid: string }) => g.uuid === groupUuid)).toMatchObject({ projectCount: 1 });
      const eGroups = await groupService.listProjectGroups(companyUuid, actors.E());
      expect(eGroups.groups.find((g: { uuid: string }) => g.uuid === groupUuid)).toMatchObject({ projectCount: 2 });

      const nDetail = await groupService.getProjectGroup(companyUuid, groupUuid, actors.N());
      expect(nDetail?.projects.map((p) => p.uuid)).toEqual([pub.uuid]);

      const nDash = await groupService.getGroupDashboard(companyUuid, groupUuid, actors.N());
      const eDash = await groupService.getGroupDashboard(companyUuid, groupUuid, actors.E());
      expect(nDash?.stats.projectCount).toBe(1);
      expect(eDash?.stats.projectCount).toBe(2);
      expect(nDash?.projects.map((p: { uuid: string }) => p.uuid)).toEqual([pub.uuid]);
      const pubTasks = await db.task.count({ where: { projectUuid: pub.uuid } });
      const allTasks = await db.task.count({ where: { companyUuid } });
      expect(nDash?.stats.totalTasks).toBe(pubTasks);
      expect(eDash?.stats.totalTasks).toBe(allTasks);
      expect(JSON.stringify(nDash)).not.toContain(priv.uuid);
    });

    it("sidebar quick access drops the private project for N even with a stale visit row", async () => {
      const n = await visitService.getSidebarQuickAccess(companyUuid, U.N);
      expect(n.recent.map((p) => p.uuid)).toEqual([pub.uuid]);
      const e = await visitService.getSidebarQuickAccess(companyUuid, U.E);
      expect(e.recent.map((p) => p.uuid).sort()).toEqual([pub.uuid, priv.uuid].sort());
      expect(e.recent.find((p) => p.uuid === priv.uuid)).toMatchObject({ visibility: "private" });
      // recordVisit / pinProject refuse to write for invisible projects.
      await visitService.pinProject(companyUuid, U.N, priv.uuid);
      expect((await db.projectVisit.findFirstOrThrow({ where: { userUuid: U.N, projectUuid: priv.uuid } })).pinnedAt).toBeNull();
    });

    it("my-assignments excludes stale private assignments for N, includes E's", async () => {
      const n = await assignmentService.getMyAssignments(actors.N());
      expect(Object.keys(n.taskTracker)).toEqual([pub.uuid]);
      expect(JSON.stringify(n)).not.toContain(extra.privTrackerN);
      const e = await assignmentService.getMyAssignments(actors.E());
      expect(e.taskTracker[priv.uuid]?.tasks.map((t) => t.uuid)).toContain(extra.privTrackerE);
    });
  });

  // ========================================================================
  describe("Notifications and mentions", () => {
    const notificationsFor = (entityUuid: string) => db.notification.findMany({
      where: { companyUuid, entityUuid, action: "comment_added" },
      select: { recipientType: true, recipientUuid: true },
    });

    it("commenting on a private task notifies only members (stale non-member creator excluded)", async () => {
      const res = await mcp("agE", "chorus_add_comment", {
        targetType: "task", targetUuid: extra.privNotifyTask, content: `${token} private notify`,
      });
      expect(res.isError, res.text).toBe(false);
      const rows = await eventually(() => notificationsFor(extra.privNotifyTask), (r) => r.length > 0);
      await settle();
      const final = await notificationsFor(extra.privNotifyTask);
      expect(final).toEqual([{ recipientType: "user", recipientUuid: U.V }]);
      expect(rows.length).toBeGreaterThan(0);
      expect(await db.notification.count({ where: { companyUuid, recipientUuid: U.N, projectUuid: priv.uuid } })).toBe(0);
    });

    it("control: the same comment on a public task notifies the non-member creator too", async () => {
      const res = await mcp("agE", "chorus_add_comment", {
        targetType: "task", targetUuid: extra.pubNotifyTask, content: `${token} public notify`,
      });
      expect(res.isError, res.text).toBe(false);
      const rows = await eventually(() => notificationsFor(extra.pubNotifyTask), (r) => r.length >= 2);
      expect(rows.map((r) => r.recipientUuid).sort()).toEqual([U.N, U.V].sort());
    });

    it("mentioning N (and agent-of-N) in a private comment creates no Mention/Notification for them", async () => {
      const content = [
        `${token} mention`,
        `@[UserN](user:${U.N})`, `@[AgentN](agent:${AG.N})`, `@[AgentO](agent:${AG.O})`,
        `@[UserV](user:${U.V})`, `@[AgentV](agent:${AG.V})`,
      ].join(" ");
      const res = await call("E", routes.comments.POST, "/api/comments", noParams, "POST",
        { targetType: "task", targetUuid: extra.privMentionTask, content });
      expect(res.status).toBe(200);
      const commentUuid = (res.json.data as { uuid: string }).uuid;
      const mentions = await eventually(
        () => db.mention.findMany({ where: { sourceUuid: commentUuid }, select: { mentionedType: true, mentionedUuid: true } }),
        (r) => r.length >= 2,
      );
      await settle();
      const final = await db.mention.findMany({ where: { sourceUuid: commentUuid }, select: { mentionedUuid: true } });
      expect(final.map((m) => m.mentionedUuid).sort()).toEqual([U.V, AG.V].sort());
      expect(mentions.length).toBe(2);
      for (const outsider of [U.N, AG.N, AG.O]) {
        expect(await db.notification.count({ where: { companyUuid, recipientUuid: outsider, projectUuid: priv.uuid } })).toBe(0);
      }
      expect(await db.notification.count({
        where: { companyUuid, recipientUuid: U.V, entityUuid: extra.privMentionTask },
      })).toBeGreaterThan(0);
    });
  });

  // ========================================================================
  describe("Assignment", () => {
    it.each([["agent-of-V", "V"], ["agent-of-N", "N"], ["ownerless agent", "O"]] as const)(
      "rejects assigning the private task to %s", async (_label, key) => {
        const res = await mcp("agE", "chorus_pm_assign_task", { taskUuid: extra.privAssignTask, agentUuid: AG[key] });
        expect(res.isError, res.text).toBe(true);
        expect(await db.task.findUniqueOrThrow({ where: { uuid: extra.privAssignTask } }))
          .toMatchObject({ assigneeUuid: null, status: "open" });
      },
    );

    it("allows assigning the private task to agent-of-E", async () => {
      const res = await mcp("agE", "chorus_pm_assign_task", { taskUuid: extra.privAssignTask, agentUuid: AG.E });
      expect(res.isError, res.text).toBe(false);
      expect(await db.task.findUniqueOrThrow({ where: { uuid: extra.privAssignTask } }))
        .toMatchObject({ assigneeType: "agent", assigneeUuid: AG.E });
    });

    it("public project assignment to agent-of-N stays allowed", async () => {
      const task = await extraTask(pub.uuid, "public assign task");
      const res = await mcp("agE", "chorus_pm_assign_task", { taskUuid: task, agentUuid: AG.N });
      expect(res.isError, res.text).toBe(false);
    });
  });

  // ========================================================================
  describe("SSE /api/events", () => {
    async function connect(actor: ActorKey) {
      state.auth = actors[actor]();
      const ac = new AbortController();
      const res = await routes.events.GET(new NextRequest(new URL("http://localhost/api/events"), { signal: ac.signal }));
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(decoder.decode(value, { stream: true }));
          }
        } catch { /* closed */ }
      })();
      await settle(50);
      const events = () => chunks.join("").split("\n\n")
        .filter((c) => c.startsWith("data: "))
        .map((c) => JSON.parse(c.slice(6)) as Json);
      return { close: () => ac.abort(), events };
    }

    it("N's stream gets no change event for the private project; E's does", async () => {
      const n = await connect("N");
      const e = await connect("E");
      try {
        expect((await call("E", routes.task.PATCH, `/api/tasks/${priv.task}`, { uuid: priv.task }, "PATCH",
          { title: `${token} private task sse` })).status).toBe(200);
        expect((await call("E", routes.task.PATCH, `/api/tasks/${pub.task}`, { uuid: pub.task }, "PATCH",
          { title: `${token} public task sse` })).status).toBe(200);
        await eventually(async () => e.events(), (evs) => evs.some((ev) => ev.entityUuid === pub.task));
        await settle(100);
        expect(e.events().some((ev) => ev.projectUuid === priv.uuid && ev.entityUuid === priv.task)).toBe(true);
        expect(n.events().some((ev) => ev.entityUuid === pub.task)).toBe(true);
        expect(n.events().filter((ev) => ev.projectUuid === priv.uuid)).toEqual([]);
      } finally {
        n.close();
        e.close();
      }
    });
  });

  // ========================================================================
  describe("Cross-project proposal inputs (code-review B1/B2)", () => {
    // A PRIVATE proposal that cites a PUBLIC idea (allowed: inputs only need viewer).
    let pubIdea: string;
    let pub2: string;
    let privProposal: string;
    let privProposalDoc: string;
    let privProposalTask: string;
    let pubProposalWithPrivInput: string;

    beforeAll(async () => {
      pubIdea = (await db.idea.create({ data: {
        companyUuid, projectUuid: pub.uuid, title: `${token} cited public idea`, content: "x", createdByUuid: U.A,
      } })).uuid;
      pub2 = (await projectService.createProject({
        companyUuid, name: `${token} public target`, visibility: "public",
        createdByUuid: U.A, actor: { type: "user", uuid: U.A },
      })).uuid;
      privProposal = (await db.proposal.create({ data: {
        companyUuid, projectUuid: priv.uuid, title: `${token} private proposal citing public idea`,
        inputType: "idea", inputUuids: [pubIdea], status: "approved", createdByUuid: U.A, createdByType: "user",
      } })).uuid;
      privProposalDoc = (await db.document.create({ data: {
        companyUuid, projectUuid: priv.uuid, proposalUuid: privProposal, type: "prd",
        title: `${token} private proposal doc`, content: "secret", createdByUuid: U.A,
      } })).uuid;
      privProposalTask = await extraTask(priv.uuid, "private proposal task", { proposalUuid: privProposal });
      // A PUBLIC proposal whose source idea is the PRIVATE project's idea.
      pubProposalWithPrivInput = (await db.proposal.create({ data: {
        companyUuid, projectUuid: pub.uuid, title: `${token} public proposal citing private idea`,
        inputType: "idea", inputUuids: [pubIdea, priv.idea], status: "pending", createdByUuid: U.A, createdByType: "user",
      } })).uuid;
    });

    it("moving a public idea does not drag (or count) a private proposal that cites it", async () => {
      const ideaService = await import("@/services/idea.service");
      const preview = await ideaService.moveIdeaPreview(companyUuid, pubIdea, pub2);
      expect(preview.moved.proposals).toBe(1); // only the public proposal in the source project

      const moveRoute = await import("@/app/api/ideas/[uuid]/move/route");
      const res = await call("N", moveRoute.PATCH, `/api/ideas/${pubIdea}/move`, { uuid: pubIdea }, "PATCH",
        { targetProjectUuid: pub2 });
      expect(res.status).toBe(200);

      expect((await db.proposal.findUnique({ where: { uuid: privProposal } }))?.projectUuid).toBe(priv.uuid);
      expect((await db.document.findUnique({ where: { uuid: privProposalDoc } }))?.projectUuid).toBe(priv.uuid);
      expect((await db.task.findUnique({ where: { uuid: privProposalTask } }))?.projectUuid).toBe(priv.uuid);
      // Same-project proposal still follows the idea (existing behaviour).
      expect((await db.proposal.findUnique({ where: { uuid: pubProposalWithPrivInput } }))?.projectUuid).toBe(pub2);
      expect((await db.idea.findUnique({ where: { uuid: pubIdea } }))?.projectUuid).toBe(pub2);
    });

    it("root-idea lineage of a public task never reveals a private input idea", async () => {
      const proposal = (await db.proposal.create({ data: {
        companyUuid, projectUuid: pub.uuid, title: `${token} public proposal, private primary input`,
        inputType: "idea", inputUuids: [priv.idea, pubIdea], status: "approved", createdByUuid: U.A, createdByType: "user",
      } })).uuid;
      const task = await extraTask(pub.uuid, "public task under cross-project proposal", { proposalUuid: proposal });
      const rootRoute = await import("@/app/api/entities/[type]/[uuid]/root-idea/route");
      const params = { type: "task", uuid: task };
      const path = `/api/entities/task/${task}/root-idea`;

      for (const actor of ["N", "agN"] as const) {
        const res = await call(actor, rootRoute.GET, path, params);
        expect(res.status).toBe(200);
        const body = JSON.stringify(res.json);
        expect(body).not.toContain(priv.idea);
        expect(body).not.toContain("private idea");
        const data = res.json.data as Json;
        expect(data.rootIdeaUuid).toBeNull();
        expect(data.directIdeaUuid).toBeNull();
        expect((data.lineage as Json[]).map((n) => n.type)).toEqual(["task", "proposal"]);
      }

      const forE = (await call("E", rootRoute.GET, path, params)).json.data as Json;
      expect(forE.rootIdeaUuid).toBe(priv.idea);
      expect(forE.candidates).toEqual([priv.idea, pubIdea]);
    });

    it("source-idea filtering hides inputs in projects the caller cannot see", async () => {
      const access = await import("@/services/project-access.service");
      const ideas = await db.idea.findMany({ where: { uuid: { in: [pubIdea, priv.idea] } } });
      const forN = await access.filterRowsByProjectAccess(actors.N(), ideas, (i) => i.projectUuid);
      expect(forN.map((i) => i.uuid)).toEqual([pubIdea]);
      const forE = await access.filterRowsByProjectAccess(actors.E(), ideas, (i) => i.projectUuid);
      expect(forE.map((i) => i.uuid).sort()).toEqual([pubIdea, priv.idea].sort());
      const forAgN = await access.filterRowsByProjectAccess(actors.agN(), ideas, (i) => i.projectUuid);
      expect(forAgN.map((i) => i.uuid)).toEqual([pubIdea]);
    });
  });

  describe("Visibility switching and membership changes", () => {
    let sw: string;
    beforeAll(async () => {
      sw = (await projectService.createProject({
        companyUuid, name: `${token} switch project`, groupUuid, visibility: "public",
        createdByUuid: U.A, actor: { type: "user", uuid: U.A },
      })).uuid;
      await memberService.addMember(actors.A(), sw, U.V, "viewer");
      await db.task.create({ data: { companyUuid, projectUuid: sw, title: `${token} switch task`, createdByUuid: U.A } });
    });
    const get = (actor: ActorKey) => call(actor, routes.project.GET, `/api/projects/${sw}`, { uuid: sw });

    it("public → private by A hides it from non-members, keeps members", async () => {
      expect((await get("N")).status).toBe(200);
      const preview = await previewService.getProjectVisibilityPreview(actors.A(), sw, "private");
      const res = await call("A", routes.project.PATCH, `/api/projects/${sw}`, { uuid: sw }, "PATCH", {
        visibility: "private", confirmationToken: preview.confirmationToken,
      });
      expect(res.status).toBe(200);
      expect(res.json.data).toMatchObject({ visibility: "private" });
      for (const actor of ["N", "E", "agN", "agO"] as const) expect((await get(actor)).status, actor).toBe(404);
      expect((await get("V")).json.data).toMatchObject({ accessLevel: "viewer" });
      expect((await get("A")).json.data).toMatchObject({ accessLevel: "admin" });
      expect((await call("V", routes.project.PATCH, `/api/projects/${sw}`, { uuid: sw }, "PATCH", { name: "x" })).status).toBe(403);
    });

    it("private → public by A restores access and keeps membership rows", async () => {
      const preview = await previewService.getProjectVisibilityPreview(actors.A(), sw, "public");
      const res = await call("A", routes.project.PATCH, `/api/projects/${sw}`, { uuid: sw }, "PATCH", {
        visibility: "public", confirmationToken: preview.confirmationToken,
      });
      expect(res.status).toBe(200);
      for (const actor of ["N", "E", "agN", "agO"] as const) expect((await get(actor)).status, actor).toBe(200);
      const rows = await db.projectMember.findMany({ where: { projectUuid: sw }, select: { userUuid: true, role: true } });
      expect(rows.map((r) => `${r.userUuid}:${r.role}`).sort()).toEqual([`${U.A}:admin`, `${U.V}:viewer`].sort());
      const actions = (await db.activity.findMany({ where: { companyUuid, targetUuid: sw, action: "project_visibility_changed" } }));
      expect(actions).toHaveLength(2);
    });

    it("removing V from the private project makes V (and agent-of-V) 404; open SSE stops", async () => {
      // Open V's stream before the removal.
      state.auth = actors.V();
      const ac = new AbortController();
      const res = await routes.events.GET(new NextRequest(new URL("http://localhost/api/events"), { signal: ac.signal }));
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      void (async () => {
        try { for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(decoder.decode(value)); } } catch { /* closed */ }
      })();
      await settle(50);
      try {
        // Positive control: while still a member, V's stream does receive private events.
        expect((await call("E", routes.task.PATCH, `/api/tasks/${priv.task}`, { uuid: priv.task }, "PATCH",
          { title: `${token} before removal` })).status).toBe(200);
        await settle(200);
        expect(chunks.join("")).toContain(priv.task);

        const removed = await call("A", routes.member.DELETE, `/api/projects/${priv.uuid}/members/${U.V}`,
          { uuid: priv.uuid, userUuid: U.V }, "DELETE");
        expect(removed.status).toBe(200);
        expect((await call("V", routes.project.GET, `/api/projects/${priv.uuid}`, { uuid: priv.uuid })).status).toBe(404);
        expect((await call("V", routes.task.GET, `/api/tasks/${priv.task}`, { uuid: priv.task })).status).toBe(404);
        expect((await call("agV", routes.task.GET, `/api/tasks/${priv.task}`, { uuid: priv.task })).status).toBe(404);
        expect(await mcp("agV", "chorus_get_task", { taskUuid: priv.task })).toEqual({ isError: true, text: "Task not found" });

        await settle(100); // let the stream's access recompute finish
        const mark = chunks.join("").length;
        expect((await call("E", routes.task.PATCH, `/api/tasks/${priv.task}`, { uuid: priv.task }, "PATCH",
          { title: `${token} after removal` })).status).toBe(200);
        await settle(200);
        const after = chunks.join("").slice(mark);
        expect(after).not.toContain(priv.task);
      } finally {
        ac.abort();
      }
    });

    it("last-admin guard: removing or demoting the only admin A → 400, membership unchanged", async () => {
      // An ungrouped project has no inherited Admin to keep it administrable.
      const guarded = await projectService.createProject({
        companyUuid, name: `${token} sole local Admin`, visibility: "private",
        createdByUuid: U.A, actor: { type: "user", uuid: U.A },
      });
      const del = await call("A", routes.member.DELETE, `/api/projects/${guarded.uuid}/members/${U.A}`,
        { uuid: guarded.uuid, userUuid: U.A }, "DELETE");
      expect(del.status).toBe(400);
      const demote = await call("A", routes.member.PATCH, `/api/projects/${guarded.uuid}/members/${U.A}`,
        { uuid: guarded.uuid, userUuid: U.A }, "PATCH", { role: "editor" });
      expect(demote.status).toBe(400);
      expect(await db.projectMember.findFirst({ where: { projectUuid: guarded.uuid, userUuid: U.A } }))
        .toMatchObject({ role: "admin" });
    });
  });
});
