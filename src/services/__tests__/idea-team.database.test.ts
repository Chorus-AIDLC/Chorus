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
import type { AuthContext } from "@/types/auth";

vi.mock("@/generated/prisma/client", async () => import("../../generated/prisma/client"));
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emit: vi.fn(), emitChange: vi.fn(), on: vi.fn() }, controlEventName: (uuid: string) => `control:${uuid}`, transcriptEventName: (uuid: string) => `transcript:${uuid}` }));

describe("Idea Team (derived, zero-schema) against isolated PostgreSQL", () => {
  let database: PGlite;
  let server: PGLiteSocketServer;
  let directory: string;
  let pool: pg.Pool;
  let db: PrismaClient;
  let service: typeof import("../idea-team.service");
  let proposals: typeof import("../proposal.service");
  let tasks: typeof import("../task.service");
  let elaboration: typeof import("../elaboration.service");
  let owner: AuthContext;
  let lead: AuthContext;
  let product: AuthContext;
  let developer: AuthContext;
  let outsider: AuthContext;
  let projectUuid: string;
  let bindingCreatedAt: Date;

  beforeAll(async () => {
    database = new PGlite();
    for (const migration of (await readdir("prisma/migrations")).filter((name) => /^\d/.test(name)).sort()) {
      await database.exec(await readFile(join("prisma/migrations", migration, "migration.sql"), "utf8"));
    }
    directory = await mkdtemp(join(tmpdir(), "chorus-idea-team-lite-"));
    server = new PGLiteSocketServer({ db: database, path: join(directory, ".s.PGSQL.5432") });
    await server.start();
    pool = new pg.Pool({ host: directory, port: 5432, database: "postgres", user: "postgres", max: 1 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    service = await import("../idea-team.service");
    proposals = await import("../proposal.service");
    tasks = await import("../task.service");
    elaboration = await import("../elaboration.service");
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    await pool?.end();
    await server?.stop();
    await database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function user(companyUuid: string): Promise<AuthContext> {
    const created = await db.user.create({ data: { companyUuid, oidcSub: randomUUID() } });
    return { type: "user", companyUuid, actorUuid: created.uuid };
  }

  async function agent(name: string, of: AuthContext, roles = ["admin_agent"]): Promise<AuthContext> {
    const created = await db.agent.create({ data: { companyUuid: of.companyUuid, ownerUuid: of.actorUuid, name, roles } });
    return { type: "agent", companyUuid: of.companyUuid, actorUuid: created.uuid, ownerUuid: of.actorUuid };
  }

  const actor = (identity: AuthContext) => ({ actorType: identity.type, actorUuid: identity.actorUuid });
  const later = () => new Date(bindingCreatedAt.getTime() + 1);

  beforeEach(async () => {
    const company = await db.company.create({ data: { name: `Team ${randomUUID()}` } });
    owner = await user(company.uuid);
    lead = await agent("Lead", owner);
    product = await agent("Product", owner);
    developer = await agent("Developer", owner);
    outsider = await agent("Outsider", await user(company.uuid));
    projectUuid = (await db.project.create({ data: { companyUuid: company.uuid, name: "Team Project", createdByUuid: owner.actorUuid } })).uuid;
    for (const member of [outsider]) await db.projectMember.create({ data: { companyUuid: company.uuid, projectUuid, userUuid: (await db.agent.findUniqueOrThrow({ where: { uuid: member.actorUuid } })).ownerUuid!, role: "editor" } }).catch(() => {});
    const template = await db.agentTeam.create({ data: { companyUuid: company.uuid, ownerUuid: owner.actorUuid, name: "Team", members: { create: [
      { role: "lead", agentUuid: lead.actorUuid }, { role: "product", agentUuid: product.actorUuid }, { role: "development", agentUuid: developer.actorUuid },
    ] } } });
    bindingCreatedAt = (await db.projectAgentTeam.create({ data: { companyUuid: company.uuid, ownerUuid: owner.actorUuid, projectUuid, templateUuid: template.uuid, templateName: "Team", snapshot: {} } })).createdAt;
  });

  // An Idea assigned to `assignee` by `by` (default: the owner, after the Team binding).
  async function idea(assignee: AuthContext | null, by: AuthContext | null = owner, data: Partial<Prisma.IdeaUncheckedCreateInput> = {}) {
    return db.idea.create({ data: {
      companyUuid: owner.companyUuid, projectUuid, title: "Idea", createdByUuid: owner.actorUuid, status: "elaborating",
      ...(assignee ? { assigneeType: "agent", assigneeUuid: assignee.actorUuid, assignedAt: later() } : {}),
      ...(assignee && by ? { assignedByType: by.type, assignedByUuid: by.actorUuid } : {}),
      ...data,
    } });
  }

  async function proposal(inputUuids: string[], inputType = "idea", status = "pending") {
    return db.proposal.create({ data: { companyUuid: owner.companyUuid, projectUuid, title: "Proposal", createdByUuid: product.actorUuid, createdByType: "agent", inputType, inputUuids, status } });
  }

  async function yolo(ideaUuid: string, by: AuthContext = owner) {
    await db.activity.create({ data: { companyUuid: owner.companyUuid, projectUuid, targetType: "idea", targetUuid: ideaUuid, action: "yolo_requested", actorType: by.type, actorUuid: by.actorUuid } });
  }

  it("manages an Idea the owner assigns to ANY of their agents, not only the Team lead", async () => {
    const managed = await idea(developer);
    expect(await service.getIdeaTeamContext(owner, managed.uuid)).toMatchObject({
      managed: true, state: "active", orchestrator: { agentUuid: developer.actorUuid },
    });
    const second = await idea(lead);
    expect((await service.getIdeaTeamContext(owner, second.uuid)).orchestrator?.agentUuid).toBe(lead.actorUuid);
  });

  it("keeps creation, self-claims, foreign assignment and pre-binding assignment unmanaged", async () => {
    const cases = [
      await idea(null),
      await idea(lead, lead),
      await idea(lead, await user(owner.companyUuid)),
      await idea(lead, owner, { assignedAt: new Date(bindingCreatedAt.getTime() - 60_000) }),
      await idea(outsider),
    ];
    for (const entry of cases) expect((await service.getIdeaTeamContext(owner, entry.uuid)).state).toBe("unmanaged");
  });

  it("inherits authority for child Ideas the parent's agent assigns, and keeps it after the parent is reassigned", async () => {
    const parent = await idea(lead, owner, { isContainer: true });
    const child = await idea(developer, lead, { parentUuid: parent.uuid });
    expect(await service.getIdeaTeamContext(owner, child.uuid)).toMatchObject({ managed: true, orchestrator: { agentUuid: developer.actorUuid } });
    const grandchild = await idea(product, developer, { parentUuid: child.uuid });
    expect((await service.getIdeaTeamContext(owner, grandchild.uuid)).managed).toBe(true);
    await db.idea.update({ where: { uuid: parent.uuid }, data: { assigneeUuid: product.actorUuid, assignedAt: later() } });
    expect((await service.getIdeaTeamContext(owner, child.uuid)).managed).toBe(true);
    const foreign = await idea(developer, outsider, { parentUuid: parent.uuid });
    expect((await service.getIdeaTeamContext(owner, foreign.uuid)).managed).toBe(false);
    const orphanChild = await idea(developer, lead, { parentUuid: (await idea(lead, lead)).uuid });
    expect((await service.getIdeaTeamContext(owner, orphanChild.uuid)).managed).toBe(false);
  });

  it("unbinding the Team returns managed Ideas to the legacy workflow", async () => {
    const managed = await idea(lead);
    await db.projectAgentTeam.deleteMany({ where: { projectUuid } });
    expect((await service.getIdeaTeamContext(owner, managed.uuid)).state).toBe("unmanaged");
  });

  it("pauses when the orchestrator loses eligibility, stopping Team routing", async () => {
    const managed = await idea(lead);
    await db.agent.update({ where: { uuid: lead.actorUuid }, data: { roles: [], permissions: ["task:admin"] } });
    expect(await service.getIdeaTeamContext(owner, managed.uuid)).toMatchObject({ state: "paused", reason: "orchestrator_ineligible" });
    expect(await service.recommendIdeaTeamRole(owner, managed.uuid, "development")).toMatchObject({ decision: "paused" });
    await expect(service.delegateIdeaTeamProduct(owner, managed.uuid, product.actorUuid)).rejects.toThrow("paused");
  });

  it("adds no approval gates: any permitted agent approves and verifies as before", async () => {
    const managed = await idea(lead);
    const pending = await proposal([managed.uuid]);
    await proposals.approveProposal(pending.uuid, owner.companyUuid, product.actorUuid, null);
    expect((await db.proposal.findUniqueOrThrow({ where: { uuid: pending.uuid } })).status).toBe("approved");
    const task = await db.task.create({ data: { companyUuid: owner.companyUuid, projectUuid, title: "Task", status: "to_verify", proposalUuid: pending.uuid, createdByUuid: owner.actorUuid } });
    await tasks.updateTask(task.uuid, { status: "done" }, actor(developer));
  });

  it("product delegation lets the delegate author without owning the Idea; reassignment revokes it", async () => {
    const managed = await idea(lead);
    await expect(service.delegateIdeaTeamProduct(developer, managed.uuid, product.actorUuid)).rejects.toThrow("current assignee");
    await expect(service.delegateIdeaTeamProduct(lead, managed.uuid, developer.actorUuid)).rejects.toThrow("eligible product member");
    const context = await service.delegateIdeaTeamProduct(lead, managed.uuid, product.actorUuid);
    expect(context.routing?.productAgentUuid).toBe(product.actorUuid);
    expect(await service.isIdeaTeamProductDelegate(owner.companyUuid, managed.uuid, product.actorUuid)).toBe(true);
    expect(await proposals.checkIdeasAssignee(owner.companyUuid, [managed.uuid], product.actorUuid, "agent")).toMatchObject({ valid: true });
    expect(await db.comment.count({ where: { targetUuid: managed.uuid, content: { contains: `agent:${product.actorUuid}` } } })).toBe(1);
    await elaboration.startElaboration({ companyUuid: owner.companyUuid, ideaUuid: managed.uuid, actorUuid: product.actorUuid, actorType: "agent", depth: "minimal",
      questions: [{ id: "q1", text: "Scope?", category: "scope", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] });
    await db.idea.update({ where: { uuid: managed.uuid }, data: { assigneeUuid: developer.actorUuid, assignedAt: new Date(Date.now() + 120_000) } });
    expect(await service.isIdeaTeamProductDelegate(owner.companyUuid, managed.uuid, product.actorUuid)).toBe(false);
  });

  it("finds orchestrators for lifecycle handoff through tasks and document ancestry", async () => {
    const managed = await idea(lead);
    const source = await proposal([managed.uuid], "idea", "approved");
    const document = await db.document.create({ data: { companyUuid: owner.companyUuid, projectUuid, title: "PRD", type: "prd", proposalUuid: source.uuid, createdByUuid: owner.actorUuid } });
    const child = await proposal([document.uuid], "document");
    const task = await db.task.create({ data: { companyUuid: owner.companyUuid, projectUuid, title: "Task", status: "to_verify", proposalUuid: child.uuid, createdByUuid: owner.actorUuid } });
    expect(await service.getIdeaTeamOrchestrators(owner.companyUuid, "task", task.uuid)).toEqual([{ ideaUuid: managed.uuid, agentUuid: lead.actorUuid }]);
    expect(await service.getIdeaTeamOrchestrators(owner.companyUuid, "proposal", child.uuid)).toEqual([{ ideaUuid: managed.uuid, agentUuid: lead.actorUuid }]);
  });

  it("returns the private roster only to the Team owner and their agents", async () => {
    const managed = await idea(lead);
    expect((await service.getIdeaTeamContext(lead, managed.uuid)).routing?.roles.product[0].agentUuid).toBe(product.actorUuid);
    await expect(service.recommendIdeaTeamRole(outsider, managed.uuid, "product")).rejects.toMatchObject({ status: expect.any(Number) });
  });

  it("recommends the least-loaded eligible online member and reports manual for empty roles", async () => {
    const managed = await idea(lead);
    await db.agentTeamMember.deleteMany({ where: { role: "product" } });
    expect(await service.recommendIdeaTeamRole(lead, managed.uuid, "product")).toMatchObject({ decision: "manual", reason: "role_empty_or_ineligible" });
    expect(await service.recommendIdeaTeamRole(lead, managed.uuid, "development")).toMatchObject({ decision: "manual", reason: "role_offline" });
  });
  it("falls back to a qualified online orchestrator even when it is outside the Team roster", async () => {
    const outsiderOrchestrator = await agent("Assignee", owner);
    const managed = await idea(outsiderOrchestrator);
    expect(await service.recommendIdeaTeamRole(owner, managed.uuid, "development")).toMatchObject({ decision: "manual", reason: "role_offline" });
    await db.daemonConnection.create({ data: { companyUuid: owner.companyUuid, agentUuid: outsiderOrchestrator.actorUuid, clientType: "codex", status: "online" } });
    expect(await service.recommendIdeaTeamRole(owner, managed.uuid, "development"))
      .toMatchObject({ decision: "recommended", reason: "role_offline_orchestrator_fallback", agentUuid: outsiderOrchestrator.actorUuid });
  });
  it("product fallback to the orchestrator means it does the product work itself", async () => {
    const managed = await idea(lead);
    await db.daemonConnection.create({ data: { companyUuid: owner.companyUuid, agentUuid: lead.actorUuid, clientType: "codex", status: "online" } });
    const recommendation = await service.recommendIdeaTeamRole(lead, managed.uuid, "product");
    expect(recommendation).toMatchObject({ decision: "recommended", reason: "role_offline_orchestrator_fallback", agentUuid: lead.actorUuid });
    await expect(service.delegateIdeaTeamProduct(lead, managed.uuid, recommendation.agentUuid!)).rejects.toThrow("does product work itself");
    await elaboration.startElaboration({ companyUuid: owner.companyUuid, ideaUuid: managed.uuid, actorUuid: lead.actorUuid, actorType: "agent", depth: "minimal",
      questions: [{ id: "q1", text: "Scope?", category: "scope", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] });
    expect((await db.elaborationRound.count({ where: { ideaUuid: managed.uuid } }))).toBe(1);
  });
});
