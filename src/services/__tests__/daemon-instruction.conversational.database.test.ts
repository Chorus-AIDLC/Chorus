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

vi.mock("@/generated/prisma/client", async () => import("../../generated/prisma/client"));
const state = vi.hoisted(() => ({ db: null as unknown, emit: vi.fn(), emitChange: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/event-bus", () => ({
  eventBus: { emit: state.emit, emitChange: state.emitChange, on: vi.fn() },
  transcriptEventName: (uuid: string) => `transcript:${uuid}`,
  controlEventName: (uuid: string) => `control:${uuid}`,
}));
vi.mock("@/services/daemon-control.service", () => ({ dispatchControl: state.dispatch }));

describe("conversational creation authority against isolated PostgreSQL", () => {
  let database: PGlite;
  let server: PGLiteSocketServer;
  let directory: string;
  let pool: pg.Pool;
  let db: PrismaClient;
  let create: typeof import("../daemon-instruction.service").createConversationalIdeaSession;
  let auth: UserAuthContext;
  let params: Parameters<typeof create>[1];
  let agentUuid: string;
  let instanceUuid: string;

  beforeAll(async () => {
    database = new PGlite();
    for (const migration of (await readdir("prisma/migrations")).filter((name) => /^\d/.test(name)).sort()) {
      await database.exec(await readFile(join("prisma/migrations", migration, "migration.sql"), "utf8"));
    }
    directory = await mkdtemp(join(tmpdir(), "chorus-conversational-authority-"));
    server = new PGLiteSocketServer({ db: database, path: join(directory, ".s.PGSQL.5432") });
    await server.start();
    pool = new pg.Pool({ host: directory, port: 5432, database: "postgres", user: "postgres", max: 1 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    create = (await import("../daemon-instruction.service")).createConversationalIdeaSession;
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

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    const company = await db.company.create({ data: { name: "Creation company" } });
    const human = await db.user.create({ data: { companyUuid: company.uuid, oidcSub: randomUUID() } });
    auth = { type: "user", companyUuid: company.uuid, actorUuid: human.uuid };
    const project = await db.project.create({ data: { companyUuid: company.uuid, name: "Creation project", createdByUuid: human.uuid } });
    agentUuid = (await db.agent.create({ data: {
      companyUuid: company.uuid, ownerUuid: human.uuid, name: "Non-lead", roles: [], permissions: ["idea:write"],
    } })).uuid;
    instanceUuid = (await db.agentInstance.create({ data: { companyUuid: company.uuid, agentUuid, host: "host", cwd: "/repo" } })).uuid;
    const connection = await db.daemonConnection.create({ data: {
      companyUuid: company.uuid, agentUuid, agentInstanceUuid: instanceUuid, clientType: "codex", host: "host", cwd: "/repo",
    } });
    await db.projectAgentTeam.create({ data: {
      companyUuid: company.uuid, projectUuid: project.uuid, ownerUuid: human.uuid, templateName: "Empty Team", snapshot: {},
    } });
    params = { projectUuid: project.uuid, agentUuid, connectionUuid: connection.uuid, descriptionText: "Build the selected idea", requestUuid: randomUUID() };
  });

  it.each(["elaborate", "decompose"] as const)("enrolls only the human-selected %s Idea with one fenced creation turn and no assigned wake", async (mode) => {
    const result = await create(auth, { ...params, mode });
    expect(await db.idea.findUnique({ where: { uuid: result.idea.uuid } })).toMatchObject({
      assigneeType: "agent_instance", assigneeUuid: instanceUuid, assignedByType: "user", assignedByUuid: auth.actorUuid,
      teamEnrollmentVersion: 1, teamGeneration: 1, teamEnrolledByUuid: auth.actorUuid,
      teamOwnerUuid: auth.actorUuid, teamLeadAgentUuid: agentUuid, isContainer: mode === "decompose",
    });
    const turn = await db.daemonSessionTurn.findUniqueOrThrow({ where: { uuid: result.turn.uuid } });
    expect(turn).toMatchObject({ trigger: "idea_creation_requested", wakeNotificationUuid: null,
      wakeContext: { ideaTeam: { ideaUuid: result.idea.uuid, generation: 1, ownerUuid: auth.actorUuid, agentUuid, role: "orchestrator" } },
    });
    expect(await db.idea.count({ where: { projectUuid: params.projectUuid } })).toBe(1);
    expect(await db.daemonSessionTurn.count({ where: { sessionUuid: result.session.uuid } })).toBe(1);
    const activity = state.emit.mock.calls.find(([name]) => name === "activity")?.[1];
    expect(activity).toMatchObject({ action: "assignment_recorded", actorType: "user", actorUuid: auth.actorUuid });
    const { handleActivity } = await import("../notification-listener");
    await handleActivity(activity);
    expect(await db.notification.count({ where: { projectUuid: params.projectUuid } })).toBe(0);
    expect(await db.daemonSessionTurn.count({ where: { sessionUuid: result.session.uuid } })).toBe(1);
    expect(state.dispatch).toHaveBeenCalledTimes(1);
  });

  it("reuses a committed request after Idea edits and an offline connection without another kickoff", async () => {
    const first = await create(auth, params);
    await db.idea.update({ where: { uuid: first.idea.uuid }, data: { title: "Agent revised title", content: "Agent revised content" } });
    await db.daemonConnection.update({ where: { uuid: params.connectionUuid }, data: { status: "offline" } });
    const second = await create(auth, params);
    expect(second.idea.uuid).toBe(first.idea.uuid);
    expect(second.session.uuid).toBe(first.session.uuid);
    expect(second.turn.uuid).toBe(first.turn.uuid);
    expect(await db.idea.count({ where: { projectUuid: params.projectUuid } })).toBe(1);
    expect(await db.ideaAssignmentOperation.count({ where: { ideaUuid: first.idea.uuid } })).toBe(1);
    expect(await db.idea.findUnique({ where: { uuid: first.idea.uuid } })).toMatchObject({ teamGeneration: 1 });
    expect(state.emit.mock.calls.filter(([name]) => name === "activity")).toHaveLength(1);
    expect(state.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("fences the existing creation turn by generation and client capability (dedicated=%s)", async (dedicated) => {
    vi.stubEnv("CHORUS_DEDICATED_OPERATION_WRITES", String(dedicated));
    const result = await create(auth, params);
    const { getPendingTurnsForConnection, getWakeRecoveryDelivery } = await import("../daemon-session.service");
    const target = { companyUuid: auth.companyUuid, agentUuid, connectionUuid: params.connectionUuid, operationProtocol: true, wakeRecoveryProtocol: 1 as const };
    expect(await getPendingTurnsForConnection(target)).toEqual([]);
    expect(await getPendingTurnsForConnection({ ...target, ideaTeamProtocol: 1 })).toEqual([
      expect.objectContaining({ turnUuid: result.turn.uuid }),
    ]);
    expect(await getWakeRecoveryDelivery(auth.companyUuid, agentUuid, params.connectionUuid, result.turn.uuid)).toBeNull();
    expect(await getWakeRecoveryDelivery(auth.companyUuid, agentUuid, params.connectionUuid, result.turn.uuid, 1)).not.toBeNull();
    await db.idea.update({ where: { uuid: result.idea.uuid }, data: { teamGeneration: { increment: 1 } } });
    expect(await getPendingTurnsForConnection({ ...target, ideaTeamProtocol: 1 })).toEqual([]);
    expect(await getWakeRecoveryDelivery(auth.companyUuid, agentUuid, params.connectionUuid, result.turn.uuid, 1)).toBeNull();
  });

  it("deduplicates overlapping requests inside the outer transaction", async () => {
    const [first, second] = await Promise.all([create(auth, params), create(auth, params)]);
    expect(second.idea.uuid).toBe(first.idea.uuid);
    expect(second.turn.uuid).toBe(first.turn.uuid);
    expect(await db.idea.count({ where: { projectUuid: params.projectUuid } })).toBe(1);
    expect(await db.daemonSessionTurn.count({ where: { sessionUuid: first.session.uuid } })).toBe(1);
    expect(state.dispatch).toHaveBeenCalledTimes(1);
  });

  it("reuses the request operation across serialization retries and publishes only after commit", async () => {
    const transaction = db.$transaction.bind(db);
    const transactionSpy = vi.spyOn(db, "$transaction").mockImplementationOnce((async (work: (client: Prisma.TransactionClient) => Promise<unknown>) => transaction(async (client) => {
      await work(client);
      expect(state.emit).not.toHaveBeenCalled();
      expect(state.dispatch).not.toHaveBeenCalled();
      throw { code: "P2034" };
    })) as unknown as typeof db.$transaction);
    const result = await create(auth, params);
    expect(transactionSpy).toHaveBeenCalledTimes(2);
    expect(await db.ideaAssignmentOperation.findUnique({ where: { uuid: params.requestUuid } })).toMatchObject({ ideaUuid: result.idea.uuid, generation: 1 });
    expect(await db.idea.count({ where: { projectUuid: params.projectUuid } })).toBe(1);
    expect(await db.activity.count({ where: { projectUuid: params.projectUuid } })).toBe(1);
    expect(await db.daemonSessionTurn.count({ where: { sessionUuid: result.session.uuid } })).toBe(1);
    expect(state.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { descriptionText: "Different idea" }, { mode: "decompose" as const }, { researchFirst: true },
    { connectionUuid: randomUUID() },
  ])("rejects request reuse with a changed payload %j", async (changed) => {
    await create(auth, params);
    await expect(create(auth, { ...params, ...changed })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.idea.count({ where: { projectUuid: params.projectUuid } })).toBe(1);
    expect(state.dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects another human's reuse of the same request identity", async () => {
    await create(auth, params);
    const other = await db.user.create({ data: { companyUuid: auth.companyUuid, oidcSub: randomUUID() } });
    await db.agent.update({ where: { uuid: agentUuid }, data: { ownerUuid: other.uuid } });
    await expect(create({ ...auth, actorUuid: other.uuid }, params)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.dispatch).toHaveBeenCalledTimes(1);
  });

  it("binds request reuse to the selected logical agent and project", async () => {
    await create(auth, params);
    const otherAgent = await db.agent.create({ data: { companyUuid: auth.companyUuid, ownerUuid: auth.actorUuid, name: "Another agent" } });
    const otherProject = await db.project.create({ data: { companyUuid: auth.companyUuid, name: "Another project" } });
    await expect(create(auth, { ...params, agentUuid: otherAgent.uuid })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(create(auth, { ...params, projectUuid: otherProject.uuid })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not replay a creation moved out of the authorized project", async () => {
    const result = await create(auth, params);
    const hidden = await db.project.create({ data: { companyUuid: auth.companyUuid, name: "Hidden", visibility: "private" } });
    await db.idea.update({ where: { uuid: result.idea.uuid }, data: { projectUuid: hidden.uuid } });
    await expect(create(auth, params)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.dispatch).toHaveBeenCalledTimes(1);
  });

  it("rechecks selected-agent ownership inside the creation transaction", async () => {
    const other = await db.user.create({ data: { companyUuid: auth.companyUuid, oidcSub: randomUUID() } });
    const transaction = db.$transaction.bind(db);
    vi.spyOn(db, "$transaction").mockImplementationOnce((async (work: (client: Prisma.TransactionClient) => Promise<unknown>) => {
      await db.agent.update({ where: { uuid: agentUuid }, data: { ownerUuid: other.uuid } });
      return transaction(work);
    }) as typeof db.$transaction);
    await expect(create(auth, params)).rejects.toMatchObject({ name: "ConnectionNotVisibleError" });
    expect(await db.idea.count({ where: { projectUuid: params.projectUuid } })).toBe(0);
    expect(await db.ideaAssignmentOperation.count({ where: { uuid: params.requestUuid } })).toBe(0);
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("rolls back creation, authority and request identity when the initial turn fails", async () => {
    const transaction = db.$transaction.bind(db);
    vi.spyOn(db, "$transaction").mockImplementationOnce((async (work: (client: Prisma.TransactionClient) => Promise<unknown>) => transaction(async (client) => {
      client.daemonSessionTurn.create = vi.fn().mockRejectedValue(new Error("turn failure"));
      return work(client);
    })) as typeof db.$transaction);
    await expect(create(auth, params)).rejects.toThrow("turn failure");
    expect(await db.idea.count({ where: { projectUuid: params.projectUuid } })).toBe(0);
    expect(await db.activity.count({ where: { projectUuid: params.projectUuid } })).toBe(0);
    expect(await db.ideaAssignmentOperation.count({ where: { uuid: params.requestUuid } })).toBe(0);
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.emit).not.toHaveBeenCalled();
    await create(auth, params);
    expect(state.dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not enroll without a bound private Team", async () => {
    await db.projectAgentTeam.deleteMany({ where: { projectUuid: params.projectUuid } });
    const result = await create(auth, params);
    expect(await db.idea.findUnique({ where: { uuid: result.idea.uuid } })).toMatchObject({ teamOwnerUuid: null, teamLeadAgentUuid: null });
    expect(await db.daemonSessionTurn.findUnique({ where: { uuid: result.turn.uuid } })).toMatchObject({ wakeContext: null });
    const { getPendingTurnsForConnection } = await import("../daemon-session.service");
    expect(await getPendingTurnsForConnection({ companyUuid: auth.companyUuid, agentUuid, connectionUuid: params.connectionUuid, operationProtocol: true })).toEqual([
      expect.objectContaining({ turnUuid: result.turn.uuid }),
    ]);
  });
});
