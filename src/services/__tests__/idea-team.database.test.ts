import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient, type Prisma } from "../../generated/prisma/client";
import type { AgentAuthContext, AuthContext } from "@/types/auth";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IdeaTeamActorContext, IdeaTeamTurnFence } from "@/types/idea-team";
import { createWakeContext, parseWakeContext } from "../daemon-wake-context";
import { readIdeaTeamTurnContext } from "@/lib/idea-team-turn-context";

vi.mock("@/generated/prisma/client", async () => import("../../generated/prisma/client"));
const state = vi.hoisted(() => ({ db: null as unknown, emit: vi.fn(), emitChange: vi.fn(), deliverActivities: false }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/event-bus", async () => {
  const { EventEmitter } = await import("node:events");
  const bus = new EventEmitter();
  state.emit.mockImplementation((event: string, ...args: unknown[]) => state.deliverActivities && bus.emit(event, ...args));
  return { eventBus: { emit: state.emit, emitChange: state.emitChange, on: bus.on.bind(bus) }, controlEventName: (uuid: string) => `control:${uuid}`, transcriptEventName: (uuid: string) => `transcript:${uuid}` };
});

describe("Idea Team routing and gates against isolated PostgreSQL", () => {
  let database: PGlite;
  let server: PGLiteSocketServer;
  let directory: string;
  let pool: pg.Pool;
  let db: PrismaClient;
  let service: typeof import("../idea-team.service");
  let ideas: typeof import("../idea.service");
  let proposals: typeof import("../proposal.service");
  let tasks: typeof import("../task.service");
  let auth: AuthContext;
  let lead: AuthContext;
  let product: AuthContext;
  let developer: AuthContext;
  let projectUuid: string;
  let templateUuid: string;

  beforeAll(async () => {
    database = new PGlite();
    for (const migration of (await readdir("prisma/migrations")).filter((name) => /^\d/.test(name)).sort()) {
      await database.exec(await readFile(join("prisma/migrations", migration, "migration.sql"), "utf8"));
    }
    directory = await mkdtemp(join(tmpdir(), "chorus-idea-team-test-"));
    server = new PGLiteSocketServer({ db: database, path: join(directory, ".s.PGSQL.5432") });
    await server.start();
    pool = new pg.Pool({ host: directory, port: 5432, database: "postgres", user: "postgres", max: 1 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    service = await import("../idea-team.service");
    ideas = await import("../idea.service");
    proposals = await import("../proposal.service");
    tasks = await import("../task.service");
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    await pool?.end();
    await server?.stop();
    await database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function agent(name: string, owner = auth): Promise<AuthContext> {
    const created = await db.agent.create({ data: { companyUuid: owner.companyUuid, ownerUuid: owner.actorUuid, name, roles: ["admin_agent"] } });
    return { type: "agent", companyUuid: owner.companyUuid, actorUuid: created.uuid, ownerUuid: owner.actorUuid };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    state.deliverActivities = false;
    const company = await db.company.create({ data: { name: "Isolated Team" } });
    const owner = await db.user.create({ data: { companyUuid: company.uuid, oidcSub: randomUUID() } });
    auth = { type: "user", companyUuid: company.uuid, actorUuid: owner.uuid };
    lead = await agent("Lead");
    product = await agent("Product");
    developer = await agent("Developer");
    projectUuid = (await db.project.create({ data: { companyUuid: company.uuid, name: "Team Project", createdByUuid: owner.uuid } })).uuid;
    templateUuid = (await db.agentTeam.create({ data: { companyUuid: company.uuid, ownerUuid: owner.uuid, name: "Team", members: { create: [
      { role: "lead", agentUuid: lead.actorUuid }, { role: "product", agentUuid: product.actorUuid }, { role: "development", agentUuid: developer.actorUuid },
    ] } } })).uuid;
    await db.projectAgentTeam.create({ data: { companyUuid: company.uuid, ownerUuid: owner.uuid, projectUuid, templateUuid, templateName: "Team", snapshot: {} } });
  });

  async function idea(data: Partial<Prisma.IdeaUncheckedCreateInput> = {}, managed = true) {
    return db.idea.create({ data: {
      companyUuid: auth.companyUuid, projectUuid, title: "Idea", createdByUuid: auth.actorUuid, status: "elaborating",
      ...(managed ? { assigneeType: "agent", assigneeUuid: lead.actorUuid, teamOwnerUuid: auth.actorUuid, teamLeadAgentUuid: lead.actorUuid } : {}), ...data,
    } });
  }

  async function proposal(inputUuids: string[], inputType = "idea", status = "pending") {
    return db.proposal.create({ data: { companyUuid: auth.companyUuid, projectUuid, title: "Proposal", createdByUuid: product.actorUuid, createdByType: "agent", inputType, inputUuids, status } });
  }

  const actor = (identity: AuthContext) => ({ actorType: identity.type, actorUuid: identity.actorUuid });

  async function versionedIdea() {
    return idea({ assigneeUuid: developer.actorUuid, teamLeadAgentUuid: developer.actorUuid, teamEnrollmentVersion: 1, teamGeneration: 1, teamEnrolledAt: new Date(), teamEnrolledByUuid: auth.actorUuid });
  }

  async function teamTurn(ideaUuid: string, identity = developer, role: IdeaTeamTurnFence["role"] = "orchestrator", pending = false) {
    const source = await db.idea.findUniqueOrThrow({ where: { uuid: ideaUuid } });
    const fence: IdeaTeamTurnFence = { ideaUuid, generation: source.teamGeneration, ownerUuid: auth.actorUuid, agentUuid: identity.actorUuid, role };
    const connection = await db.daemonConnection.create({ data: { companyUuid: auth.companyUuid, agentUuid: identity.actorUuid, clientType: "codex", host: randomUUID(), cwd: "/work", status: "online" } });
    const session = await db.daemonSession.create({ data: { companyUuid: auth.companyUuid, agentUuid: identity.actorUuid, sessionId: `${ideaUuid}::${connection.uuid}`, directIdeaUuid: ideaUuid, originConnectionUuid: connection.uuid } });
    const notification = await db.notification.create({ data: { companyUuid: auth.companyUuid, projectUuid, recipientType: "agent", recipientUuid: identity.actorUuid, entityType: "idea", entityUuid: ideaUuid, action: role === "product" ? "team_product_handoff" : "team_lead_handoff", actorType: "user", actorUuid: auth.actorUuid, message: "Continue", entityTitle: "Idea", projectName: "Project", actorName: "Owner" } });
    const wakeContext = { ...createWakeContext(notification)!, ideaTeam: { ...fence } };
    const admissionUuid = randomUUID();
    const turn = await db.daemonSessionTurn.create({ data: { sessionUuid: session.uuid, seq: 1, trigger: "task_assigned", wakeNotificationUuid: notification.uuid, wakeContext, wakeTargetConnectionUuid: connection.uuid, status: pending ? "pending" : "running", ...(!pending ? { admissionUuid, admissionConnectionUuid: connection.uuid, startedAt: new Date() } : {}) } });
    const context: IdeaTeamActorContext = { ...actor(identity), turnUuid: turn.uuid, admissionUuid };
    return { turn, context, fence, connection, session, wakeContext, auth: { ...identity, ideaTeamTurn: { turnUuid: turn.uuid, admissionUuid } } };
  }

  it("exposes assignment confirmation only to the receiving human owner with project editor access", async () => {
    const source = await versionedIdea();
    expect((await service.getIdeaTeamContext(auth, source.uuid)).canAuthorizeAssignment).toBe(true);
    expect((await service.getIdeaTeamContext(developer, source.uuid)).canAuthorizeAssignment).toBe(false);
    const other = await db.user.create({ data: { companyUuid: auth.companyUuid, oidcSub: randomUUID() } });
    expect(await service.getIdeaTeamContext({ type: "user", companyUuid: auth.companyUuid, actorUuid: other.uuid }, source.uuid)).toMatchObject({ canAuthorizeAssignment: false, routing: null });
    await db.project.update({ where: { uuid: projectUuid }, data: { visibility: "private" } });
    await db.projectMember.create({ data: { companyUuid: auth.companyUuid, projectUuid, userUuid: auth.actorUuid, role: "viewer" } });
    await db.projectMember.create({ data: { companyUuid: auth.companyUuid, projectUuid, userUuid: other.uuid, role: "admin" } });
    expect((await service.getIdeaTeamContext(auth, source.uuid)).canAuthorizeAssignment).toBe(false);
  });

  it("rejects every turnless control alias of a managed business session without session metadata", async () => {
    const source = await versionedIdea();
    const target = await pinnedConnection(developer, "resume-alias", "/resume-alias");
    vi.doMock("@/lib/auth", () => ({ getAuthContext: async () => auth, hasPermission: () => false }));
    try {
      const { NextRequest } = await import("next/server");
      const { POST } = await import("@/app/api/daemon/control/route");
      for (const [entityType, entityUuid] of [
        ...["idea", "daemon_session", "task", "proposal", "document"].map((kind) => [kind, source.uuid]),
        ["daemon_session", `${source.uuid}::research`],
        ["daemon_session", source.uuid.toUpperCase()],
      ]) {
        state.emit.mockClear();
        const response = await POST(new NextRequest("http://localhost/api/daemon/control", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetConnectionUuid: target.connection.uuid, command: "resume", entityType, entityUuid }),
        }), { params: Promise.resolve({}) });
        expect(response.status).toBe(409);
        expect(state.emit).not.toHaveBeenCalled();
      }
    } finally {
      vi.doUnmock("@/lib/auth");
    }
  });

  it.each(["in_progress", "closed", "criteria_pending", "unchanged"])("MCP verification retry preserves competing %s state", async (change) => {
    const source = await idea();
    const approved = await proposal([source.uuid], "idea", "approved");
    const task = await db.task.create({ data: { companyUuid: auth.companyUuid, projectUuid, proposalUuid: approved.uuid, title: "Verification retry", status: "to_verify", createdByUuid: lead.actorUuid, assigneeType: "agent", assigneeUuid: developer.actorUuid } });
    const criterion = await db.acceptanceCriterion.create({ data: { taskUuid: task.uuid, description: "Required", required: true, status: "passed", sortOrder: 0 } });
    const { registerAdminTools } = await import("@/mcp/tools/admin");
    const { computeEffectivePermissions } = await import("@/lib/authz/permissions");
    type Handler = (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
    const handlers: Record<string, Handler> = {};
    const server = { registerTool(name: string, _config: unknown, handler: Handler) { handlers[name] = handler; } };
    registerAdminTools(server as unknown as McpServer, { ...lead, type: "agent", roles: ["admin_agent"], agentName: "Lead", permissions: [...computeEffectivePermissions(["admin_agent"], [])] } as AgentAuthContext);
    const original = db.$transaction.bind(db);
    let attempts = 0;
    let competing = false;
    const transaction = vi.spyOn(db, "$transaction");
    transaction.mockImplementation((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: Parameters<typeof db.$transaction>[1]) => {
      if (competing) return original(work, options);
      attempts++;
      try {
        return await original(async (tx) => {
          const result = await work(tx);
          if (attempts === 1) throw { code: "P2034" };
          return result;
        }, options);
      } catch (error) {
        if (attempts === 1) {
          competing = true;
          if (change === "in_progress" || change === "closed") {
            const result = change === "in_progress"
              ? await handlers.chorus_admin_reopen_task({ taskUuid: task.uuid, force: true })
              : await handlers.chorus_admin_close_task({ taskUuid: task.uuid });
            expect(result.isError).not.toBe(true);
          } else if (change === "criteria_pending") {
            await db.acceptanceCriterion.update({ where: { uuid: criterion.uuid }, data: { status: "pending" } });
          }
          competing = false;
        }
        throw error;
      }
    }) as typeof db.$transaction);
    try {
      const verification = handlers.chorus_admin_verify_task({ taskUuid: task.uuid });
      if (change === "unchanged") expect((await verification).isError).not.toBe(true);
      else await expect(verification).rejects.toMatchObject({ status: change === "criteria_pending" ? 422 : 409 });
      expect(attempts).toBe(2);
      const current = await db.task.findUniqueOrThrow({ where: { uuid: task.uuid } });
      expect(current.status).toBe(change === "unchanged" ? "done" : change === "criteria_pending" ? "to_verify" : change);
      expect((await db.acceptanceCriterion.findUniqueOrThrow({ where: { uuid: criterion.uuid } })).status).toBe(change === "unchanged" ? "passed" : "pending");
      expect(await db.activity.count({ where: { targetUuid: task.uuid, action: "verified" } })).toBe(change === "unchanged" ? 1 : 0);
    } finally {
      transaction.mockRestore();
    }
  });

  describe.each([true, false])("serialization retry (managed=%s)", (managed) => {
    it.each(["approve", "submit", "done"])("retries complete %s transactions without duplicate committed writes/events", async (operation) => {
      const source = await idea({ elaborationStatus: "resolved" }, managed);
      await yolo(source.uuid);
      const draft = await proposal([source.uuid], "idea", operation === "submit" ? "draft" : "pending");
      await db.proposal.update({ where: { uuid: draft.uuid }, data: {
        documentDrafts: [{ uuid: randomUUID(), type: "prd", title: "Design", content: "Detailed requirements. ".repeat(15) }],
        taskDrafts: [{ uuid: randomUUID(), title: "Implement", acceptanceCriteriaItems: [{ description: "Verified", required: true }] }],
      } });
      const task = await db.task.create({ data: { companyUuid: auth.companyUuid, projectUuid, proposalUuid: draft.uuid, title: "Existing", status: "to_verify", createdByUuid: lead.actorUuid } });
      state.emit.mockClear();
      state.emitChange.mockClear();
      const original = db.$transaction.bind(db);
      let attempts = 0;
      const transaction = vi.spyOn(db, "$transaction");
      transaction.mockImplementation(((work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: Parameters<typeof db.$transaction>[1]) => original(async (tx) => {
        attempts++;
        const result = await work(tx);
        if (attempts < 3) throw { code: "P2034" };
        return result;
      }, options)) as typeof db.$transaction);
      try {
        if (operation === "approve") await proposals.approveProposal(draft.uuid, auth.companyUuid, lead.actorUuid, null, actor(lead));
        else if (operation === "submit") await proposals.submitProposal(draft.uuid, auth.companyUuid, actor(lead));
        else await tasks.updateTask(task.uuid, { status: "done" }, actor(lead));
        expect(attempts).toBe(3);
        expect(transaction).toHaveBeenCalledWith(expect.any(Function), operation === "done"
          ? { isolationLevel: "Serializable" } : { isolationLevel: "Serializable", timeout: 15000 });
        expect(state.emitChange).toHaveBeenCalledTimes(1);
        expect(state.emit.mock.calls.filter(([event]) => event === "activity")).toHaveLength(operation === "submit" ? 1 : 0);
        expect(await db.task.count({ where: { proposalUuid: draft.uuid } })).toBe(operation === "approve" ? 2 : 1);
        expect(await db.document.count({ where: { proposalUuid: draft.uuid } })).toBe(operation === "approve" ? 1 : 0);
        expect(await db.acceptanceCriterion.count({ where: { task: { proposalUuid: draft.uuid } } })).toBe(operation === "approve" ? 1 : 0);
        expect(await db.activity.count({ where: { targetUuid: draft.uuid, action: "submitted" } })).toBe(operation === "submit" ? 1 : 0);
        expect(await db.activity.count({ where: { targetUuid: task.uuid, action: "execution_started" } })).toBe(operation === "done" ? 1 : 0);
      } finally {
        transaction.mockRestore();
      }
    });

    it.each(["approve", "submit", "done"])("bounds %s conflicts and propagates other errors without events", async (operation) => {
      const source = await idea({}, managed);
      const draft = await proposal([source.uuid]);
      const task = await db.task.create({ data: { companyUuid: auth.companyUuid, projectUuid, proposalUuid: draft.uuid, title: "Existing", status: "to_verify", createdByUuid: lead.actorUuid } });
      const run = () => operation === "approve" ? proposals.approveProposal(draft.uuid, auth.companyUuid, lead.actorUuid, null, actor(lead))
        : operation === "submit" ? proposals.submitProposal(draft.uuid, auth.companyUuid, actor(lead))
        : tasks.updateTask(task.uuid, { status: "done" }, actor(lead));
      state.emit.mockClear();
      state.emitChange.mockClear();
      const transaction = vi.spyOn(db, "$transaction");
      try {
        for (const code of ["P2034", "P2002"]) {
          const error = { code };
          transaction.mockClear().mockRejectedValue(error);
          await expect(run()).rejects.toBe(error);
          expect(transaction).toHaveBeenCalledTimes(code === "P2034" ? 4 : 1);
          expect(state.emit).not.toHaveBeenCalled();
          expect(state.emitChange).not.toHaveBeenCalled();
        }
        transaction.mockClear().mockRejectedValue({ code: "P2034" });
        await expect(tasks.updateTask(task.uuid, { title: "Changed" })).rejects.toEqual({ code: "P2034" });
        expect(transaction).toHaveBeenCalledTimes(1);
      } finally {
        transaction.mockRestore();
      }
    });
  });

  it("rechecks the current Team gate after an approval serialization rollback", async () => {
    const source = await idea();
    await yolo(source.uuid);
    const draft = await proposal([source.uuid]);
    state.emitChange.mockClear();
    const original = db.$transaction.bind(db);
    let attempts = 0;
    const transaction = vi.spyOn(db, "$transaction");
    transaction.mockImplementation((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: Parameters<typeof db.$transaction>[1]) => {
      attempts++;
      try {
        return await original(async (tx) => {
          const result = await work(tx);
          if (attempts === 1) throw { code: "P2034" };
          return result;
        }, options);
      } catch (error) {
        if (attempts === 1) await db.projectAgentTeam.deleteMany({ where: { projectUuid } });
        throw error;
      }
    }) as typeof db.$transaction);
    try {
      await expect(proposals.approveProposal(draft.uuid, auth.companyUuid, lead.actorUuid, null, actor(lead))).rejects.toMatchObject({ status: 403 });
      expect(attempts).toBe(2);
      expect((await db.proposal.findUniqueOrThrow({ where: { uuid: draft.uuid } })).status).toBe("pending");
      expect(state.emitChange).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
  });

  it.each(["approved", "closed", "draft"])("does not replay approval after a competing %s transition", async (status) => {
    const source = await idea({}, false);
    const draft = await proposal([source.uuid]);
    await db.proposal.update({ where: { uuid: draft.uuid }, data: {
      documentDrafts: [{ uuid: randomUUID(), type: "prd", title: "Design", content: "Requirements" }],
      taskDrafts: [{ uuid: randomUUID(), title: "Implement", acceptanceCriteriaItems: [{ description: "Verified", required: true }] }],
    } });
    state.emitChange.mockClear();
    const original = db.$transaction.bind(db);
    let attempts = 0;
    let competing = false;
    const transaction = vi.spyOn(db, "$transaction");
    transaction.mockImplementation((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: Parameters<typeof db.$transaction>[1]) => {
      if (competing) return original(work, options);
      attempts++;
      try {
        return await original(async (tx) => {
          const result = await work(tx);
          if (attempts === 1) throw { code: "P2034" };
          return result;
        }, options);
      } catch (error) {
        if (attempts === 1) {
          competing = true;
          if (status === "approved") await proposals.approveProposal(draft.uuid, auth.companyUuid, auth.actorUuid, null, actor(auth));
          else await db.proposal.update({ where: { uuid: draft.uuid }, data: { status } });
          competing = false;
        }
        throw error;
      }
    }) as typeof db.$transaction);
    try {
      await expect(proposals.approveProposal(draft.uuid, auth.companyUuid, auth.actorUuid, null, actor(auth))).rejects.toThrow("Only pending proposals can be approved");
      expect(attempts).toBe(2);
      expect((await db.proposal.findUniqueOrThrow({ where: { uuid: draft.uuid } })).status).toBe(status);
      const count = status === "approved" ? 1 : 0;
      expect(await db.task.count({ where: { proposalUuid: draft.uuid } })).toBe(count);
      expect(await db.document.count({ where: { proposalUuid: draft.uuid } })).toBe(count);
      expect(await db.acceptanceCriterion.count({ where: { task: { proposalUuid: draft.uuid } } })).toBe(count);
      expect(state.emitChange).toHaveBeenCalledTimes(count);
    } finally {
      transaction.mockRestore();
    }
  });

  async function yolo(ideaUuid: string, identity = auth) {
    await db.activity.create({ data: { companyUuid: auth.companyUuid, projectUuid, targetType: "idea", targetUuid: ideaUuid, action: "yolo_requested", ...actor(identity) } });
  }

  async function online(identity: AuthContext, activeCount = 0) {
    const connection = await db.daemonConnection.create({ data: { companyUuid: auth.companyUuid, agentUuid: identity.actorUuid, clientType: "codex", host: randomUUID(), status: "online" } });
    for (let index = 0; index < activeCount; index++) {
      await db.daemonExecution.create({ data: { companyUuid: auth.companyUuid, agentUuid: identity.actorUuid, connectionUuid: connection.uuid, entityType: "task", entityUuid: randomUUID(), status: "running" } });
    }
  }

  async function pinnedConnection(identity: AuthContext, host: string, cwd: string) {
    const instance = await db.agentInstance.create({ data: { companyUuid: auth.companyUuid, agentUuid: identity.actorUuid, host, cwd } });
    const connection = await db.daemonConnection.create({ data: { companyUuid: auth.companyUuid, agentUuid: identity.actorUuid, clientType: "codex", host, cwd, agentInstanceUuid: instance.uuid } });
    return { instance, connection };
  }

  it("does not enroll unassigned creation or old assignments; explicit instance assignment enrolls", async () => {
    const unassigned = await ideas.createIdea({ companyUuid: auth.companyUuid, projectUuid, title: "Inert", createdByUuid: auth.actorUuid });
    expect(await service.getIdeaTeamContext(auth, unassigned.uuid)).toMatchObject({ managed: false, state: "unmanaged" });
    expect((await db.idea.findUniqueOrThrow({ where: { uuid: unassigned.uuid } })).assigneeUuid).toBeNull();
    const legacy = await idea({ assigneeType: "agent", assigneeUuid: lead.actorUuid }, false);
    expect((await service.getIdeaTeamContext(auth, legacy.uuid)).managed).toBe(false);
    const instance = await db.agentInstance.create({ data: { companyUuid: auth.companyUuid, agentUuid: lead.actorUuid, host: "host", cwd: "/work" } });
    await ideas.assignIdea({ ideaUuid: unassigned.uuid, companyUuid: auth.companyUuid, assigneeType: "agent", assigneeUuid: lead.actorUuid, instanceUuid: instance.uuid, assignedByType: "user", assignedByUuid: auth.actorUuid, auth });
    expect(await service.getIdeaTeamContext(auth, unassigned.uuid)).toMatchObject({ state: "active", lead: { agentUuid: lead.actorUuid } });
  });

  it("retains enrollment after release, reassignment, loss of eligibility and unbinding", async () => {
    const managed = await idea();
    await ideas.assignIdea({ ideaUuid: managed.uuid, companyUuid: auth.companyUuid, assigneeType: "agent", assigneeUuid: developer.actorUuid, assignedByType: "user", assignedByUuid: auth.actorUuid });
    expect(await service.getIdeaTeamContext(auth, managed.uuid)).toMatchObject({ managed: true, state: "paused", reason: "lead_not_assignee" });
    await db.idea.update({ where: { uuid: managed.uuid }, data: { assigneeUuid: null, assigneeType: null } });
    expect((await service.getIdeaTeamContext(auth, managed.uuid)).managed).toBe(true);
    await db.agent.update({ where: { uuid: lead.actorUuid }, data: { roles: ["developer_agent"] } });
    expect((await service.getIdeaTeamContext(auth, managed.uuid)).reason).toBe("lead_ineligible");
    await db.projectAgentTeam.deleteMany({ where: { projectUuid } });
    expect(await service.getIdeaTeamContext(auth, managed.uuid)).toMatchObject({ managed: true, state: "paused", reason: "team_unbound" });
  });

  it("redacts private routing and ignores forged owner context", async () => {
    const managed = await idea();
    const other = await db.user.create({ data: { companyUuid: auth.companyUuid, oidcSub: randomUUID() } });
    const otherAgent = await agent("Other", { ...auth, actorUuid: other.uuid });
    expect((await service.getIdeaTeamContext(otherAgent, managed.uuid)).routing).toBeNull();
    expect((await service.getIdeaTeamContext({ ...otherAgent, ownerUuid: auth.actorUuid }, managed.uuid)).routing).toBeNull();
    await expect(service.recommendIdeaTeamRole(otherAgent, managed.uuid, "product")).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it("delegates product without changing the lead and revokes delegated authority dynamically", async () => {
    const managed = await idea();
    await expect(service.delegateIdeaTeamProduct(product, managed.uuid, product.actorUuid)).rejects.toMatchObject({ status: 403 });
    await service.delegateIdeaTeamProduct(lead, managed.uuid, product.actorUuid);
    expect((await db.idea.findUniqueOrThrow({ where: { uuid: managed.uuid } })).assigneeUuid).toBe(lead.actorUuid);
    expect(await service.isIdeaTeamProductDelegate(auth.companyUuid, managed.uuid, product.actorUuid)).toBe(true);
    expect(await proposals.checkIdeasAssignee(auth.companyUuid, [managed.uuid], product.actorUuid, "agent")).toMatchObject({ valid: true });
    const elaboration = await import("../elaboration.service");
    await elaboration.startElaboration({ companyUuid: auth.companyUuid, ideaUuid: managed.uuid, actorUuid: product.actorUuid, actorType: "agent", depth: "minimal", questions: [{ id: "scope", text: "Scope?", category: "scope", required: true, options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }] });
    expect(await db.comment.count({ where: { targetUuid: managed.uuid, content: { contains: `(agent:${product.actorUuid})` } } })).toBe(1);
    await service.delegateIdeaTeamProduct(lead, managed.uuid, product.actorUuid);
    expect(await db.comment.count({ where: { targetUuid: managed.uuid } })).toBe(1);
    await db.idea.update({ where: { uuid: managed.uuid }, data: { elaborationStatus: "resolved" } });
    const authored = await proposals.createProposal({ companyUuid: auth.companyUuid, projectUuid, title: "Delegated", inputType: "idea", inputUuids: [managed.uuid], createdByUuid: product.actorUuid,
      documentDrafts: [{ type: "prd", title: "Design", content: "Product requirements and design. ".repeat(6) }],
      taskDrafts: [{ title: "Implement", acceptanceCriteriaItems: [{ description: "Works", required: true }] }],
    });
    await proposals.submitProposal(authored.uuid, auth.companyUuid, actor(product));
    expect((await db.proposal.findUniqueOrThrow({ where: { uuid: authored.uuid } })).status).toBe("pending");
    await db.agentTeamMember.deleteMany({ where: { teamUuid: templateUuid, role: "product" } });
    expect(await service.isIdeaTeamProductDelegate(auth.companyUuid, managed.uuid, product.actorUuid)).toBe(false);
    await expect(proposals.createProposal({ companyUuid: auth.companyUuid, projectUuid, title: "Removed", inputType: "idea", inputUuids: [managed.uuid], createdByUuid: product.actorUuid })).rejects.toMatchObject({ status: 403 });
    const draft = await proposal([managed.uuid], "idea", "draft");
    await expect(proposals.submitProposal(draft.uuid, auth.companyUuid, actor(product))).rejects.toMatchObject({ status: 403 });
  });

  it("runs delegated MCP start/create/submit through the real services and notifies the lead once", async () => {
    const target = await pinnedConnection(lead, "lead-host", "/lead");
    const managed = await idea({ assigneeType: "agent_instance", assigneeUuid: target.instance.uuid });
    await service.delegateIdeaTeamProduct(lead, managed.uuid, product.actorUuid);
    const storedProduct = await db.agent.findUniqueOrThrow({ where: { uuid: product.actorUuid } });
    const { computeEffectivePermissions } = await import("@/lib/authz/permissions");
    const { registerPmTools } = await import("@/mcp/tools/pm");
    await import("../notification-listener");
    type Handler = (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
    const handlers: Record<string, Handler> = {};
    const server = { registerTool(name: string, _config: unknown, handler: Handler) { handlers[name] = handler; } };
    const productAuth: AgentAuthContext = {
      type: "agent", actorUuid: storedProduct.uuid, companyUuid: storedProduct.companyUuid,
      ownerUuid: storedProduct.ownerUuid ?? undefined, agentName: storedProduct.name,
      roles: storedProduct.roles as AgentAuthContext["roles"], permissions: [...computeEffectivePermissions(storedProduct.roles, storedProduct.permissions)],
    };
    registerPmTools(server as unknown as McpServer, productAuth);
    const started = await handlers.chorus_pm_start_elaboration({ ideaUuid: managed.uuid, depth: "minimal", questions: [{ id: "scope", text: "Scope?", category: "scope", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }] });
    expect(started.isError).not.toBe(true);
    await db.idea.update({ where: { uuid: managed.uuid }, data: { elaborationStatus: "resolved" } });
    const created = await handlers.chorus_pm_create_proposal({ projectUuid, title: "MCP product proposal", inputType: "idea", inputUuids: [managed.uuid] });
    expect(created.isError).not.toBe(true);
    const proposalUuid = (JSON.parse(created.content[0].text) as { uuid: string }).uuid;
    await proposals.addDocumentDraft(proposalUuid, auth.companyUuid, { type: "prd", title: "PRD", content: "Product requirements with useful detail. ".repeat(6) });
    await proposals.addTaskDraft(proposalUuid, auth.companyUuid, { title: "Implement", acceptanceCriteriaItems: [{ description: "Works", required: true }] });
    state.emit.mockClear();
    state.deliverActivities = true;
    try {
      const submitted = await handlers.chorus_pm_submit_proposal({ proposalUuid });
      expect(submitted.isError).not.toBe(true);
      expect((await db.proposal.findUniqueOrThrow({ where: { uuid: proposalUuid } })).status).toBe("pending");
      expect((await db.idea.findUniqueOrThrow({ where: { uuid: managed.uuid } })).assigneeUuid).toBe(target.instance.uuid);
      const activityRows = await db.activity.findMany({ where: { companyUuid: auth.companyUuid, targetType: "proposal", targetUuid: proposalUuid, action: "submitted" } });
      expect(activityRows).toHaveLength(1);
      expect(activityRows[0]).toMatchObject({ actorType: "agent", actorUuid: product.actorUuid });
      expect(state.emit.mock.calls.filter(([event, value]) => event === "activity" && value.action === "submitted")).toHaveLength(1);
      await expect.poll(() => db.daemonSessionTurn.count({ where: { wakeNotification: { entityUuid: proposalUuid, action: "team_lead_handoff" } } }), { timeout: 5000 }).toBe(1);
      const notification = await db.notification.findFirstOrThrow({ where: { companyUuid: auth.companyUuid, entityUuid: proposalUuid, action: "team_lead_handoff" } });
      expect(notification).toMatchObject({ recipientType: "agent", recipientUuid: lead.actorUuid, actorType: "agent", actorUuid: product.actorUuid });
      const turn = await db.daemonSessionTurn.findFirstOrThrow({ where: { wakeNotificationUuid: notification.uuid }, include: { session: true } });
      expect(turn).toMatchObject({ trigger: "task_assigned", wakeTargetConnectionUuid: target.connection.uuid, wakeRuntimeCwd: "/lead", session: { agentUuid: lead.actorUuid, directIdeaUuid: managed.uuid } });
      await expect.poll(() => state.emit.mock.calls.filter(([name, value]) => name === `control:${target.connection.uuid}` && value.turnUuid === turn.uuid).length).toBe(1);
      state.deliverActivities = false;
      const { handleActivity } = await import("../notification-listener");
      const submissionEvent = state.emit.mock.calls.find(([name, value]) => name === "activity" && value.action === "submitted")![1];
      await Promise.all([handleActivity(submissionEvent), handleActivity(submissionEvent)]);
      expect(await db.daemonSessionTurn.count({ where: { wakeNotificationUuid: notification.uuid } })).toBe(1);
      expect(state.emit.mock.calls.filter(([name, value]) => name === `control:${target.connection.uuid}` && value.turnUuid === turn.uuid)).toHaveLength(1);
      expect((await handlers.chorus_pm_submit_proposal({ proposalUuid })).isError).toBe(true);
      expect(await db.activity.count({ where: { targetUuid: proposalUuid, action: "submitted" } })).toBe(1);
      expect(await db.notification.count({ where: { entityUuid: proposalUuid, action: "team_lead_handoff" } })).toBe(1);
    } finally {
      state.deliverActivities = false;
    }
  });

  it("rolls submission back and publishes nothing when its atomic activity write fails", async () => {
    const managed = await idea({ elaborationStatus: "resolved" });
    await service.delegateIdeaTeamProduct(lead, managed.uuid, product.actorUuid);
    const authored = await proposals.createProposal({ companyUuid: auth.companyUuid, projectUuid, title: "Atomic submission", inputType: "idea", inputUuids: [managed.uuid], createdByUuid: product.actorUuid,
      documentDrafts: [{ type: "prd", title: "PRD", content: "Product requirements with useful detail. ".repeat(6) }],
      taskDrafts: [{ title: "Implement", acceptanceCriteriaItems: [{ description: "Works", required: true }] }],
    });
    await database.exec(`CREATE FUNCTION reject_submission_activity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'submitted' THEN RAISE EXCEPTION 'submission activity rejected'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_submission_activity BEFORE INSERT ON "Activity" FOR EACH ROW EXECUTE FUNCTION reject_submission_activity();`);
    state.emit.mockClear();
    state.emitChange.mockClear();
    try {
      await expect(proposals.submitProposal(authored.uuid, auth.companyUuid, actor(product))).rejects.toThrow("submission activity rejected");
      expect((await db.proposal.findUniqueOrThrow({ where: { uuid: authored.uuid } })).status).toBe("draft");
      expect(await db.activity.count({ where: { targetUuid: authored.uuid, action: "submitted" } })).toBe(0);
      expect(state.emit).not.toHaveBeenCalled();
      expect(state.emitChange).not.toHaveBeenCalled();
    } finally {
      await database.exec('DROP TRIGGER reject_submission_activity ON "Activity"; DROP FUNCTION reject_submission_activity();');
    }
  });

  it.each(["submitted", "status_changed"])("delivers task %s to the lead's Idea pin, not the developer's task instance", async (action) => {
    const target = await pinnedConnection(lead, "lead-host", "/lead");
    const execution = await pinnedConnection(developer, "developer-host", "/implementation");
    const managed = await idea({ assigneeType: "agent_instance", assigneeUuid: target.instance.uuid });
    const approved = await proposal([managed.uuid], "idea", "approved");
    const task = await db.task.create({ data: { companyUuid: auth.companyUuid, projectUuid, proposalUuid: approved.uuid, title: "Implementation", status: "in_progress", createdByUuid: lead.actorUuid, assigneeType: "agent_instance", assigneeUuid: execution.instance.uuid } });
    const { createActivity } = await import("../activity.service");
    const { handleActivity } = await import("../notification-listener");
    state.emit.mockClear();
    state.deliverActivities = true;
    try {
      if (action === "submitted") {
        const { registerDeveloperTools } = await import("@/mcp/tools/developer");
        const { computeEffectivePermissions } = await import("@/lib/authz/permissions");
        type Handler = (input: Record<string, unknown>) => Promise<{ isError?: boolean }>;
        const handlers: Record<string, Handler> = {};
        const server = { registerTool(name: string, _config: unknown, handler: Handler) { handlers[name] = handler; } };
        registerDeveloperTools(server as unknown as McpServer, { ...developer, type: "agent", roles: ["admin_agent"], agentName: "Developer", permissions: [...computeEffectivePermissions(["admin_agent"], [])] });
        expect((await handlers.chorus_submit_for_verify({ taskUuid: task.uuid, summary: "Ready for verification" })).isError).not.toBe(true);
      } else {
        await tasks.updateTask(task.uuid, { status: "to_verify" }, actor(auth));
        await createActivity({ companyUuid: auth.companyUuid, projectUuid, targetType: "task", targetUuid: task.uuid, action, ...actor(auth), value: { from: "in_progress", to: "to_verify" } });
      }
      await expect.poll(() => db.daemonSessionTurn.count({ where: { wakeNotification: { entityUuid: task.uuid, action: "team_lead_handoff" } } }), { timeout: 5000 }).toBe(1);
      const notification = await db.notification.findFirstOrThrow({ where: { entityUuid: task.uuid, recipientUuid: lead.actorUuid, action: "team_lead_handoff" } });
      const turn = await db.daemonSessionTurn.findFirstOrThrow({ where: { wakeNotificationUuid: notification.uuid }, include: { session: true } });
      expect(turn).toMatchObject({ trigger: "task_assigned", wakeTargetConnectionUuid: target.connection.uuid, wakeRuntimeCwd: "/lead", session: { agentUuid: lead.actorUuid, directIdeaUuid: managed.uuid } });
      await expect.poll(() => state.emit.mock.calls.filter(([name, value]) => name === `control:${target.connection.uuid}` && value.command === "deliver_turn" && value.turnUuid === turn.uuid).length).toBe(1);
      expect(await db.notification.count({ where: { entityUuid: task.uuid, recipientUuid: lead.actorUuid } })).toBe(1);
      expect(await db.daemonSessionTurn.count({ where: { session: { agentUuid: developer.actorUuid } } })).toBe(0);
      state.deliverActivities = false;
      const event = state.emit.mock.calls.find(([name, value]) => name === "activity" && value.action === action)![1];
      await Promise.all([handleActivity(event), handleActivity(event)]);
      expect(await db.daemonSessionTurn.count({ where: { wakeNotificationUuid: notification.uuid } })).toBe(1);
      expect(state.emit.mock.calls.filter(([name, value]) => name === `control:${target.connection.uuid}` && value.turnUuid === turn.uuid)).toHaveLength(1);
      const sessions = await import("../daemon-session.service");
      expect(await sessions.canAgentReceiveTurn(auth.companyUuid, lead.actorUuid, turn.uuid, target.connection.uuid)).toBe(true);
      await db.projectAgentTeam.deleteMany({ where: { projectUuid } });
      expect(await sessions.canAgentReceiveTurn(auth.companyUuid, lead.actorUuid, turn.uuid, target.connection.uuid)).toBe(false);
      expect(await sessions.getWakeRecoveryDelivery(auth.companyUuid, lead.actorUuid, target.connection.uuid, turn.uuid)).toBeNull();
      const assignedActivity = await createActivity({ companyUuid: auth.companyUuid, projectUuid, targetType: "task", targetUuid: task.uuid, action: "assigned", ...actor(auth) });
      await handleActivity(assignedActivity);
      const executionTurn = await db.daemonSessionTurn.findFirstOrThrow({ where: { wakeNotification: { entityUuid: task.uuid, recipientUuid: developer.actorUuid, action: "task_assigned" } } });
      expect(executionTurn.wakeTargetConnectionUuid).toBe(execution.connection.uuid);
      expect(state.emit.mock.calls.some(([name, value]) => name === `control:${execution.connection.uuid}` && value.turnUuid === executionTurn.uuid)).toBe(true);
    } finally {
      state.deliverActivities = false;
    }
  });

  it.each(["paused", "unmanaged", "non_lead", "lost_access", "reassigned", "ineligible"])("suppresses handoff creation for %s while preserving notify-only records", async (condition) => {
    const target = await pinnedConnection(lead, "lead-host", "/lead");
    const managed = await idea({ assigneeType: "agent_instance", assigneeUuid: target.instance.uuid });
    const approved = await proposal([managed.uuid], "idea", "approved");
    const task = await db.task.create({ data: { companyUuid: auth.companyUuid, projectUuid, proposalUuid: approved.uuid, title: "Review", status: "to_verify", createdByUuid: lead.actorUuid, assigneeType: "agent", assigneeUuid: developer.actorUuid } });
    let recipientUuid = lead.actorUuid;
    if (condition === "paused") await db.projectAgentTeam.deleteMany({ where: { projectUuid } });
    if (condition === "unmanaged") await db.idea.update({ where: { uuid: managed.uuid }, data: { teamOwnerUuid: null, teamLeadAgentUuid: null } });
    if (condition === "reassigned") await db.idea.update({ where: { uuid: managed.uuid }, data: { assigneeType: "agent", assigneeUuid: developer.actorUuid } });
    if (condition === "ineligible") await db.agent.update({ where: { uuid: lead.actorUuid }, data: { roles: ["developer_agent"] } });
    if (condition === "non_lead") {
      recipientUuid = product.actorUuid;
      await pinnedConnection(product, "product-host", "/product");
    }
    if (condition === "lost_access") {
      const other = await db.user.create({ data: { companyUuid: auth.companyUuid, oidcSub: randomUUID() } });
      await db.projectMember.create({ data: { companyUuid: auth.companyUuid, projectUuid, userUuid: other.uuid, role: "admin", addedByUuid: auth.actorUuid } });
      await db.project.update({ where: { uuid: projectUuid }, data: { visibility: "private" } });
    }
    const notification = await db.notification.create({ data: { companyUuid: auth.companyUuid, projectUuid, recipientType: "agent", recipientUuid, entityType: "task", entityUuid: task.uuid, entityTitle: task.title, projectName: "Team Project", action: "team_lead_handoff", message: "Task is ready", actorType: "agent", actorUuid: developer.actorUuid, actorName: "Developer" } });
    const { createWakeContext } = await import("../daemon-wake-context");
    const { createTurnAndResolveTarget } = await import("../notification-turn");
    state.emit.mockClear();
    const result = await createTurnAndResolveTarget({ ...notification, wakeContext: createWakeContext(notification) });
    expect(result).toMatchObject({ turn: null, suppressWake: true });
    expect(await db.daemonSessionTurn.count({ where: { wakeNotificationUuid: notification.uuid } })).toBe(0);
    expect(state.emit.mock.calls.some(([name]) => name.startsWith("control:"))).toBe(false);
    if (["paused", "unmanaged", "reassigned", "ineligible"].includes(condition)) {
      const { createActivity } = await import("../activity.service");
      const { handleActivity } = await import("../notification-listener");
      const activity = await createActivity({ companyUuid: auth.companyUuid, projectUuid, targetType: "task", targetUuid: task.uuid, action: "submitted", ...actor(developer) });
      await handleActivity(activity);
      expect(await db.notification.count({ where: { entityUuid: task.uuid, recipientUuid: lead.actorUuid, action: "task_submitted_for_verify" } })).toBe(1);
      expect(await db.daemonSessionTurn.count({ where: { session: { agentUuid: lead.actorUuid } } })).toBe(0);
    }
  });

  it.each(["target_resolution", "dispatch"])("rechecks Team eligibility when enrollment pauses during %s", async (phase) => {
    const target = await pinnedConnection(lead, "lead-host", "/lead");
    const managed = await idea({ assigneeType: "agent_instance", assigneeUuid: target.instance.uuid });
    const approved = await proposal([managed.uuid], "idea", "approved");
    const task = await db.task.create({ data: { companyUuid: auth.companyUuid, projectUuid, proposalUuid: approved.uuid, title: "Race", status: "to_verify", createdByUuid: lead.actorUuid } });
    const registry = await import("../daemon-connection.service");
    const sessions = await import("../daemon-session.service");
    const listConnections = registry.listConnectionsForAgent;
    const createPending = sessions.createPendingTurn;
    const spy = phase === "target_resolution" ? vi.spyOn(registry, "listConnectionsForAgent").mockImplementationOnce(async (...args) => {
      const connections = await listConnections(...args);
      await db.projectAgentTeam.deleteMany({ where: { projectUuid } });
      return connections;
    }) : vi.spyOn(sessions, "createPendingTurn").mockImplementationOnce(async (...args) => {
      const turn = await createPending(...args);
      await db.projectAgentTeam.deleteMany({ where: { projectUuid } });
      return turn;
    });
    try {
      const { createActivity } = await import("../activity.service");
      const { handleActivity } = await import("../notification-listener");
      const activity = await createActivity({ companyUuid: auth.companyUuid, projectUuid, targetType: "task", targetUuid: task.uuid, action: "submitted", ...actor(developer) });
      state.emit.mockClear();
      await handleActivity(activity);
      expect(spy).toHaveBeenCalled();
      expect(await db.notification.count({ where: { entityUuid: task.uuid, action: "team_lead_handoff" } })).toBe(1);
      expect(await db.daemonSessionTurn.count({ where: { wakeNotification: { entityUuid: task.uuid } } })).toBe(phase === "dispatch" ? 1 : 0);
      if (phase === "dispatch") {
        const turn = await db.daemonSessionTurn.findFirstOrThrow({ where: { wakeNotification: { entityUuid: task.uuid } } });
        expect(await sessions.canAgentReceiveTurn(auth.companyUuid, lead.actorUuid, turn.uuid, target.connection.uuid)).toBe(false);
        expect(await sessions.getWakeRecoveryDelivery(auth.companyUuid, lead.actorUuid, target.connection.uuid, turn.uuid)).toBeNull();
      }
      expect(state.emit.mock.calls.some(([name]) => name.startsWith("control:"))).toBe(false);
      expect(state.emit.mock.calls.find(([name]) => name === `notification:agent:${lead.actorUuid}`)?.[1]).toMatchObject({ suppressWake: true });
    } finally {
      spy.mockRestore();
    }
  });

  it("deduplicates concurrent report handoffs including an overlapping lead recipient", async () => {
    const target = await pinnedConnection(lead, "lead-host", "/lead");
    const managed = await idea({ assigneeType: "agent_instance", assigneeUuid: target.instance.uuid, createdByUuid: lead.actorUuid });
    const { createActivity } = await import("../activity.service");
    const { handleActivity } = await import("../notification-listener");
    const activity = await createActivity({ companyUuid: auth.companyUuid, projectUuid, targetType: "idea", targetUuid: managed.uuid, action: "report_created", ...actor(product) });
    state.emit.mockClear();
    await Promise.all([handleActivity(activity), handleActivity(activity)]);
    const notifications = await db.notification.findMany({ where: { entityUuid: managed.uuid, recipientUuid: lead.actorUuid } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].action).toBe("team_lead_handoff");
    const turns = await db.daemonSessionTurn.findMany({ where: { wakeNotificationUuid: notifications[0].uuid } });
    expect(turns).toHaveLength(1);
    expect(state.emit.mock.calls.filter(([name, value]) => name === `control:${target.connection.uuid}` && value.turnUuid === turns[0].uuid)).toHaveLength(1);
  });

  it("blocks missing actors, non-YOLO agents, forged YOLO and wrong leads at the approval mutation", async () => {
    const managed = await idea();
    const pending = await proposal([managed.uuid]);
    await expect(proposals.approveProposal(pending.uuid, auth.companyUuid, lead.actorUuid)).rejects.toMatchObject({ status: 403 });
    await expect(proposals.approveProposal(pending.uuid, auth.companyUuid, lead.actorUuid, null, actor(lead))).rejects.toMatchObject({ status: 403 });
    await yolo(managed.uuid, lead);
    await yolo(managed.uuid, { ...auth, actorUuid: randomUUID() });
    expect((await service.getIdeaTeamContext(auth, managed.uuid)).yolo).toBe(false);
    await expect(proposals.approveProposal(pending.uuid, auth.companyUuid, lead.actorUuid, null, actor(lead))).rejects.toMatchObject({ status: 403 });
    await yolo(managed.uuid);
    await expect(proposals.approveProposal(pending.uuid, auth.companyUuid, product.actorUuid, null, actor(product))).rejects.toMatchObject({ status: 403 });
    await proposals.approveProposal(pending.uuid, auth.companyUuid, lead.actorUuid, null, actor(lead));
    expect((await db.proposal.findUniqueOrThrow({ where: { uuid: pending.uuid } })).status).toBe("approved");
  });

  it("requires every input's YOLO and active lead, while authorized humans retain approval", async () => {
    const first = await idea();
    const second = await idea();
    await yolo(first.uuid);
    const pending = await proposal([first.uuid, second.uuid]);
    await expect(service.assertIdeaTeamGate(auth.companyUuid, pending.uuid, "proposal", actor(lead))).rejects.toMatchObject({ status: 403 });
    await yolo(second.uuid);
    await service.assertIdeaTeamGate(auth.companyUuid, pending.uuid, "proposal", actor(lead));
    await db.idea.update({ where: { uuid: second.uuid }, data: { assigneeUuid: product.actorUuid } });
    await expect(service.assertIdeaTeamGate(auth.companyUuid, pending.uuid, "task", actor(lead))).rejects.toMatchObject({ status: 403 });
    await proposals.approveProposal(pending.uuid, auth.companyUuid, auth.actorUuid, null, actor(auth));
  });

  it("intersects different leads and rejects foreign actors and malformed ancestry", async () => {
    const secondLead = await agent("Second lead");
    await db.agentTeamMember.create({ data: { teamUuid: templateUuid, role: "lead", agentUuid: secondLead.actorUuid } });
    const first = await idea();
    const second = await idea({ assigneeUuid: secondLead.actorUuid, teamLeadAgentUuid: secondLead.actorUuid });
    await yolo(first.uuid);
    await yolo(second.uuid);
    const pending = await proposal([first.uuid, second.uuid]);
    await expect(service.assertIdeaTeamGate(auth.companyUuid, pending.uuid, "proposal", actor(lead))).rejects.toMatchObject({ status: 403 });
    await expect(service.assertIdeaTeamGate(auth.companyUuid, pending.uuid, "proposal", actor(secondLead))).rejects.toMatchObject({ status: 403 });
    const foreign = await db.company.create({ data: { name: "Foreign" } });
    const foreignUser = await db.user.create({ data: { companyUuid: foreign.uuid, oidcSub: randomUUID() } });
    await expect(service.assertIdeaTeamGate(auth.companyUuid, pending.uuid, "proposal", { actorType: "user", actorUuid: foreignUser.uuid })).rejects.toMatchObject({ status: 403 });
    await db.proposal.update({ where: { uuid: pending.uuid }, data: { inputUuids: { invalid: true } } });
    await expect(service.assertIdeaTeamGate(auth.companyUuid, pending.uuid, "proposal", actor(lead))).rejects.toThrow("ambiguous");
  });

  it("pauses removed enrollment without disabling the human editor's existing management", async () => {
    const managed = await idea();
    const approved = await proposal([managed.uuid], "idea", "approved");
    const task = await db.task.create({ data: { companyUuid: auth.companyUuid, projectUuid, title: "Task", status: "to_verify", proposalUuid: approved.uuid, createdByUuid: auth.actorUuid } });
    const editor = await db.user.create({ data: { companyUuid: auth.companyUuid, oidcSub: randomUUID() } });
    await db.projectAgentTeam.deleteMany({ where: { projectUuid } });
    await expect(tasks.updateTask(task.uuid, { status: "done" }, actor(lead))).rejects.toMatchObject({ status: 403 });
    await tasks.updateTask(task.uuid, { status: "done" }, { actorType: "user", actorUuid: editor.uuid });
    expect((await db.task.findUniqueOrThrow({ where: { uuid: task.uuid } })).status).toBe("done");
  });

  it("follows document ancestry, deduplicates leads, and fails closed on missing or cyclic sources", async () => {
    const managed = await idea();
    const source = await proposal([managed.uuid]);
    const document = await db.document.create({ data: { companyUuid: auth.companyUuid, projectUuid, title: "Source", type: "prd", proposalUuid: source.uuid, createdByUuid: auth.actorUuid } });
    const child = await proposal([document.uuid, document.uuid], "document");
    expect(await service.getProposalTeamIdeaUuids(auth.companyUuid, child.uuid)).toEqual([managed.uuid]);
    expect(await service.getIdeaTeamLeadRecipients(auth.companyUuid, "proposal", child.uuid)).toEqual([{ type: "agent", uuid: lead.actorUuid }]);
    await expect(service.assertIdeaTeamGate(auth.companyUuid, child.uuid, "proposal", actor(lead))).rejects.toMatchObject({ status: 403 });
    await db.document.update({ where: { uuid: document.uuid }, data: { proposalUuid: child.uuid } });
    await expect(service.assertIdeaTeamGate(auth.companyUuid, child.uuid, "proposal", actor(lead))).rejects.toThrow("cycle");
    await db.document.delete({ where: { uuid: document.uuid } });
    await expect(service.assertIdeaTeamGate(auth.companyUuid, child.uuid, "proposal", actor(lead))).rejects.toThrow("missing");
  });

  it("protects the generic done mutation, including document ancestry, but leaves Quick Tasks compatible", async () => {
    const managed = await idea();
    const approved = await proposal([managed.uuid], "idea", "approved");
    const document = await db.document.create({ data: { companyUuid: auth.companyUuid, projectUuid, title: "Source", type: "prd", proposalUuid: approved.uuid, createdByUuid: auth.actorUuid } });
    const child = await proposal([document.uuid], "document", "approved");
    const task = await db.task.create({ data: { companyUuid: auth.companyUuid, projectUuid, title: "Task", status: "to_verify", proposalUuid: child.uuid, createdByUuid: auth.actorUuid } });
    await expect(tasks.updateTask(task.uuid, { status: "done" })).rejects.toMatchObject({ status: 403 });
    await expect(tasks.updateTask(task.uuid, { status: "done" }, actor(developer))).rejects.toMatchObject({ status: 403 });
    expect((await db.task.findUniqueOrThrow({ where: { uuid: task.uuid } })).status).toBe("to_verify");
    await tasks.updateTask(task.uuid, { status: "done" }, actor(lead));
    expect((await db.task.findUniqueOrThrow({ where: { uuid: task.uuid } })).status).toBe("done");
    const quick = await db.task.create({ data: { companyUuid: auth.companyUuid, projectUuid, title: "Quick", status: "to_verify", createdByUuid: auth.actorUuid } });
    await tasks.updateTask(quick.uuid, { status: "done" });
    const legacy = await idea({}, false);
    const pending = await proposal([legacy.uuid]);
    await proposals.approveProposal(pending.uuid, auth.companyUuid, lead.actorUuid);
  });

  it("distinguishes empty/ineligible roles from offline fallback and rejects unrelated tasks", async () => {
    const managed = await idea();
    expect(await service.recommendIdeaTeamRole(lead, managed.uuid, "product")).toMatchObject({ decision: "manual", reason: "role_and_lead_offline" });
    await online(lead);
    expect(await service.recommendIdeaTeamRole(lead, managed.uuid, "product")).toMatchObject({ decision: "recommended", agentUuid: lead.actorUuid, reason: "role_offline_lead_fallback" });
    await db.agent.update({ where: { uuid: product.actorUuid }, data: { roles: [] } });
    expect(await service.recommendIdeaTeamRole(lead, managed.uuid, "product")).toMatchObject({ decision: "manual", reason: "role_empty_or_ineligible" });
    await db.agentTeamMember.deleteMany({ where: { teamUuid: templateUuid, role: "product" } });
    expect(await service.recommendIdeaTeamRole(lead, managed.uuid, "product")).toMatchObject({ decision: "manual", reason: "role_empty_or_ineligible" });
    await expect(service.recommendIdeaTeamRole(lead, managed.uuid, "development", randomUUID())).rejects.toMatchObject({ status: 403 });
    await db.projectAgentTeam.deleteMany({ where: { projectUuid } });
    expect(await service.recommendIdeaTeamRole(lead, managed.uuid, "development")).toMatchObject({ decision: "paused" });
  });

  it("v1 uses the current assignee outside lead roles and preserves action-specific eligibility", async () => {
    const source = await versionedIdea();
    await db.agent.update({ where: { uuid: developer.actorUuid }, data: { roles: [], permissions: ["idea:write"] } });
    expect(await service.getIdeaTeamContext(developer, source.uuid)).toMatchObject({ state: "active", orchestrator: { agentUuid: developer.actorUuid }, enrollmentVersion: 1, generation: 1 });
    const draft = await proposal([source.uuid]);
    await yolo(source.uuid);
    expect(await service.getIdeaTeamContext(developer, source.uuid)).toMatchObject({ proposalGate: "human", proposalGateReason: "proposal_permission_required", taskGate: "human", taskGateReason: "task_permission_required", state: "active" });
    await expect(proposals.approveProposal(draft.uuid, auth.companyUuid, developer.actorUuid, null, actor(developer))).rejects.toThrow("Action permission required");
    expect((await service.getIdeaTeamContext(developer, source.uuid)).state).toBe("active");
    await db.agent.update({ where: { uuid: developer.actorUuid }, data: { ownerUuid: null } });
    expect((await service.getIdeaTeamContext(auth, source.uuid)).state).toBe("paused");
  });

  it.each(["timestamp", "authorizer", "owner_mismatch"])("v1 retained guards without valid %s consent never reactivate", async (missing) => {
    const source = await versionedIdea();
    const admitted = await teamTurn(source.uuid);
    await db.idea.update({ where: { uuid: source.uuid }, data: missing === "timestamp" ? { teamEnrolledAt: null } : { teamEnrolledByUuid: missing === "authorizer" ? null : randomUUID() } });
    expect(await service.getIdeaTeamContext(developer, source.uuid)).toMatchObject({ managed: true, state: "paused", reason: "human_assignment_required", proposalGate: "human", taskGate: "human" });
    expect(await service.canReceiveIdeaTeamFence(auth.companyUuid, developer.actorUuid, admitted.fence)).toBe(false);
    expect(await service.getIdeaTeamLeadRecipients(auth.companyUuid, "idea", source.uuid)).toEqual([]);
    expect((await service.recommendIdeaTeamRole(developer, source.uuid, "product")).decision).toBe("paused");
    await expect(service.assertIdeaTeamCurrentTurn(auth.companyUuid, source.uuid, admitted.context)).rejects.toMatchObject({ status: 403 });
  });

  it("v1 verifies a non-YOLO task with task:admin and required AC without granting proposal approval", async () => {
    const source = await versionedIdea();
    const admitted = await teamTurn(source.uuid);
    const approved = await proposal([source.uuid], "idea", "approved");
    const task = await db.task.create({ data: { companyUuid: auth.companyUuid, projectUuid, title: "Verify", status: "to_verify", proposalUuid: approved.uuid, createdByUuid: auth.actorUuid } });
    await db.acceptanceCriterion.create({ data: { taskUuid: task.uuid, description: "Required", required: true, status: "pending" } });
    await expect(tasks.updateTask(task.uuid, { status: "done" }, admitted.context)).rejects.toMatchObject({ status: 422 });
    await db.acceptanceCriterion.updateMany({ where: { taskUuid: task.uuid }, data: { status: "passed" } });
    await tasks.updateTask(task.uuid, { status: "done" }, admitted.context);
    expect((await db.task.findUniqueOrThrow({ where: { uuid: task.uuid } })).status).toBe("done");
    const pending = await proposal([source.uuid]);
    await expect(proposals.approveProposal(pending.uuid, auth.companyUuid, developer.actorUuid, null, admitted.context)).rejects.toThrow("Human approval required");
  });

  it("v1 retains exact historical human YOLO after A-to-B-to-A and rejects the old turn", async () => {
    const source = await versionedIdea();
    await yolo(source.uuid);
    await db.activity.updateMany({ where: { targetUuid: source.uuid, action: "yolo_requested" }, data: { createdAt: new Date("2020-01-01") } });
    const old = await teamTurn(source.uuid);
    const assignment = await import("../idea-assignment-authorization.service");
    for (const agentUuid of [lead.actorUuid, developer.actorUuid]) await assignment.assignIdeaWithAuthority(auth, { ideaUuid: source.uuid, assigneeType: "agent", assigneeUuid: agentUuid, operationUuid: randomUUID() });
    expect((await service.getIdeaTeamContext(auth, source.uuid)).yolo).toBe(true);
    const draft = await proposal([source.uuid]);
    await expect(proposals.approveProposal(draft.uuid, auth.companyUuid, developer.actorUuid, null, old.context)).rejects.toMatchObject({ status: 403 });
    const current = await teamTurn(source.uuid);
    await proposals.approveProposal(draft.uuid, auth.companyUuid, developer.actorUuid, null, current.context);
    expect((await db.proposal.findUniqueOrThrow({ where: { uuid: draft.uuid } })).status).toBe("approved");
  });

  it("v1 keeps recommendation ranking and uses current non-lead orchestrator only for offline role fallback", async () => {
    const source = await versionedIdea();
    await online(developer);
    expect(await service.recommendIdeaTeamRole(developer, source.uuid, "product")).toMatchObject({ decision: "recommended", agentUuid: developer.actorUuid });
    await db.agentTeamMember.deleteMany({ where: { teamUuid: templateUuid, role: "product" } });
    expect((await service.recommendIdeaTeamRole(developer, source.uuid, "product")).decision).toBe("manual");
  });

  it.each(["product", "development"] as const)("v1 offline %s fallback checks current role permissions without invalidating enrollment", async (role) => {
    const source = await idea({}, false);
    const basicPermissions = ["idea:read", "proposal:read", "document:read", "task:read", "project:read", "idea:write"];
    const missingPermissions = role === "product" ? ["proposal:write", "document:write"] : ["task:write"];
    await db.agentTeamMember.updateMany({ where: { teamUuid: templateUuid, role: "development" }, data: { agentUuid: product.actorUuid } });
    await db.agent.update({ where: { uuid: developer.actorUuid }, data: { roles: [], permissions: basicPermissions } });
    const { assignIdeaWithAuthority } = await import("../idea-assignment-authorization.service");
    await assignIdeaWithAuthority(auth, { ideaUuid: source.uuid, assigneeType: "agent", assigneeUuid: developer.actorUuid, operationUuid: randomUUID() });
    await online(developer);
    const limited = await service.recommendIdeaTeamRole(developer, source.uuid, role);
    expect(limited).toMatchObject({ decision: "manual", reason: "role_offline_orchestrator_ineligible", agentUuid: null });
    expect(limited.candidates.find((candidate) => candidate.agentUuid === developer.actorUuid)).toMatchObject({ eligible: false, missingPermissions });
    expect(await service.getIdeaTeamContext(developer, source.uuid)).toMatchObject({ state: "active", enrollmentVersion: 1, generation: 1 });

    const qualifiedPermissions = [...basicPermissions, ...missingPermissions];
    await db.agent.update({ where: { uuid: developer.actorUuid }, data: { permissions: qualifiedPermissions } });
    expect(await service.recommendIdeaTeamRole(developer, source.uuid, role)).toMatchObject({ decision: "recommended", agentUuid: developer.actorUuid, candidates: [expect.objectContaining({ eligible: true, missingPermissions: [] })] });
    await db.agent.update({ where: { uuid: developer.actorUuid }, data: { permissions: qualifiedPermissions.filter((permission) => permission !== missingPermissions[0]) } });
    const revoked = await service.recommendIdeaTeamRole(developer, source.uuid, role);
    expect(revoked).toMatchObject({ decision: "manual", agentUuid: null });
    expect(revoked.candidates.find((candidate) => candidate.agentUuid === developer.actorUuid)).toMatchObject({ eligible: false, missingPermissions: [missingPermissions[0]] });
    expect(await service.getIdeaTeamContext(developer, source.uuid)).toMatchObject({ state: "active", generation: 1 });
    await db.agent.update({ where: { uuid: developer.actorUuid }, data: { permissions: qualifiedPermissions } });
    expect(await service.recommendIdeaTeamRole(developer, source.uuid, role)).toMatchObject({ decision: "recommended", agentUuid: developer.actorUuid });

    await db.agent.update({ where: { uuid: product.actorUuid }, data: { roles: [], permissions: basicPermissions } });
    expect(await service.recommendIdeaTeamRole(developer, source.uuid, role)).toMatchObject({ decision: "manual", reason: "role_empty_or_ineligible" });
    await db.agent.update({ where: { uuid: product.actorUuid }, data: { roles: ["admin_agent"] } });
    await online(product);
    await db.agent.update({ where: { uuid: developer.actorUuid }, data: { permissions: basicPermissions } });
    expect(await service.recommendIdeaTeamRole(developer, source.uuid, role)).toMatchObject({ decision: "recommended", agentUuid: product.actorUuid });
    await db.agentTeamMember.deleteMany({ where: { teamUuid: templateUuid, role } });
    expect(await service.recommendIdeaTeamRole(developer, source.uuid, role)).toMatchObject({ decision: "manual", reason: "role_empty_or_ineligible" });
  });

  async function coalescedTeamAdmission(mode = "fenced") {
    const first = await versionedIdea();
    const second = await versionedIdea();
    const primary = await teamTurn(first.uuid, developer, "orchestrator", true);
    const ordinary = { ...primary.wakeContext, notification: { ...primary.wakeContext.notification, action: "comment_added" } };
    delete (ordinary as { ideaTeam?: IdeaTeamTurnFence }).ideaTeam;
    const combined = { ...primary.wakeContext, ideaTeams: [primary.fence, { ...primary.fence, ideaUuid: second.uuid }] };
    await db.daemonSessionTurn.update({ where: { uuid: primary.turn.uuid }, data: { wakeContext: mode === "ordinary-first" ? ordinary : mode === "ordinary-last" ? combined : primary.wakeContext } });
    const secondary = await db.daemonSessionTurn.create({ data: {
      sessionUuid: primary.session.uuid, seq: 2, trigger: "task_assigned", status: "pending",
      wakeContext: mode === "ordinary-last" ? ordinary : combined, wakeTargetConnectionUuid: primary.connection.uuid,
    } });
    const sessions = await import("../daemon-session.service");
    const admission = await sessions.advanceTurnForWake({
      companyUuid: auth.companyUuid, agentUuid: developer.actorUuid,
      connectionUuid: primary.connection.uuid, sessionId: primary.session.sessionId,
      turnUuid: primary.turn.uuid, turnUuids: [primary.turn.uuid, secondary.uuid],
      admissionUuid: primary.context.admissionUuid!, status: "running", wakeRecoveryProtocol: 1, ideaTeamProtocol: 1,
    });
    expect(admission.ok).toBe(true);
    expect(await db.daemonSessionTurn.findUnique({ where: { uuid: secondary.uuid } })).toMatchObject({ status: "merged", admissionUuid: null });
    return { first, second, primary, secondary };
  }

  it.each(["fenced", "ordinary-first", "ordinary-last"])("v1 authorizes protected mutations from real coalesced %s admission", async (mode) => {
    const { first, second, primary } = await coalescedTeamAdmission(mode);
    const draft = await proposals.createProposal({ companyUuid: auth.companyUuid, projectUuid, title: "Coalesced authoring", inputType: "idea", inputUuids: [first.uuid, second.uuid], createdByUuid: developer.actorUuid, actorContext: primary.context });
    await proposals.addDocumentDraft(draft.uuid, auth.companyUuid, { type: "prd", title: "Both admitted sources", content: "Current" }, primary.context);
    await yolo(first.uuid);
    await yolo(second.uuid);
    const pending = await proposal([first.uuid, second.uuid]);
    await proposals.approveProposal(pending.uuid, auth.companyUuid, developer.actorUuid, null, primary.context);
    expect((await db.proposal.findUniqueOrThrow({ where: { uuid: pending.uuid } })).status).toBe("approved");
  });

  describe.each(["fenced", "ordinary-first", "ordinary-last"])("v1 coalesced %s public resume", (mode) => {
    async function fixture() {
      const admitted = await coalescedTeamAdmission(mode);
      const { first, primary } = admitted;
      await db.daemonSession.update({ where: { uuid: primary.session.uuid }, data: { sessionId: first.uuid } });
      const execution = await db.daemonExecution.create({ data: {
        companyUuid: auth.companyUuid, agentUuid: developer.actorUuid, connectionUuid: primary.connection.uuid,
        entityType: "idea", entityUuid: first.uuid, directIdeaUuid: first.uuid, status: "running",
      } });
      await db.daemonSessionTurn.update({ where: { uuid: primary.turn.uuid }, data: { executionUuid: execution.uuid } });
      const sessions = await import("../daemon-session.service");
      const executions = await import("../daemon-execution.service");
      const request = {
        companyUuid: auth.companyUuid, agentUuid: developer.actorUuid, connectionUuid: primary.connection.uuid,
        sessionId: first.uuid, entityType: "idea", entityUuid: first.uuid,
        wakeRecoveryProtocol: 1 as const, ideaTeamProtocol: 1 as const,
      };
      async function interrupt(turnUuid = primary.turn.uuid, admissionUuid = primary.context.admissionUuid!, reason: "user" | "crash" = "user") {
        expect(await sessions.advanceTurnForWake({ ...request, turnUuid, admissionUuid, status: "interrupted", interruptedReason: reason })).toMatchObject({ ok: true });
        expect(await executions.reportExecutionInterrupt(auth.companyUuid, primary.connection.uuid, "idea", first.uuid, reason)).toBe(true);
      }
      async function resume() {
        vi.doMock("@/lib/auth", () => ({ getAuthContext: async () => auth, hasPermission: () => false }));
        try {
          const { NextRequest } = await import("next/server");
          const { POST } = await import("@/app/api/daemon/resume/route");
          return await POST(new NextRequest("http://localhost/api/daemon/resume", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connectionUuid: primary.connection.uuid, entityType: "idea", entityUuid: first.uuid }),
          }), { params: Promise.resolve({}) });
        } finally {
          vi.doUnmock("@/lib/auth");
        }
      }
      function create(context: IdeaTeamActorContext, title: string) {
        return proposals.createProposal({ companyUuid: auth.companyUuid, projectUuid, title, inputType: "idea", inputUuids: [first.uuid, admitted.second.uuid], createdByUuid: developer.actorUuid, actorContext: context });
      }
      async function continuation() {
        expect((await resume()).status).toBe(200);
        return db.daemonSessionTurn.findFirstOrThrow({ where: { sessionUuid: primary.session.uuid, executionUuid: execution.uuid, trigger: "resume", status: "pending" }, orderBy: { seq: "desc" } });
      }
      async function admit(turnUuid: string) {
        const admissionUuid = randomUUID();
        expect(await sessions.advanceTurnForWake({ ...request, turnUuid, turnUuids: [turnUuid], admissionUuid, status: "running" })).toMatchObject({ ok: true });
        return { ...actor(developer), turnUuid, admissionUuid };
      }
      return { ...admitted, execution, sessions, request, interrupt, resume, create, continuation, admit };
    }

    it("retains all source fences and protected multi-source authoring through repeated interruption and resume", async () => {
      const run = await fixture();
      await run.create(run.primary.context, "Before interruption");
      let context = run.primary.context;
      for (const reason of ["user", "crash"] as const) {
        await run.interrupt(context.turnUuid, context.admissionUuid, reason);
        state.emit.mockClear();
        const resumed = await run.continuation();
        expect(resumed.uuid).not.toBe(context.turnUuid);
        expect(resumed.wakeTargetConnectionUuid).toBe(run.primary.connection.uuid);
        expect(resumed.wakeContext).toMatchObject({ ideaTeam: run.primary.fence });
        expect(parseWakeContext(resumed.wakeContext)?.ideaTeams).toEqual([
          run.primary.fence, { ...run.primary.fence, ideaUuid: run.second.uuid },
        ]);
        expect(state.emit.mock.calls.filter(([name]) => name === `control:${run.primary.connection.uuid}`)).toEqual([
          [expect.any(String), expect.objectContaining({ command: "resume", turnUuid: resumed.uuid, resumeReason: reason })],
        ]);
        expect(await db.daemonExecution.findUniqueOrThrow({ where: { uuid: run.execution.uuid } })).toMatchObject({ status: "running", interruptedReason: null });
        expect((await run.sessions.getPendingTurnsForConnection(run.request)).map((turn) => turn.turnUuid)).toEqual([resumed.uuid]);
        expect(await run.sessions.getWakeRecoveryDelivery(auth.companyUuid, developer.actorUuid, run.primary.connection.uuid, resumed.uuid, 1)).toMatchObject({ turnUuid: resumed.uuid });
        context = await run.admit(resumed.uuid);
        expect(await db.daemonSessionTurn.findUniqueOrThrow({ where: { uuid: resumed.uuid } })).toMatchObject({ status: "running", admissionTurnUuids: [resumed.uuid], admissionUuid: context.admissionUuid });
        const created = await run.create(context, `After ${reason} resume`);
        expect(created.inputUuids).toEqual([run.first.uuid, run.second.uuid]);
      }
      expect(await db.daemonSessionTurn.count({ where: { sessionUuid: run.primary.session.uuid, trigger: "resume" } })).toBe(2);
      expect(await db.proposal.count({ where: { companyUuid: auth.companyUuid } })).toBe(3);
    });

    it.each(["secondary-generation", "member-status", "member-admission", "member-missing"])("rejects %s before resume without continuation or control and restores interruption", async (failure) => {
      const run = await fixture();
      await run.interrupt();
      if (failure === "secondary-generation") await db.idea.update({ where: { uuid: run.second.uuid }, data: { teamGeneration: { increment: 1 } } });
      if (failure === "member-status") await db.daemonSessionTurn.update({ where: { uuid: run.secondary.uuid }, data: { status: "pending" } });
      if (failure === "member-admission") await db.daemonSessionTurn.update({ where: { uuid: run.secondary.uuid }, data: { admissionUuid: randomUUID() } });
      if (failure === "member-missing") await db.daemonSessionTurn.delete({ where: { uuid: run.secondary.uuid } });
      const turnCount = await db.daemonSessionTurn.count({ where: { sessionUuid: run.primary.session.uuid } });
      for (let attempt = 0; attempt < 2; attempt++) {
        state.emit.mockClear();
        expect((await run.resume()).status).toBe(409);
        expect(state.emit.mock.calls.filter(([name]) => name === `control:${run.primary.connection.uuid}`)).toEqual([]);
        expect(await db.daemonExecution.findUniqueOrThrow({ where: { uuid: run.execution.uuid } })).toMatchObject({ status: "interrupted", interruptedReason: "user" });
        expect(await db.daemonSessionTurn.findUniqueOrThrow({ where: { uuid: run.primary.turn.uuid } })).toMatchObject({ status: "interrupted" });
        expect(await db.daemonSessionTurn.count({ where: { sessionUuid: run.primary.session.uuid } })).toBe(turnCount);
        expect(await db.daemonSessionTurn.count({ where: { sessionUuid: run.primary.session.uuid, trigger: "resume" } })).toBe(0);
      }
    });

    it.each(["pending", "admitted", "repeated-resume"])("rejects secondary revocation after continuation creation at %s", async (phase) => {
      const run = await fixture();
      await run.interrupt();
      let resumed = await run.continuation();
      if (phase === "repeated-resume") {
        const context = await run.admit(resumed.uuid);
        await run.create(context, "Before repeated interruption");
        await run.interrupt(context.turnUuid, context.admissionUuid, "crash");
        resumed = await run.continuation();
      }
      const context = phase === "admitted" ? await run.admit(resumed.uuid) : { ...actor(developer), turnUuid: resumed.uuid, admissionUuid: randomUUID() };
      await db.idea.update({ where: { uuid: run.second.uuid }, data: { teamGeneration: { increment: 1 } } });
      expect(await run.sessions.getPendingTurnsForConnection(run.request)).toEqual([]);
      expect(await run.sessions.getWakeRecoveryDelivery(auth.companyUuid, developer.actorUuid, run.primary.connection.uuid, resumed.uuid, 1)).toBeNull();
      expect(await run.sessions.advanceTurnForWake({ ...run.request, turnUuid: resumed.uuid, turnUuids: [resumed.uuid], admissionUuid: context.admissionUuid, status: "running" })).toMatchObject({ ok: false });
      await expect(run.create(context, "Revoked continuation must not author")).rejects.toMatchObject({ status: 403 });
      expect(await db.proposal.count({ where: { companyUuid: auth.companyUuid, title: "Revoked continuation must not author" } })).toBe(0);
      expect(await db.daemonSessionTurn.findUniqueOrThrow({ where: { uuid: resumed.uuid } })).toMatchObject({ status: phase === "admitted" ? "running" : "pending", admissionUuid: phase === "admitted" ? context.admissionUuid : null });
    });
  });

  it.each(["generation", "connection", "connection-replaced", "admission", "member-status", "member-admission"])("v1 rejects a coalesced bundle after %s changes", async (failure) => {
    const { first, second, primary, secondary } = await coalescedTeamAdmission("ordinary-first");
    if (failure === "generation") await db.idea.update({ where: { uuid: second.uuid }, data: { teamGeneration: { increment: 1 } } });
    if (failure === "connection") await db.daemonConnection.update({ where: { uuid: primary.connection.uuid }, data: { status: "offline" } });
    if (failure === "connection-replaced") await db.daemonConnection.update({ where: { uuid: primary.connection.uuid }, data: { connectedAt: new Date(Date.now() + 10000) } });
    if (failure === "admission") await db.daemonSessionTurn.update({ where: { uuid: primary.turn.uuid }, data: { admissionUuid: randomUUID() } });
    if (failure === "member-status") await db.daemonSessionTurn.update({ where: { uuid: secondary.uuid }, data: { status: "pending" } });
    if (failure === "member-admission") await db.daemonSessionTurn.update({ where: { uuid: secondary.uuid }, data: { admissionUuid: randomUUID() } });
    await expect(proposals.createProposal({ companyUuid: auth.companyUuid, projectUuid, title: "Must not persist", inputType: "idea", inputUuids: [first.uuid], createdByUuid: developer.actorUuid, actorContext: primary.context })).rejects.toMatchObject({ status: 403 });
    expect(await db.proposal.count({ where: { companyUuid: auth.companyUuid, title: "Must not persist" } })).toBe(0);
  });

  it.each(["idea", "document"])("v1 permits multi-source %s authoring, approval and task verification with current supplementary proofs", async (inputType) => {
    const first = await versionedIdea();
    const second = await versionedIdea();
    await yolo(first.uuid);
    await yolo(second.uuid);
    const primary = await teamTurn(first.uuid);
    const secondary = await teamTurn(second.uuid);
    const headers = new Headers({
      "X-Chorus-Turn-Uuid": primary.turn.uuid,
      "X-Chorus-Admission-Uuid": primary.context.admissionUuid!,
      "X-Chorus-Idea-Team-Turns": JSON.stringify([{ turnUuid: secondary.turn.uuid, admissionUuid: secondary.context.admissionUuid }]),
    });
    const context = { ...actor(developer), ...readIdeaTeamTurnContext(headers).ideaTeamTurn };
    let inputUuids = [first.uuid, second.uuid];
    if (inputType === "document") {
      const ancestor = await proposal(inputUuids, "idea", "approved");
      const document = await db.document.create({ data: { companyUuid: auth.companyUuid, projectUuid, title: "Both sources", type: "prd", proposalUuid: ancestor.uuid, createdByUuid: auth.actorUuid } });
      inputUuids = [document.uuid];
    }
    const draft = await proposals.createProposal({ companyUuid: auth.companyUuid, projectUuid, title: "Combined authoring", inputType, inputUuids, createdByUuid: developer.actorUuid, actorContext: context });
    await proposals.addDocumentDraft(draft.uuid, auth.companyUuid, { type: "prd", title: "Both sources", content: "Combined requirements" }, context);
    const pending = await proposal(inputUuids, inputType);
    await expect(proposals.approveProposal(pending.uuid, auth.companyUuid, developer.actorUuid, null, primary.context)).rejects.toMatchObject({ status: 403 });
    await proposals.approveProposal(pending.uuid, auth.companyUuid, developer.actorUuid, null, context);
    const task = await db.task.create({ data: { companyUuid: auth.companyUuid, projectUuid, title: "Combined verification", status: "to_verify", proposalUuid: pending.uuid, createdByUuid: auth.actorUuid } });
    await db.acceptanceCriterion.create({ data: { taskUuid: task.uuid, description: "Required", required: true, status: "passed", sortOrder: 0 } });
    await tasks.updateTask(task.uuid, { status: "done" }, context);
    expect((await db.task.findUniqueOrThrow({ where: { uuid: task.uuid } })).status).toBe("done");
  });

  it.each(["generation", "admission", "connection", "primary", "different_orchestrator"])("v1 rejects invalid multi-source %s proofs without partial authoring or approval", async (failure) => {
    const first = await versionedIdea();
    const second = await versionedIdea();
    await yolo(first.uuid);
    await yolo(second.uuid);
    const primary = await teamTurn(first.uuid);
    if (failure === "different_orchestrator") await db.idea.update({ where: { uuid: second.uuid }, data: { assigneeUuid: lead.actorUuid, teamLeadAgentUuid: lead.actorUuid } });
    const secondary = await teamTurn(second.uuid, failure === "different_orchestrator" ? lead : developer);
    const context = { ...primary.context, supplementaryTurns: [{ turnUuid: secondary.turn.uuid, admissionUuid: secondary.context.admissionUuid! }] };
    if (failure === "generation" || failure === "primary") await db.idea.update({ where: { uuid: failure === "primary" ? first.uuid : second.uuid }, data: { teamGeneration: { increment: 1 } } });
    if (failure === "admission") context.supplementaryTurns[0].admissionUuid = randomUUID();
    if (failure === "connection") await db.daemonConnection.update({ where: { uuid: secondary.connection.uuid }, data: { status: "offline" } });
    const pending = await proposal([first.uuid, second.uuid]);
    await expect(proposals.approveProposal(pending.uuid, auth.companyUuid, developer.actorUuid, null, context)).rejects.toMatchObject({ status: 403 });
    expect((await db.proposal.findUniqueOrThrow({ where: { uuid: pending.uuid } })).status).toBe("pending");
    await expect(proposals.createProposal({ companyUuid: auth.companyUuid, projectUuid, title: "Rejected combined authoring", inputType: "idea", inputUuids: [first.uuid, second.uuid], createdByUuid: developer.actorUuid, actorContext: context })).rejects.toMatchObject({ status: 403 });
    expect(await db.proposal.count({ where: { companyUuid: auth.companyUuid, title: "Rejected combined authoring" } })).toBe(0);
  });

  it("v1 fences multi-source delegated document authoring against stale secondary ancestry", async () => {
    const first = await versionedIdea();
    const second = await versionedIdea();
    await db.idea.updateMany({ where: { uuid: { in: [first.uuid, second.uuid] } }, data: { teamProductAgentUuid: product.actorUuid } });
    const primary = await teamTurn(first.uuid, product, "product");
    const secondary = await teamTurn(second.uuid, product, "product");
    const context = { ...primary.context, supplementaryTurns: [{ turnUuid: secondary.turn.uuid, admissionUuid: secondary.context.admissionUuid! }] };
    const ancestor = await proposal([first.uuid, second.uuid], "idea", "approved");
    const document = await db.document.create({ data: { companyUuid: auth.companyUuid, projectUuid, title: "Combined sources", type: "prd", proposalUuid: ancestor.uuid, createdByUuid: auth.actorUuid } });
    const draft = await proposals.createProposal({ companyUuid: auth.companyUuid, projectUuid, title: "Delegated combined", inputType: "document", inputUuids: [document.uuid], createdByUuid: product.actorUuid, actorContext: context });
    await proposals.addTaskDraft(draft.uuid, auth.companyUuid, { title: "Current", acceptanceCriteriaItems: [{ description: "Works" }] }, context);
    await db.idea.update({ where: { uuid: second.uuid }, data: { teamGeneration: { increment: 1 } } });
    await expect(proposals.addDocumentDraft(draft.uuid, auth.companyUuid, { type: "prd", title: "Stale", content: "Must not persist" }, context)).rejects.toMatchObject({ status: 403 });
    expect((await db.proposal.findUniqueOrThrow({ where: { uuid: draft.uuid } })).documentDrafts).toBeNull();
  });

  it.each(["current", "schedule", "admission", "mutation"])("v1 persists every lifecycle source and fences secondary changes at %s", async (phase) => {
    const first = await versionedIdea();
    const second = await versionedIdea();
    await yolo(first.uuid);
    await yolo(second.uuid);
    const target = await pinnedConnection(developer, "multi-host", "/multi");
    const pending = await proposal([first.uuid, second.uuid]);
    const { createActivity } = await import("../activity.service");
    const { handleActivity } = await import("../notification-listener");
    const sessions = await import("../daemon-session.service");
    const activity = await createActivity({ companyUuid: auth.companyUuid, projectUuid, targetType: "proposal", targetUuid: pending.uuid, actorType: "agent", actorUuid: product.actorUuid, action: "submitted" });
    if (phase === "schedule") await db.idea.update({ where: { uuid: second.uuid }, data: { teamGeneration: { increment: 1 } } });
    await handleActivity(activity);
    const turn = await db.daemonSessionTurn.findFirst({ where: { wakeNotification: { entityUuid: pending.uuid }, session: { agentUuid: developer.actorUuid } }, include: { session: true } });
    if (phase === "schedule") {
      expect(turn).toBeNull();
      return;
    }
    expect(turn).not.toBeNull();
    expect(turn!.wakeContext).toMatchObject({ ideaTeam: { ideaUuid: first.uuid }, ideaTeams: [{ ideaUuid: first.uuid, generation: 1 }, { ideaUuid: second.uuid, generation: 1 }] });
    const admissionUuid = randomUUID();
    const request = { companyUuid: auth.companyUuid, agentUuid: developer.actorUuid, connectionUuid: target.connection.uuid, sessionId: turn!.session.sessionId, turnUuid: turn!.uuid, status: "running" as const, wakeRecoveryProtocol: 1 as const, ideaTeamProtocol: 1 as const, admissionUuid, turnUuids: [turn!.uuid] };
    if (phase === "admission") await db.idea.update({ where: { uuid: second.uuid }, data: { teamGeneration: { increment: 1 } } });
    expect((await sessions.getPendingTurnsForConnection(request)).map((row) => row.turnUuid)).toEqual(phase === "admission" ? [] : [turn!.uuid]);
    const result = await sessions.advanceTurnForWake(request);
    expect(result.ok).toBe(phase !== "admission");
    if (phase === "admission") {
      expect(await sessions.getWakeRecoveryDelivery(auth.companyUuid, developer.actorUuid, target.connection.uuid, turn!.uuid, 1)).toBeNull();
      return;
    }
    const context = { ...actor(developer), turnUuid: turn!.uuid, admissionUuid };
    if (phase === "mutation") {
      await db.idea.update({ where: { uuid: second.uuid }, data: { teamGeneration: { increment: 1 } } });
      await expect(proposals.approveProposal(pending.uuid, auth.companyUuid, developer.actorUuid, null, context)).rejects.toMatchObject({ status: 403 });
      expect((await db.proposal.findUniqueOrThrow({ where: { uuid: pending.uuid } })).status).toBe("pending");
    } else {
      await proposals.approveProposal(pending.uuid, auth.companyUuid, developer.actorUuid, null, context);
      expect((await db.proposal.findUniqueOrThrow({ where: { uuid: pending.uuid } })).status).toBe("approved");
    }
  });

  it("v1 re-delegation invalidates the same delegate's earlier authoring turn", async () => {
    const source = await versionedIdea();
    await service.delegateIdeaTeamProduct(auth, source.uuid, product.actorUuid);
    const old = await teamTurn(source.uuid, product, "product");
    const draft = await proposals.createProposal({ companyUuid: auth.companyUuid, projectUuid, title: "Delegated", inputType: "idea", inputUuids: [source.uuid], createdByUuid: product.actorUuid, actorContext: old.context });
    await proposals.addDocumentDraft(draft.uuid, auth.companyUuid, { type: "prd", title: "PRD", content: "Requirement" }, old.context);
    await service.delegateIdeaTeamProduct(auth, source.uuid, product.actorUuid);
    expect((await db.idea.findUniqueOrThrow({ where: { uuid: source.uuid } })).teamGeneration).toBe(3);
    await expect(proposals.addTaskDraft(draft.uuid, auth.companyUuid, { title: "Stale", acceptanceCriteriaItems: [{ description: "Fails" }] }, old.context)).rejects.toMatchObject({ status: 403 });
    await expect(proposals.submitProposal(draft.uuid, auth.companyUuid, old.context)).rejects.toMatchObject({ status: 403 });
    const current = await teamTurn(source.uuid, product, "product");
    const elaboration = await import("../elaboration.service");
    const questions = [{ id: "scope", text: "Scope?", category: "scope" as const, options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }];
    await expect(elaboration.startElaboration({ companyUuid: auth.companyUuid, ideaUuid: source.uuid, actorUuid: product.actorUuid, actorType: "agent", actorContext: old.context, depth: "minimal", questions })).rejects.toMatchObject({ status: 403 });
    const round = await elaboration.startElaboration({ companyUuid: auth.companyUuid, ideaUuid: source.uuid, actorUuid: product.actorUuid, actorType: "agent", actorContext: current.context, depth: "minimal", questions });
    await expect(elaboration.answerElaboration({ companyUuid: auth.companyUuid, ideaUuid: source.uuid, roundUuid: round.uuid, actorUuid: product.actorUuid, actorType: "agent", actorContext: old.context, answers: [{ questionId: "scope", selectedOptionId: "yes", customText: null }] })).rejects.toMatchObject({ status: 403 });
    await expect(elaboration.skipElaboration({ companyUuid: auth.companyUuid, ideaUuid: source.uuid, actorUuid: product.actorUuid, actorType: "agent", actorContext: current.context, actorIsIdeaAdmin: true, reason: "Not the orchestrator" })).rejects.toMatchObject({ status: 403 });
    await proposals.addTaskDraft(draft.uuid, auth.companyUuid, { title: "Current", acceptanceCriteriaItems: [{ description: "Works" }] }, current.context);
    await expect(proposals.addDocumentDraft(draft.uuid, auth.companyUuid, { type: "prd", title: "Unfenced", content: "No" }, actor(product))).rejects.toThrow("Upgrade");
  });

  it("v1 schedules a fresh orchestrator turn when that same orchestrator delegates", async () => {
    const source = await versionedIdea();
    const admitted = await teamTurn(source.uuid);
    await pinnedConnection(product, "product-host", "/product");
    await service.delegateIdeaTeamProduct(admitted.auth, source.uuid, product.actorUuid);
    await expect(service.assertIdeaTeamCurrentTurn(auth.companyUuid, source.uuid, admitted.context)).rejects.toMatchObject({ status: 403 });
    const delegated = await db.activity.findFirstOrThrow({ where: { targetUuid: source.uuid, action: "product_delegated" } });
    const { handleActivity } = await import("../notification-listener");
    await handleActivity(delegated);
    const notifications = await db.notification.findMany({ where: { entityUuid: source.uuid, action: { in: ["team_product_handoff", "team_lead_handoff"] }, uuid: { not: admitted.wakeContext.notificationUuid } } });
    expect(notifications.map((notification) => notification.recipientUuid).sort()).toEqual([developer.actorUuid, product.actorUuid].sort());
    const fresh = await db.daemonSessionTurn.findMany({ where: { wakeNotificationUuid: { in: notifications.map((notification) => notification.uuid) } } });
    expect(fresh).toHaveLength(2);
    for (const turn of fresh) expect(turn.wakeContext).toMatchObject({ ideaTeam: { generation: 2 } });
  });

  it("v1 keeps the authorized self-assignment kickoff despite actor-self notification exclusion", async () => {
    const source = await idea({}, false);
    await pinnedConnection(developer, "self-host", "/self");
    const assignment = await import("../idea-assignment-authorization.service");
    const proof = await assignment.issueIdeaAssignmentAuthorization(auth, { ideaUuid: source.uuid, agentUuid: developer.actorUuid, requestUuid: randomUUID() });
    const result = await assignment.assignIdeaWithAuthority(developer, { ideaUuid: source.uuid, assigneeType: "agent", assigneeUuid: developer.actorUuid, humanAuthorizationUuid: proof.uuid, operationUuid: randomUUID() });
    expect(result.kickoff).toBe(true);
    const event = await db.activity.findUniqueOrThrow({ where: { uuid: result.activityUuid! } });
    const { handleActivity } = await import("../notification-listener");
    await handleActivity(event);
    await handleActivity(event);
    expect(await db.daemonSessionTurn.count({ where: { session: { directIdeaUuid: source.uuid } } })).toBe(1);
  });

  it.each(["legacy", "exact_without_team", "current", "stale"])("v1 admission and recovery fence %s clients", async (mode) => {
    const source = await versionedIdea();
    const pending = await teamTurn(source.uuid, developer, "orchestrator", true);
    const sessions = await import("../daemon-session.service");
    if (mode === "stale") await db.idea.update({ where: { uuid: source.uuid }, data: { teamGeneration: { increment: 2 } } });
    const request = { companyUuid: auth.companyUuid, agentUuid: developer.actorUuid, connectionUuid: pending.connection.uuid, sessionId: pending.session.sessionId, turnUuid: pending.turn.uuid, status: "running" as const };
    const supported = mode === "current" || mode === "stale";
    const turns = await sessions.getPendingTurnsForConnection({ ...request, wakeRecoveryProtocol: 1, ...(supported ? { ideaTeamProtocol: 1 as const } : {}) });
    expect(turns.map((turn) => turn.turnUuid)).toEqual(mode === "current" ? [pending.turn.uuid] : []);
    const result = await sessions.advanceTurnForWake({ ...request, ...(mode !== "legacy" ? { wakeRecoveryProtocol: 1 as const, admissionUuid: pending.context.admissionUuid, turnUuids: [pending.turn.uuid] } : {}), ...(supported ? { ideaTeamProtocol: 1 as const } : {}) });
    expect(result.ok).toBe(mode === "current");
    expect((await db.daemonSessionTurn.findUniqueOrThrow({ where: { uuid: pending.turn.uuid } })).status).toBe(mode === "current" ? "running" : "pending");
  });

  it("v1 rejects legacy unfenced handoff after opt-in without killing a running task", async () => {
    const source = await versionedIdea();
    const pending = await teamTurn(source.uuid, developer, "orchestrator", true);
    const { ideaTeam: _fence, ...legacyContext } = pending.wakeContext;
    await db.daemonSessionTurn.update({ where: { uuid: pending.turn.uuid }, data: { wakeContext: legacyContext } });
    const execution = await db.daemonExecution.create({ data: { companyUuid: auth.companyUuid, agentUuid: developer.actorUuid, connectionUuid: pending.connection.uuid, entityType: "task", entityUuid: randomUUID(), status: "running" } });
    const sessions = await import("../daemon-session.service");
    expect(await sessions.getWakeRecoveryDelivery(auth.companyUuid, developer.actorUuid, pending.connection.uuid, pending.turn.uuid, 1)).toBeNull();
    expect((await db.daemonExecution.findUniqueOrThrow({ where: { uuid: execution.uuid } })).status).toBe("running");
  });

  it("v1 fences creation turns even when the legacy trigger is human_instruction", async () => {
    const source = await versionedIdea();
    const pending = await teamTurn(source.uuid, developer, "orchestrator", true);
    await db.daemonSessionTurn.update({ where: { uuid: pending.turn.uuid }, data: { trigger: "human_instruction" } });
    const sessions = await import("../daemon-session.service");
    expect(await sessions.getWakeRecoveryDelivery(auth.companyUuid, developer.actorUuid, pending.connection.uuid, pending.turn.uuid)).toBeNull();
    expect(await sessions.getWakeRecoveryDelivery(auth.companyUuid, developer.actorUuid, pending.connection.uuid, pending.turn.uuid, 1)).toMatchObject({ turnUuid: pending.turn.uuid });
    await db.idea.update({ where: { uuid: source.uuid }, data: { teamGeneration: { increment: 1 } } });
    expect(await sessions.getWakeRecoveryDelivery(auth.companyUuid, developer.actorUuid, pending.connection.uuid, pending.turn.uuid, 1)).toBeNull();
    await expect(sessions.createPendingTurn({ sessionUuid: pending.session.uuid, trigger: "human_instruction", wakeContext: pending.wakeContext })).rejects.toMatchObject({ status: 403 });
  });

  it("v1 resumes with the original generation and refuses stale recovery", async () => {
    const source = await versionedIdea();
    const admitted = await teamTurn(source.uuid);
    const execution = await db.daemonExecution.create({ data: { companyUuid: auth.companyUuid, agentUuid: developer.actorUuid, connectionUuid: admitted.connection.uuid, entityType: "idea", entityUuid: source.uuid, status: "interrupted" } });
    await db.daemonSessionTurn.update({ where: { uuid: admitted.turn.uuid }, data: { status: "interrupted", executionUuid: execution.uuid } });
    const sessions = await import("../daemon-session.service");
    const resumed = await sessions.createResumeTurn({ sessionUuid: admitted.session.uuid, executionUuid: execution.uuid, resumedFrom: "user" });
    expect(resumed.uuid).not.toBe(admitted.turn.uuid);
    expect((await db.daemonSessionTurn.findUniqueOrThrow({ where: { uuid: resumed.uuid } })).wakeContext).toMatchObject({ ideaTeam: admitted.fence });
    await db.idea.update({ where: { uuid: source.uuid }, data: { teamGeneration: { increment: 2 } } });
    await expect(sessions.createResumeTurn({ sessionUuid: admitted.session.uuid, executionUuid: execution.uuid, resumedFrom: "crash" })).rejects.toMatchObject({ status: 403 });
    expect(await sessions.getWakeRecoveryDelivery(auth.companyUuid, developer.actorUuid, admitted.connection.uuid, resumed.uuid, 1)).toBeNull();
  });

  it("v1 captures ordinary assignment generation before delayed notification scheduling", async () => {
    const source = await idea({}, false);
    await pinnedConnection(developer, "host", "/work");
    const assignment = await import("../idea-assignment-authorization.service");
    const first = await assignment.assignIdeaWithAuthority(auth, { ideaUuid: source.uuid, assigneeType: "agent", assigneeUuid: developer.actorUuid, operationUuid: randomUUID() });
    const event = await db.activity.findUniqueOrThrow({ where: { uuid: first.activityUuid! } });
    expect(event.value).toMatchObject({ ideaTeamFences: [{ ideaUuid: source.uuid, generation: 1, role: "orchestrator" }] });
    await assignment.assignIdeaWithAuthority(auth, { ideaUuid: source.uuid, assigneeType: "agent", assigneeUuid: developer.actorUuid, operationUuid: randomUUID() });
    const { handleActivity } = await import("../notification-listener");
    await handleActivity(event);
    expect(await db.daemonSessionTurn.count({ where: { session: { directIdeaUuid: source.uuid } } })).toBe(0);
    const deliveries = state.emit.mock.calls.filter(([name]) => name === `notification:agent:${developer.actorUuid}`);
    expect(deliveries.at(-1)?.[1]).toMatchObject({ suppressWake: true, ideaTeamRequired: true });
    const latest = await db.activity.findFirstOrThrow({ where: { companyUuid: auth.companyUuid, targetUuid: source.uuid, action: "assigned" }, orderBy: { createdAt: "desc" } });
    await handleActivity(latest);
    const turn = await db.daemonSessionTurn.findFirstOrThrow({ where: { session: { directIdeaUuid: source.uuid } } });
    expect(turn.wakeContext).toMatchObject({ ideaTeam: { generation: 2, agentUuid: developer.actorUuid, role: "orchestrator" } });
  });

  it("v1 marker alone keeps cleared/no-Team creation and assignment wakes unmanaged", async () => {
    const source = await idea({ teamEnrollmentVersion: 1, teamGeneration: 1, assigneeType: "agent", assigneeUuid: developer.actorUuid }, false);
    expect(await service.canReceiveIdeaTeamWake(auth.companyUuid, developer.actorUuid, null, source.uuid)).toBe(true);
    const context = { version: 1 as const, notificationUuid: randomUUID(), notification: { uuid: "", action: "idea_claimed", entityType: "idea", entityUuid: source.uuid, projectUuid, projectName: "Project", recipientType: "agent" as const, recipientUuid: developer.actorUuid, actorType: "user", actorUuid: auth.actorUuid, actorName: "Owner", message: "Assigned", entityTitle: "Idea" } };
    context.notification.uuid = context.notificationUuid;
    expect(await service.canReceiveIdeaTeamWake(auth.companyUuid, developer.actorUuid, context, source.uuid)).toBe(true);
    expect(await service.getIdeaTeamContext(developer, source.uuid)).toMatchObject({ managed: false, state: "unmanaged", routing: null });
    expect(await service.getIdeaTeamContext(developer, source.uuid)).toMatchObject({ orchestrator: { agentUuid: developer.actorUuid }, reason: "human_assignment_required" });
  });

  it("v1 exposes safe receiver-owner confirmation without disclosing proof or private routing", async () => {
    const source = await idea({}, false);
    const receiver = await db.user.create({ data: { companyUuid: auth.companyUuid, oidcSub: randomUUID() } });
    const other = await agent("Receiver agent", { type: "user", companyUuid: auth.companyUuid, actorUuid: receiver.uuid });
    const assignment = await import("../idea-assignment-authorization.service");
    await assignment.assignIdeaWithAuthority(auth, { ideaUuid: source.uuid, assigneeType: "agent", assigneeUuid: other.actorUuid, operationUuid: randomUUID() });
    const context = await service.getIdeaTeamContext(auth, source.uuid);
    expect(context).toMatchObject({ managed: false, state: "unmanaged", orchestrator: { agentUuid: other.actorUuid, agentName: "Receiver agent" }, reason: "owner_confirmation_required", routing: null });
    expect(JSON.stringify(context)).not.toContain("humanAuthorizerUuid");
    expect(JSON.stringify(context)).not.toContain(receiver.uuid);
  });

  it("v1 rechecks delegation generation after a draft transaction serialization rollback", async () => {
    const source = await versionedIdea();
    await service.delegateIdeaTeamProduct(auth, source.uuid, product.actorUuid);
    const admitted = await teamTurn(source.uuid, product, "product");
    const draft = await proposal([source.uuid], "idea", "draft");
    const original = db.$transaction.bind(db);
    let attempts = 0;
    const transaction = vi.spyOn(db, "$transaction");
    transaction.mockImplementation((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: Parameters<typeof db.$transaction>[1]) => {
      attempts++;
      try {
        return await original(async (tx) => {
          const result = await work(tx);
          if (attempts === 1) throw { code: "P2034" };
          return result;
        }, options);
      } catch (error) {
        if (attempts === 1) await db.idea.update({ where: { uuid: source.uuid }, data: { teamGeneration: { increment: 1 } } });
        throw error;
      }
    }) as typeof db.$transaction);
    try {
      await expect(proposals.addDocumentDraft(draft.uuid, auth.companyUuid, { type: "prd", title: "Must roll back", content: "No stale authoring" }, admitted.context)).rejects.toMatchObject({ status: 403 });
      expect(attempts).toBe(2);
      expect((await db.proposal.findUniqueOrThrow({ where: { uuid: draft.uuid } })).documentDrafts).toBeNull();
    } finally {
      transaction.mockRestore();
    }
  });

  it("prefers load over dependency affinity, affinity over ties, and reopened instance assignee over load", async () => {
    const managed = await idea();
    const approved = await proposal([managed.uuid], "idea", "approved");
    const second = await agent("Developer 2");
    await db.agentTeamMember.create({ data: { teamUuid: templateUuid, role: "development", agentUuid: second.actorUuid } });
    await online(developer, 1);
    await online(second);
    const instance = await db.agentInstance.create({ data: { companyUuid: auth.companyUuid, agentUuid: developer.actorUuid, host: "host", cwd: "/work" } });
    const dependency = await db.task.create({ data: { companyUuid: auth.companyUuid, projectUuid, proposalUuid: approved.uuid, title: "Dependency", status: "done", assigneeType: "agent_instance", assigneeUuid: instance.uuid, createdByUuid: auth.actorUuid } });
    const task = await db.task.create({ data: { companyUuid: auth.companyUuid, projectUuid, proposalUuid: approved.uuid, title: "Work", assigneeType: "agent_instance", assigneeUuid: instance.uuid, createdByUuid: auth.actorUuid, dependsOn: { create: { dependsOnUuid: dependency.uuid } } } });
    expect((await service.recommendIdeaTeamRole(lead, managed.uuid, "development", task.uuid)).agentUuid).toBe(second.actorUuid);
    await db.daemonExecution.deleteMany({ where: { agentUuid: developer.actorUuid } });
    expect((await service.recommendIdeaTeamRole(lead, managed.uuid, "development", task.uuid)).agentUuid).toBe(developer.actorUuid);
    expect((await service.recommendIdeaTeamRole(lead, managed.uuid, "development")).decision).toBe("lead_decision");
    await online(developer, 2);
    await db.activity.create({ data: { companyUuid: auth.companyUuid, projectUuid, targetType: "task", targetUuid: task.uuid, action: "reopened", ...actor(auth) } });
    expect(await service.recommendIdeaTeamRole(lead, managed.uuid, "development", task.uuid)).toMatchObject({ agentUuid: developer.actorUuid, reason: "reopen_affinity" });
    await db.task.update({ where: { uuid: task.uuid }, data: { status: "to_verify" } });
    await tasks.updateTask(task.uuid, { status: "in_progress" }, actor(lead));
    await db.task.update({ where: { uuid: task.uuid }, data: { assigneeType: "agent", assigneeUuid: second.actorUuid } });
    expect(await service.recommendIdeaTeamRole(lead, managed.uuid, "development", task.uuid)).toMatchObject({ agentUuid: developer.actorUuid, reason: "reopen_affinity" });
  });
});
