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
import type { UserAuthContext } from "@/types/auth";
import type { ProjectTeamHandoffResult } from "../project-team-handoff.service";

vi.mock("@/generated/prisma/client", async () => import("../../generated/prisma/client"));
const state = vi.hoisted(() => ({ db: null as unknown, emit: vi.fn(), emitChange: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/event-bus", () => ({
  eventBus: { emit: state.emit, emitChange: state.emitChange, on: vi.fn() },
  controlEventName: (uuid: string) => `control:${uuid}`,
  transcriptEventName: (uuid: string) => `transcript:${uuid}`,
}));
vi.mock("@/services/daemon-instruction.service", () => ({ deliverTurnPing: vi.fn() }));

describe("project team handoff against isolated PostgreSQL", () => {
  let database: PGlite;
  let server: PGLiteSocketServer;
  let directory: string;
  let pool: pg.Pool;
  let db: PrismaClient;
  let handoff: typeof import("../project-team-handoff.service").handoffProjectTeam;
  let configService: typeof import("../project-agent-team.service");
  let auth: UserAuthContext;
  let other: UserAuthContext;
  let foreign: UserAuthContext;
  let projectUuid: string;
  let templateUuid: string;
  let configUuid: string;
  let leadUuid: string;
  let previousUuid: string;
  let otherAgentUuid: string;
  let foreignAgentUuid: string;

  beforeAll(async () => {
    vi.stubEnv("NEXTAUTH_SECRET", "isolated-project-team-handoff-test-secret");
    database = new PGlite();
    for (const migration of (await readdir("prisma/migrations")).filter((name) => /^\d/.test(name)).sort()) {
      await database.exec(await readFile(join("prisma/migrations", migration, "migration.sql"), "utf8"));
    }
    directory = await mkdtemp(join(tmpdir(), "chorus-project-team-handoff-test-"));
    server = new PGLiteSocketServer({ db: database, path: join(directory, ".s.PGSQL.5432") });
    await server.start();
    pool = new pg.Pool({ host: directory, port: 5432, database: "postgres", user: "postgres", max: 1 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    handoff = (await import("../project-team-handoff.service")).handoffProjectTeam;
    configService = await import("../project-agent-team.service");
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await db?.$disconnect();
    await pool?.end();
    await server?.stop();
    await database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function user(companyUuid: string): Promise<UserAuthContext> {
    const created = await db.user.create({ data: { companyUuid, oidcSub: randomUUID() } });
    return { type: "user", companyUuid, actorUuid: created.uuid };
  }

  async function agent(owner: UserAuthContext, name: string) {
    return db.agent.create({ data: { companyUuid: owner.companyUuid, ownerUuid: owner.actorUuid, name, roles: ["admin_agent"] } });
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    const company = await db.company.create({ data: { name: "Handoff company" } });
    const foreignCompany = await db.company.create({ data: { name: "Foreign company" } });
    other = await user(company.uuid);
    auth = await user(company.uuid);
    foreign = await user(foreignCompany.uuid);
    leadUuid = (await agent(auth, "Lead")).uuid;
    previousUuid = (await agent(auth, "Previous")).uuid;
    otherAgentUuid = (await agent(other, "Other owner")).uuid;
    foreignAgentUuid = (await agent(foreign, "Foreign tenant")).uuid;
    projectUuid = (await db.project.create({ data: { companyUuid: company.uuid, name: "Project", createdByUuid: other.actorUuid } })).uuid;
    templateUuid = (await db.agentTeam.create({ data: {
      companyUuid: company.uuid, ownerUuid: auth.actorUuid, name: "Template",
      members: { create: { role: "lead", agentUuid: leadUuid } },
    } })).uuid;
    configUuid = (await db.projectAgentTeam.create({ data: {
      companyUuid: company.uuid, ownerUuid: auth.actorUuid, projectUuid, templateUuid, templateName: "Template", snapshot: { lead: [leadUuid] },
    } })).uuid;
  });

  const idea = (data: Partial<Prisma.IdeaUncheckedCreateInput> = {}) => db.idea.create({ data: {
    companyUuid: auth.companyUuid, projectUuid, title: "Handoff idea", createdByUuid: other.actorUuid,
    status: "elaborating", assigneeType: "user", assigneeUuid: auth.actorUuid, ...data,
  } });

  async function chain(ideaUuid: string, status: string, createdAt?: Date) {
    const proposal = await db.proposal.create({ data: {
      companyUuid: auth.companyUuid, projectUuid, title: "Approved proposal", inputType: "idea", inputUuids: [ideaUuid],
      status: "approved", createdByUuid: previousUuid, ...(createdAt ? { createdAt } : {}),
    } });
    const task = await db.task.create({ data: {
      companyUuid: auth.companyUuid, projectUuid, title: "Existing task", proposalUuid: proposal.uuid,
      status, assigneeType: "agent", assigneeUuid: previousUuid, createdByUuid: previousUuid,
    } });
    return { proposal, task };
  }

  function preview(leadAgentUuid = leadUuid) {
    return handoff(auth, projectUuid, { leadAgentUuid, preview: true });
  }

  function confirm(result: ProjectTeamHandoffResult, leadAgentUuid = leadUuid, actor = auth, project = projectUuid) {
    if (!("confirmationToken" in result)) throw new Error("Expected preview");
    return handoff(actor, project, { leadAgentUuid, confirmationToken: result.confirmationToken });
  }

  it("previews all owned assignment kinds, not creators, and excludes foreign, dangling, unassigned and completed ideas", async () => {
    const instance = await db.agentInstance.create({ data: { companyUuid: auth.companyUuid, agentUuid: previousUuid, host: "host", cwd: "/work" } });
    const otherInstance = await db.agentInstance.create({ data: { companyUuid: auth.companyUuid, agentUuid: otherAgentUuid, host: "host", cwd: "/work" } });
    const owned = await Promise.all([
      idea(), idea({ assigneeType: "agent", assigneeUuid: previousUuid }),
      idea({ assigneeType: "agent_instance", assigneeUuid: instance.uuid }),
    ]);
    await idea({ createdByUuid: auth.actorUuid, assigneeUuid: other.actorUuid });
    await idea({ assigneeType: "agent", assigneeUuid: otherAgentUuid });
    await idea({ assigneeType: "agent", assigneeUuid: foreignAgentUuid });
    await idea({ assigneeType: "agent_instance", assigneeUuid: otherInstance.uuid });
    await idea({ assigneeType: "agent_instance", assigneeUuid: randomUUID() });
    await idea({ assigneeType: null, assigneeUuid: null });
    await idea({ status: "closed" });
    const completed = await idea({ status: "elaborated" });
    await chain(completed.uuid, "done");
    const before = await db.idea.findMany({ where: { projectUuid } });
    const result = await preview();
    expect(result.candidates.map((candidate) => candidate.uuid).sort()).toEqual(owned.map((row) => row.uuid).sort());
    expect(result.count).toBe(3);
    expect(await db.idea.findMany({ where: { projectUuid } })).toEqual(before);
    expect(await db.activity.count({ where: { projectUuid } })).toBe(0);
    expect(state.emit).not.toHaveBeenCalled();
  });

  it("rolls up nested completed themes and uses the latest approved proposal", async () => {
    const root = await idea({ status: "elaborated", isContainer: true });
    const nested = await idea({ status: "elaborated", isContainer: true, parentUuid: root.uuid });
    const child = await idea({ status: "elaborated", parentUuid: nested.uuid });
    await chain(child.uuid, "in_progress", new Date("2026-01-01"));
    await chain(child.uuid, "closed", new Date("2026-02-01"));
    const childless = await idea({ status: "elaborated", isContainer: true });
    expect((await preview()).candidates.map((candidate) => candidate.uuid)).toEqual([childless.uuid]);
    const unfinished = await idea({ status: "open", parentUuid: nested.uuid });
    const result = await preview();
    expect(result.candidates.map((candidate) => candidate.uuid).sort()).toEqual([root.uuid, nested.uuid, childless.uuid, unfinished.uuid].sort());
  });

  it("handles malformed theme cycles deterministically without recursion", async () => {
    const first = await idea({ status: "elaborated", isContainer: true });
    const second = await idea({ status: "elaborated", isContainer: true, parentUuid: first.uuid });
    await db.idea.update({ where: { uuid: first.uuid }, data: { parentUuid: second.uuid } });
    await chain(first.uuid, "done");
    const result = await preview();
    expect(result.candidates.map((candidate) => candidate.uuid)).toEqual([second.uuid]);
  });

  it("does not cap discovery at fifty candidates", async () => {
    await db.idea.createMany({ data: Array.from({ length: 61 }, (_, index) => ({
      companyUuid: auth.companyUuid, projectUuid, title: `Idea ${index}`, createdByUuid: other.actorUuid,
      assigneeType: "user", assigneeUuid: auth.actorUuid,
    })) });
    expect((await preview()).count).toBe(61);
  });

  it("commits assignment provenance and fixed CWD, preserving task execution and lifecycle", async () => {
    const open = await idea({ status: "open" });
    const building = await idea({ status: "elaborated", elaborationStatus: "resolved", elaborationDepth: "comprehensive" });
    const { proposal, task } = await chain(building.uuid, "in_progress");
    const session = await db.agentSession.create({ data: { companyUuid: auth.companyUuid, agentUuid: previousUuid, name: "Worker" } });
    const checkin = await db.sessionTaskCheckin.create({ data: { sessionUuid: session.uuid, taskUuid: task.uuid } });
    await db.projectAgentCwdPreference.create({ data: {
      companyUuid: auth.companyUuid, userUuid: auth.actorUuid, projectUuid, agentUuid: leadUuid, host: "fixed-host", cwd: "/fixed/repo",
    } });
    const result = await preview();
    expect(await db.agentInstance.count({ where: { agentUuid: leadUuid } })).toBe(0);
    expect(await confirm(result)).toMatchObject({ count: 2, changedCount: 2 });
    const target = await db.agentInstance.findFirstOrThrow({ where: { agentUuid: leadUuid } });
    expect(target).toMatchObject({ companyUuid: auth.companyUuid, host: "fixed-host", cwd: "/fixed/repo" });
    for (const row of [open, building]) {
      expect(await db.idea.findUnique({ where: { uuid: row.uuid } })).toMatchObject({
        assigneeType: "agent_instance", assigneeUuid: target.uuid, assignedByType: "user", assignedByUuid: auth.actorUuid,
        cwdSource: "project_fixed", cwdHost: "fixed-host", runtimeCwd: "/fixed/repo",
        status: row.status === "open" ? "elaborating" : row.status,
        elaborationStatus: row.elaborationStatus, elaborationDepth: row.elaborationDepth,
      });
    }
    expect(await db.task.findUnique({ where: { uuid: task.uuid } })).toEqual(task);
    expect(await db.proposal.findUnique({ where: { uuid: proposal.uuid } })).toEqual(proposal);
    expect(await db.agentSession.findUnique({ where: { uuid: session.uuid } })).toEqual(session);
    expect(await db.sessionTaskCheckin.findUnique({ where: { id: checkin.id } })).toEqual(checkin);
    expect(await db.activity.count({ where: { projectUuid, action: "assigned" } })).toBe(2);
    expect(state.emit).toHaveBeenCalledTimes(2);
    expect(state.emit).toHaveBeenCalledWith("activity", expect.objectContaining({
      actorType: "user", actorUuid: auth.actorUuid, action: "assigned",
      value: { assigneeType: "agent", assigneeUuid: leadUuid, instanceUuid: target.uuid,
        resolvedCwdSource: "project_fixed", resolvedCwdHost: "fixed-host", resolvedRuntimeCwd: "/fixed/repo" },
    }));
    expect(state.emitChange).toHaveBeenCalledTimes(2);
    expect(await db.projectAgentTeam.findUnique({ where: { uuid: configUuid } })).toMatchObject({ lastLeadAgentUuid: leadUuid, revision: 2 });
    await expect(confirm(result)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("enrolls same-logical-agent assignments without changing lifecycle or old pins", async () => {
    const instance = await db.agentInstance.create({ data: { companyUuid: auth.companyUuid, agentUuid: leadUuid, host: "old", cwd: "/old" } });
    const pinned = await idea({ assigneeType: "agent_instance", assigneeUuid: instance.uuid, cwdSource: "project_fixed", cwdHost: "old", runtimeCwd: "/old" });
    const plain = await idea({ assigneeType: "agent", assigneeUuid: leadUuid, status: "open" });
    await db.projectAgentCwdPreference.create({ data: {
      companyUuid: auth.companyUuid, userUuid: auth.actorUuid, projectUuid, agentUuid: leadUuid, host: "new", cwd: "/new",
    } });
    expect(await confirm(await preview())).toMatchObject({ count: 2, changedCount: 0 });
    expect(await db.idea.findUnique({ where: { uuid: pinned.uuid } })).toEqual({ ...pinned, teamOwnerUuid: auth.actorUuid, teamLeadAgentUuid: leadUuid, updatedAt: expect.any(Date) });
    expect(await db.idea.findUnique({ where: { uuid: plain.uuid } })).toEqual({ ...plain, teamOwnerUuid: auth.actorUuid, teamLeadAgentUuid: leadUuid, updatedAt: expect.any(Date) });
    expect(await db.agentInstance.count({ where: { agentUuid: leadUuid } })).toBe(1);
    expect(state.emit).not.toHaveBeenCalled();
    expect(await db.activity.count({ where: { projectUuid } })).toBe(0);
  });

  it("feeds the ordinary post-commit notification and directed wake pipeline", async () => {
    const candidate = await idea();
    const instance = await db.agentInstance.create({ data: { companyUuid: auth.companyUuid, agentUuid: leadUuid, host: "wake-host", cwd: "/wake" } });
    const connection = await db.daemonConnection.create({ data: {
      companyUuid: auth.companyUuid, agentUuid: leadUuid, clientType: "codex", host: "wake-host", cwd: "/wake", agentInstanceUuid: instance.uuid,
    } });
    await db.projectAgentCwdPreference.create({ data: {
      companyUuid: auth.companyUuid, userUuid: auth.actorUuid, projectUuid, agentUuid: leadUuid, host: "wake-host", cwd: "/wake",
    } });
    const result = await preview();
    expect(await db.notification.count({ where: { projectUuid } })).toBe(0);
    await confirm(result);
    const activity = state.emit.mock.calls.find(([name]) => name === "activity")?.[1];
    expect(activity).toBeDefined();
    expect(await db.idea.findUnique({ where: { uuid: candidate.uuid } })).toMatchObject({ assigneeUuid: instance.uuid });
    const { handleActivity } = await import("../notification-listener");
    await handleActivity(activity);
    const notification = await db.notification.findFirstOrThrow({ where: { projectUuid, recipientUuid: leadUuid, action: "idea_claimed" } });
    expect(notification).toMatchObject({ actorType: "user", actorUuid: auth.actorUuid, entityUuid: candidate.uuid });
    const turn = await db.daemonSessionTurn.findFirstOrThrow({ where: { wakeNotificationUuid: notification.uuid } });
    expect(turn).toMatchObject({ status: "pending", wakeTargetConnectionUuid: connection.uuid, wakeRuntimeCwd: "/wake" });
    const calls = state.emit.mock.calls.filter(([name]) => name === "activity").length;
    expect(await confirm(await preview())).toMatchObject({ changedCount: 0 });
    expect(state.emit.mock.calls.filter(([name]) => name === "activity")).toHaveLength(calls);
    expect(await db.daemonSessionTurn.count({ where: { wakeNotificationUuid: notification.uuid } })).toBe(1);
  });

  it("accepts offline leads and ignores liveness-only changes to a preview", async () => {
    await idea();
    expect((await configService.getProjectAgentTeam(auth, projectUuid))?.roles.lead[0].online).toBe(false);
    const result = await preview();
    await db.daemonConnection.create({ data: { companyUuid: auth.companyUuid, agentUuid: leadUuid, clientType: "codex", host: "online", cwd: "/work" } });
    expect((await configService.getProjectAgentTeam(auth, projectUuid))?.roles.lead[0].online).toBe(true);
    expect(await confirm(result)).toMatchObject({ changedCount: 1 });
  });

  it("allows explicit frozen-team handoff and rejects missing/empty configs", async () => {
    await idea();
    await db.projectAgentTeam.update({ where: { uuid: configUuid }, data: { templateUuid: null } });
    expect(await confirm(await preview())).toMatchObject({ changedCount: 1 });
    await db.projectAgentTeam.update({ where: { uuid: configUuid }, data: { snapshot: {} } });
    await expect(preview()).rejects.toMatchObject({ code: "CONFLICT" });
    await db.projectAgentTeam.delete({ where: { uuid: configUuid } });
    await expect(preview()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("invalidates a theme preview when a foreign-assigned child completes", async () => {
    const theme = await idea({ status: "elaborated", isContainer: true });
    const child = await idea({ status: "elaborated", parentUuid: theme.uuid, assigneeUuid: other.actorUuid });
    const { task } = await chain(child.uuid, "in_progress");
    const result = await preview();
    expect(result.candidates.map((candidate) => candidate.uuid)).toEqual([theme.uuid]);
    await db.task.update({ where: { uuid: task.uuid }, data: { status: "closed" } });
    await expect(confirm(result)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.idea.findUnique({ where: { uuid: theme.uuid } })).toEqual(theme);
  });

  it.each(["assignment", "completion", "ownership", "config", "template", "eligibility", "cwd"])("rejects stale %s without partial writes", async (change) => {
    const candidate = await idea({ status: "elaborated", assigneeType: "agent", assigneeUuid: previousUuid });
    await idea();
    const { task } = await chain(candidate.uuid, "in_progress");
    const result = await preview();
    if (change === "assignment") await db.idea.update({ where: { uuid: candidate.uuid }, data: { assigneeUuid: otherAgentUuid } });
    if (change === "completion") await db.task.update({ where: { uuid: task.uuid }, data: { status: "done" } });
    if (change === "ownership") await db.agent.update({ where: { uuid: previousUuid }, data: { ownerUuid: other.actorUuid } });
    if (change === "config") await db.projectAgentTeam.update({ where: { uuid: configUuid }, data: { revision: { increment: 1 } } });
    if (change === "template") await db.agentTeam.update({ where: { uuid: templateUuid }, data: { name: "Edited template", updatedAt: new Date(Date.now() + 1000) } });
    if (change === "eligibility") await db.agent.update({ where: { uuid: leadUuid }, data: { roles: [], permissions: [] } });
    if (change === "cwd") await db.projectAgentCwdPreference.create({ data: { companyUuid: auth.companyUuid, userUuid: auth.actorUuid, projectUuid, agentUuid: leadUuid, host: "new", cwd: "/new" } });
    const before = await db.idea.findMany({ where: { projectUuid } });
    await expect(confirm(result)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.idea.findMany({ where: { projectUuid } })).toEqual(before);
    expect(await db.activity.count({ where: { projectUuid } })).toBe(0);
    expect(state.emit).not.toHaveBeenCalled();
  });

  it("rejects effective member drift even if the template timestamp and config revision are unchanged", async () => {
    await idea();
    const result = await preview();
    await db.agentTeamMember.create({ data: { teamUuid: templateUuid, agentUuid: previousUuid, role: "review" } });
    await expect(confirm(result)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects tampered, expired and mismatched lead/caller/project/company tokens", async () => {
    await idea();
    const result = await preview();
    if (!("confirmationToken" in result)) throw new Error("Expected preview");
    const [payload, signature] = result.confirmationToken.split(".");
    const tampered = `${payload}.${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
    await expect(handoff(auth, projectUuid, { leadAgentUuid: leadUuid, confirmationToken: tampered })).rejects.toMatchObject({ code: "CONFLICT" });
    await db.agentTeamMember.create({ data: { teamUuid: templateUuid, agentUuid: previousUuid, role: "lead" } });
    await expect(confirm(result, previousUuid)).rejects.toMatchObject({ code: "CONFLICT" });
    await db.projectAgentTeam.create({ data: { companyUuid: auth.companyUuid, ownerUuid: other.actorUuid, projectUuid, templateName: "Other", snapshot: { lead: [otherAgentUuid] } } });
    await expect(confirm(result, otherAgentUuid, other)).rejects.toMatchObject({ code: "CONFLICT" });
    const otherProject = await db.project.create({ data: { companyUuid: auth.companyUuid, name: "Other project" } });
    await db.projectAgentTeam.create({ data: { companyUuid: auth.companyUuid, ownerUuid: auth.actorUuid, projectUuid: otherProject.uuid, templateName: "Other", snapshot: { lead: [leadUuid] } } });
    await expect(confirm(result, leadUuid, auth, otherProject.uuid)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(confirm(result, leadUuid, foreign)).rejects.toMatchObject({ code: "NOT_FOUND" });
    vi.spyOn(Date, "now").mockReturnValue(new Date(result.expiresAt).getTime());
    await expect(confirm(result)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.emit).not.toHaveBeenCalled();
  });

  it("requires a human editor, denies hidden projects and rechecks access on confirm", async () => {
    await idea();
    const result = await preview();
    await expect(handoff({ type: "agent", companyUuid: auth.companyUuid, actorUuid: leadUuid, ownerUuid: auth.actorUuid }, projectUuid, { leadAgentUuid: leadUuid, preview: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db.project.update({ where: { uuid: projectUuid }, data: { visibility: "private" } });
    await expect(preview()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db.projectMember.create({ data: { companyUuid: auth.companyUuid, projectUuid, userUuid: auth.actorUuid, role: "viewer" } });
    await expect(preview()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(confirm(result)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db.projectMember.update({ where: { projectUuid_userUuid: { projectUuid, userUuid: auth.actorUuid } }, data: { role: "editor" } });
    expect(await confirm(await preview())).toMatchObject({ changedCount: 1 });
  });

  it("repairs last-lead warnings only on successful explicit confirmation, including zero candidates", async () => {
    await db.projectAgentTeam.update({ where: { uuid: configUuid }, data: { lastLeadAgentUuid: previousUuid } });
    expect((await configService.getProjectAgentTeam(auth, projectUuid))?.handoffWarning).toMatchObject({ agentUuid: previousUuid, reason: "removed_from_lead" });
    const result = await preview();
    expect((await configService.getProjectAgentTeam(auth, projectUuid))?.handoffWarning).not.toBeNull();
    expect(await confirm(result)).toMatchObject({ count: 0, changedCount: 0 });
    expect((await configService.getProjectAgentTeam(auth, projectUuid))?.handoffWarning).toBeNull();
    expect(state.emit).not.toHaveBeenCalled();
  });

  it("rolls back earlier assignments and audit rows on a later conditional race", async () => {
    await idea({ uuid: "10000000-0000-4000-8000-000000000001" });
    await idea({ uuid: "10000000-0000-4000-8000-000000000002" });
    const result = await preview();
    const before = await db.idea.findMany({ where: { projectUuid } });
    const transaction = db.$transaction.bind(db);
    vi.spyOn(db, "$transaction").mockImplementation((async (work: (client: Prisma.TransactionClient) => Promise<unknown>, options: object) => transaction(async (client) => {
      const update = client.idea.updateMany.bind(client.idea);
      let calls = 0;
      client.idea.updateMany = (async (...args: Parameters<typeof update>) => ++calls === 2 ? { count: 0 } : update(...args)) as unknown as typeof update;
      return work(client);
    }, options)) as typeof db.$transaction);
    await expect(confirm(result)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.idea.findMany({ where: { projectUuid } })).toEqual(before);
    expect(await db.activity.count({ where: { projectUuid } })).toBe(0);
    expect(await db.projectAgentTeam.findUnique({ where: { uuid: configUuid } })).toMatchObject({ revision: 1, lastLeadAgentUuid: null });
    expect(state.emit).not.toHaveBeenCalled();
  });

  it("retries serialization failures without duplicate activity publication and maps exhaustion to conflict", async () => {
    await idea();
    const result = await preview();
    const transaction = vi.spyOn(db, "$transaction").mockRejectedValueOnce({ code: "P2034" });
    expect(await confirm(result)).toMatchObject({ changedCount: 1 });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), { isolationLevel: "Serializable", timeout: 20_000 });
    expect(state.emit).toHaveBeenCalledTimes(1);
    transaction.mockRejectedValue({ code: "P2034" });
    await expect(preview()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(transaction).toHaveBeenCalledTimes(6);
  });

  it.each([
    {}, { leadAgentUuid: "invalid", preview: true }, { leadAgentUuid: randomUUID(), preview: false },
    { leadAgentUuid: randomUUID(), preview: true, confirmationToken: "token" },
    { leadAgentUuid: randomUUID(), preview: true, candidates: [] },
  ])("strictly rejects invalid caller input %j", async (input) => {
    await expect(handoff(auth, projectUuid, input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
