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
    await ideas.assignIdea({ ideaUuid: unassigned.uuid, companyUuid: auth.companyUuid, assigneeType: "agent", assigneeUuid: lead.actorUuid, instanceUuid: instance.uuid, assignedByType: "user", assignedByUuid: auth.actorUuid });
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
