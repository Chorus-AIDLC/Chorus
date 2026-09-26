/**
 * Opt-in real persistence test. Use ONLY an isolated test database:
 * RESEARCH_DATABASE_URL=postgresql://postgres:postgres@localhost:5435/chorus
 * pnpm exec vitest run src/services/__tests__/research.database.integration.test.ts
 *
 * Creates its own tenant and removes only that tenant's fixtures. No daemon/LLM is run.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../../generated/prisma/client";

const state = vi.hoisted(() => ({ db: null as unknown, actor: "", company: "" }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
const events = vi.hoisted(() => ({ emit: vi.fn(), emitChange: vi.fn() }));
vi.mock("@/lib/event-bus", () => ({
  eventBus: events, controlEventName: (id: string) => `control:${id}`,
}));
vi.mock("@/lib/auth-server", () => ({
  getServerAuthContext: async () => ({ type: "user", companyUuid: state.company, actorUuid: state.actor }),
}));

const url = process.env.RESEARCH_DATABASE_URL;
describe.skipIf(!url)("Research real database integration", () => {
  let db: PrismaClient;
  let pool: pg.Pool;
  let requestResearch: typeof import("../research.service").requestResearch;
  let createConversationalIdeaSession: typeof import("../daemon-instruction.service").createConversationalIdeaSession;
  let getResearchEligibility: typeof import("../research-eligibility.service").getResearchEligibility;
  let getPendingTurnsForConnection: typeof import("../daemon-session.service").getPendingTurnsForConnection;
  let advanceTurn: typeof import("../daemon-session.service").advanceTurn;
  let advanceTurnForWake: typeof import("../daemon-session.service").advanceTurnForWake;
  let startDevelopment: typeof import("../start-development.service").startDevelopment;
  let createActivity: typeof import("../activity.service").createActivity;
  let updateTask: typeof import("../task.service").updateTask;
  let deleteTask: typeof import("../task.service").deleteTask;
  let researchIdeaAction: typeof import("../../app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/research-actions").researchIdeaAction;
  let project: string;
  let agent: string;
  let connection: string;
  let instance: string;
  let idea: string;
  const params = () => ({ companyUuid: state.company, actorUuid: state.actor, actorType: "user", ideaUuid: idea });
  beforeAll(async () => {
    if (!url || !url.includes(":5435/")) throw new Error("Research tests require the isolated :5435 database");
    pool = new pg.Pool({ connectionString: url, max: 1 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    ({ requestResearch } = await import("../research.service"));
    ({ createConversationalIdeaSession } = await import("../daemon-instruction.service"));
    ({ getResearchEligibility } = await import("../research-eligibility.service"));
    ({ getPendingTurnsForConnection, advanceTurn, advanceTurnForWake } = await import("../daemon-session.service"));
    ({ startDevelopment } = await import("../start-development.service"));
    ({ createActivity } = await import("../activity.service"));
    ({ updateTask, deleteTask } = await import("../task.service"));
    ({ researchIdeaAction } = await import("../../app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/research-actions"));
    state.company = (await db.company.create({ data: { name: `Research integration ${randomUUID()}` } })).uuid;
    state.actor = randomUUID();
    project = (await db.project.create({ data: { companyUuid: state.company, name: "Research integration" } })).uuid;
    agent = (await db.agent.create({ data: { companyUuid: state.company, name: "Research test agent", ownerUuid: state.actor, roles: ["pm"] } })).uuid;
    instance = (await db.agentInstance.create({ data: { companyUuid: state.company, agentUuid: agent, host: "research-test", cwd: "/tmp/research-test" } })).uuid;
    connection = (await db.daemonConnection.create({ data: {
      companyUuid: state.company, agentUuid: agent, agentInstanceUuid: instance,
      host: "research-test", cwd: "/tmp/research-test", clientType: "claude_code", status: "online",
    } })).uuid;
  }, 30_000);
  beforeEach(async () => {
    events.emit.mockClear();
    await db.agent.update({ where: { uuid: agent }, data: { roles: ["pm"], ownerUuid: state.actor } });
    await db.daemonConnection.update({ where: { uuid: connection }, data: { status: "online", lastSeenAt: new Date() } });
    idea = (await db.idea.create({ data: {
      companyUuid: state.company, projectUuid: project, title: "Research fixture", content: "Preserve this text.",
      status: "elaborated", elaborationStatus: "resolved", assigneeType: "agent_instance", assigneeUuid: instance,
      createdByUuid: state.actor,
    } })).uuid;
  });
  afterAll(async () => {
    if (!db || !state.company) return;
    const tenant = { companyUuid: state.company };
    await db.daemonSessionTurn.deleteMany({ where: { session: tenant } });
    await db.daemonSession.deleteMany({ where: tenant });
    await db.notification.deleteMany({ where: tenant });
    await db.activity.deleteMany({ where: tenant });
    await db.acceptanceCriterion.deleteMany({ where: { task: tenant } });
    await db.task.deleteMany({ where: tenant });
    await db.proposal.deleteMany({ where: tenant });
    await db.elaborationQuestion.deleteMany({ where: { round: tenant } });
    await db.elaborationRound.deleteMany({ where: tenant });
    await db.idea.updateMany({ where: tenant, data: { parentUuid: null } });
    await db.idea.deleteMany({ where: tenant });
    await db.daemonConnection.deleteMany({ where: tenant });
    await db.agentInstance.deleteMany({ where: tenant });
    await db.agent.deleteMany({ where: tenant });
    await db.project.deleteMany({ where: tenant });
    await db.company.delete({ where: { uuid: state.company } });
    await db.$disconnect();
    await pool.end();
  });
  async function proposalTask(status = "open", ideaUuid = idea) {
    const proposal = await db.proposal.create({ data: {
      companyUuid: state.company, projectUuid: project, title: "Approved plan", inputType: "idea",
      inputUuids: [ideaUuid], status: "approved", createdByUuid: agent,
    } });
    return db.task.create({ data: {
      companyUuid: state.company, projectUuid: project, proposalUuid: proposal.uuid,
      title: "Plan task", status, createdByUuid: agent,
    } });
  }
  const development = () => createActivity({
    companyUuid: state.company, projectUuid: project, targetType: "idea", targetUuid: idea,
    actorType: "user", actorUuid: state.actor, action: "start_development",
  });
  it.each(["elaborate", "decompose"] as const)("persists all 3000 description characters in %s for every Research setting", async (mode) => {
    const descriptionText = "调研".repeat(1500);
    for (const researchFirst of [undefined, false, true]) {
      const result = await createConversationalIdeaSession(
        { type: "user", companyUuid: state.company, actorUuid: state.actor },
        { projectUuid: project, agentUuid: agent, connectionUuid: connection, descriptionText, mode, researchFirst },
      );
      const saved = await db.idea.findUniqueOrThrow({ where: { uuid: result.idea.uuid } });
      const turn = await db.daemonSessionTurn.findUniqueOrThrow({ where: { uuid: result.turn.uuid } });
      expect(saved.content).toBe(descriptionText);
      expect(saved.isContainer).toBe(mode === "decompose");
      expect(turn.promptText).toContain(researchFirst ? "explicitly requested lightweight research" : "automatic judgment");
      expect(turn.promptText?.endsWith(`--- User's idea description ---\n${descriptionText}`)).toBe(true);
      expect(turn.promptText!.length).toBeGreaterThan(4000);
    }
  });
  it.each(["elaborate", "decompose"] as const)("rejects empty and 3001-character descriptions in %s without persisting partial resources", async (mode) => {
    const counts = async () => [
      await db.idea.count({ where: { companyUuid: state.company } }),
      await db.daemonSession.count({ where: { companyUuid: state.company } }),
      await db.daemonSessionTurn.count({ where: { session: { companyUuid: state.company } } }),
    ];
    const before = await counts();
    for (const descriptionText of [" \n ", "x".repeat(3001)]) {
      await expect(createConversationalIdeaSession(
        { type: "user", companyUuid: state.company, actorUuid: state.actor },
        { projectUuid: project, agentUuid: agent, connectionUuid: connection, descriptionText, mode },
      )).rejects.toMatchObject({ name: "InstructionTextError", reason: descriptionText.trim() ? "too_long" : "empty" });
      expect(await counts()).toEqual(before);
    }
  });
  it("server action dispatches human_instruction to the existing Idea root and preserves state", async () => {
    await proposalTask();
    const before = await db.idea.findUnique({ where: { uuid: idea } });
    const result = await researchIdeaAction(idea);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.errorCode);
    expect(result.session).toMatchObject({ sessionId: idea, directIdeaUuid: idea, originConnectionUuid: connection });
    expect(await db.idea.findUnique({ where: { uuid: idea } })).toEqual(before);
    expect(await db.daemonSessionTurn.findUnique({ where: { uuid: result.turnUuid } })).toMatchObject({ trigger: "human_instruction", status: "pending" });
    expect(await db.notification.count({ where: { companyUuid: state.company, entityUuid: idea, action: "human_instruction" } })).toBe(1);
    expect(events.emit).toHaveBeenCalledWith(`control:${connection}`, expect.objectContaining({ turnUuid: result.turnUuid }));
  });
  it("rejects simultaneous duplicates, including running turns, and allows a later explicit request", async () => {
    const outcomes = await Promise.allSettled([requestResearch(params()), requestResearch(params())]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "already_running" } });
    const session = await db.daemonSession.findFirstOrThrow({ where: { companyUuid: state.company, directIdeaUuid: idea } });
    await db.daemonSessionTurn.updateMany({ where: { sessionUuid: session.uuid }, data: { status: "running" } });
    await expect(requestResearch(params())).rejects.toMatchObject({ code: "already_running" });
    await db.daemonSessionTurn.updateMany({ where: { sessionUuid: session.uuid }, data: { status: "ended" } });
    const next = await requestResearch(params());
    expect(next.sessionUuid).toBe(session.uuid);
    expect(await db.daemonSessionTurn.count({ where: { sessionUuid: session.uuid } })).toBe(2);
  });
  it("accepted development blocks dispatch before any task transition", async () => {
    await proposalTask();
    await startDevelopment(params());
    await expect(requestResearch(params())).rejects.toMatchObject({ code: "development_started" });
    expect(await db.daemonSession.count({ where: { companyUuid: state.company, directIdeaUuid: idea } })).toBe(0);
  });
  it("serializes Research/development and rechecks pending delivery when development wins later", async () => {
    const result = await requestResearch(params());
    await development();
    const pending = await getPendingTurnsForConnection({ companyUuid: state.company, agentUuid: agent, connectionUuid: connection });
    expect(pending.some((turn) => turn.turnUuid === result.turnUuid)).toBe(false);
    expect(await db.daemonSessionTurn.findUnique({ where: { uuid: result.turnUuid } })).toMatchObject({
      status: "interrupted", interruptedReason: "research_stage_changed",
    });
  });
  it("concurrent development/Research leaves no executable stale request", async () => {
    const outcomes = await Promise.allSettled([development(), requestResearch(params())]);
    expect(outcomes[0].status).toBe("fulfilled");
    const pending = await getPendingTurnsForConnection({ companyUuid: state.company, agentUuid: agent, connectionUuid: connection });
    expect(pending.some((turn) => turn.directIdeaUuid === idea)).toBe(false);
  });
  it("pre-spawn admission requires the exact origin connection and claims the exact Research turn once", async () => {
    const result = await requestResearch(params());
    const admission = {
      companyUuid: state.company, agentUuid: agent, connectionUuid: connection,
      sessionId: idea, turnUuid: result.turnUuid, status: "running" as const,
    };
    expect(await advanceTurnForWake({ ...admission, connectionUuid: randomUUID() }))
      .toMatchObject({ ok: false, reason: "not_found" });
    expect(await db.daemonSessionTurn.findUnique({ where: { uuid: result.turnUuid } }))
      .toMatchObject({ status: "pending" });
    expect(await advanceTurnForWake(admission))
      .toMatchObject({ ok: true, turn: { uuid: result.turnUuid, status: "running" } });
    expect(await advanceTurnForWake(admission)).toMatchObject({ ok: false });
  });
  it("pre-spawn admission rejects and retires Research after development acceptance", async () => {
    const result = await requestResearch(params());
    await development();
    expect(await advanceTurnForWake({
      companyUuid: state.company, agentUuid: agent, connectionUuid: connection,
      sessionId: idea, turnUuid: result.turnUuid, status: "running",
    })).toMatchObject({ ok: false, reason: "invalid_transition" });
    expect(await db.daemonSessionTurn.findUnique({ where: { uuid: result.turnUuid } }))
      .toMatchObject({ status: "interrupted", interruptedReason: "research_stage_changed" });
  });
  it.each(["pending", "running", "ended", "interrupted"] as const)(
    "uncorrelated %s reports never select Research",
    async (status) => {
      const result = await requestResearch(params());
      const storedStatus = status === "ended" || status === "interrupted" ? "running" : "pending";
      await db.daemonSessionTurn.update({ where: { uuid: result.turnUuid }, data: { status: storedStatus } });
      expect(await advanceTurnForWake({
        companyUuid: state.company, agentUuid: agent, connectionUuid: connection, sessionId: idea, status,
      })).toEqual({ ok: false, reason: "not_found" });
      expect(await db.daemonSessionTurn.findUnique({ where: { uuid: result.turnUuid } }))
        .toMatchObject({ status: storedStatus });
    },
  );
  it("FIFO and coalesced settlement skip Research while retaining null and ordinary prompts", async () => {
    const research = await requestResearch(params());
    const ordinary = await db.daemonSessionTurn.create({ data: {
      sessionUuid: research.sessionUuid, seq: 2, trigger: "task_assigned", status: "pending",
    } });
    const laterResearch = await db.daemonSessionTurn.create({ data: {
      sessionUuid: research.sessionUuid, seq: 3, trigger: "human_instruction", status: "pending",
      promptText: "[Chorus Tracker Research] Another isolated request",
    } });
    const laterOrdinary = await db.daemonSessionTurn.create({ data: {
      sessionUuid: research.sessionUuid, seq: 4, trigger: "human_instruction", status: "pending",
      promptText: "Ordinary instruction",
    } });
    expect(await advanceTurnForWake({
      companyUuid: state.company, agentUuid: agent, connectionUuid: connection, sessionId: idea,
      status: "running", coalescedCount: 2,
    })).toMatchObject({ ok: true, turn: { uuid: ordinary.uuid } });
    const rows = await db.daemonSessionTurn.findMany({
      where: { sessionUuid: research.sessionUuid }, orderBy: { seq: "asc" },
    });
    expect(rows.map(({ uuid, status }) => [uuid, status])).toEqual([
      [research.turnUuid, "pending"], [ordinary.uuid, "running"],
      [laterResearch.uuid, "pending"], [laterOrdinary.uuid, "merged"],
    ]);
    expect(await advanceTurnForWake({
      companyUuid: state.company, agentUuid: agent, connectionUuid: connection, sessionId: idea, status: "ended",
    })).toMatchObject({ ok: true, turn: { uuid: ordinary.uuid, status: "ended" } });
  });
  it("rejects exact coalesced Research admission before any backend mutation", async () => {
    const result = await requestResearch(params());
    expect(await advanceTurnForWake({
      companyUuid: state.company, agentUuid: agent, connectionUuid: connection, sessionId: idea,
      turnUuid: result.turnUuid, status: "running", coalescedCount: 2, backendSessionId: "must-not-bind",
    })).toMatchObject({ ok: false, reason: "invalid_transition" });
    expect(await db.daemonSessionTurn.findUnique({ where: { uuid: result.turnUuid } }))
      .toMatchObject({ status: "pending", backendSessionId: null });
    expect(await db.daemonSession.findUnique({ where: { uuid: result.sessionUuid } }))
      .toMatchObject({ backendSessionId: null });
  });
  it.each(["pending", "running", "ended", "interrupted"] as const)(
    "origin fence rejects exact Research %s reports before any mutation",
    async (status) => {
      const result = await requestResearch(params());
      if (status === "ended" || status === "interrupted") {
        await db.daemonSessionTurn.update({ where: { uuid: result.turnUuid }, data: { status: "running" } });
      }
      const before = await db.daemonSessionTurn.findUnique({ where: { uuid: result.turnUuid } });
      expect(await advanceTurnForWake({
        companyUuid: state.company, agentUuid: agent, connectionUuid: randomUUID(), sessionId: idea,
        turnUuid: result.turnUuid, status, interruptedReason: "crash", backendSessionId: "must-not-bind",
      })).toEqual({ ok: false, reason: "not_found" });
      expect(await db.daemonSessionTurn.findUnique({ where: { uuid: result.turnUuid } })).toEqual(before);
      expect(await db.daemonSession.findUnique({ where: { uuid: result.sessionUuid } }))
        .toMatchObject({ backendSessionId: null });
    },
  );
  it.each(["crash", "invalid_path", "user"])("retires exact pending Research for %s once, without starting or binding a backend", async (interruptedReason) => {
    const result = await requestResearch(params());
    const abort = {
      companyUuid: state.company, agentUuid: agent, connectionUuid: connection, sessionId: idea,
      turnUuid: result.turnUuid, status: "interrupted" as const, interruptedReason,
    };
    events.emit.mockClear();
    const outcomes = await Promise.all([advanceTurnForWake(abort), advanceTurnForWake(abort)]);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    const retired = await db.daemonSessionTurn.findUnique({ where: { uuid: result.turnUuid } });
    expect(retired).toMatchObject({ status: "interrupted", interruptedReason, startedAt: null, backendSessionId: null });
    expect(retired?.endedAt).toBeInstanceOf(Date);
    expect(events.emit.mock.calls.filter(([name, event]) =>
      name === `transcript:${result.sessionUuid}` && event.trigger === "turn_status_changed",
    )).toHaveLength(1);
    expect(await advanceTurnForWake(abort)).toMatchObject({ ok: true });
    expect(await db.daemonSessionTurn.findUnique({ where: { uuid: result.turnUuid } })).toEqual(retired);
    expect(await advanceTurnForWake({ ...abort, connectionUuid: randomUUID() }))
      .toEqual({ ok: false, reason: "not_found" });
    expect(await db.daemonSession.findUnique({ where: { uuid: result.sessionUuid } }))
      .toMatchObject({ backendSessionId: null, totalInputTokens: 0, totalOutputTokens: 0 });
    expect((await requestResearch(params())).turnUuid).not.toBe(result.turnUuid);
  });
  it("retires exact running Research after a lost admission response with idempotent cleanup", async () => {
    const result = await requestResearch(params());
    const exact = {
      companyUuid: state.company, agentUuid: agent, connectionUuid: connection, sessionId: idea, turnUuid: result.turnUuid,
    };
    expect(await advanceTurnForWake({ ...exact, status: "running" })).toMatchObject({ ok: true });
    const abort = { ...exact, status: "interrupted" as const, interruptedReason: "crash" };
    expect(await advanceTurnForWake(abort)).toMatchObject({ ok: true });
    const retired = await db.daemonSessionTurn.findUnique({ where: { uuid: result.turnUuid } });
    expect(retired).toMatchObject({ status: "interrupted", interruptedReason: "crash", backendSessionId: null });
    expect(await advanceTurnForWake(abort)).toMatchObject({ ok: true });
    expect(await db.daemonSessionTurn.findUnique({ where: { uuid: result.turnUuid } })).toEqual(retired);
    expect(await db.daemonSession.findUnique({ where: { uuid: result.sessionUuid } }))
      .toMatchObject({ backendSessionId: null });
  });
  it("real control-handler interrupt during a delayed successful admission prevents Waker spawn", async () => {
    const { Waker } = await import("../../../cli/waker.mjs");
    const { createControlHandler } = await import("../../../cli/control-handler.mjs");
    const research = await requestResearch(params());
    let releaseAdmission!: () => void;
    const heldResponse = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    const reporter = vi.fn(async (report: Parameters<typeof advanceTurnForWake>[0]) => {
      const result = await advanceTurnForWake({
        ...report, companyUuid: state.company, agentUuid: agent, connectionUuid: connection,
      });
      if (report.status === "running") await heldResponse;
      return result.ok
        ? { ok: true, data: { turnUuid: result.turn.uuid } }
        : { ok: false, status: result.reason === "not_found" ? 404 : 409 };
    });
    const spawner = { wake: vi.fn(async ({ sessionId, onChild }) => {
      onChild?.({ pid: 4242, on() {}, kill() {} });
      return { sessionId, exitCode: 0, isNew: true };
    }) };
    const silent = { info() {}, warn() {}, error() {} };
    const waker = new Waker({
      creds: { url: "http://research-test", apiKey: "test" },
      lineage: { resolve: async () => ({ rootIdeaUuid: idea, directIdeaUuid: idea }) },
      cwd: "/tmp/research-test", spawner, logger: silent,
      writeMcpConfigFn: () => ({ path: "/tmp/research-test-unused.json", cleanup() {} }),
      isNewSessionFn: () => true, reportInterrupt: async () => {}, advanceTurn: reporter,
    });
    const onControl = createControlHandler({
      waker, getConnectionUuid: () => connection, advanceTurn: reporter, logger: silent,
    });
    const notification = {
      uuid: randomUUID(), projectUuid: project, entityType: "idea", entityUuid: idea,
      entityTitle: "Research fixture", action: "human_instruction",
      instructionText: "[Chorus Tracker Research] Research only, then return.",
      turnUuid: research.turnUuid, researchOnly: true,
      actorType: "user", actorUuid: state.actor, actorName: "Research test", message: "",
    };
    const resolved = await waker.keyFor(notification);
    const work = waker.wake(notification, resolved.key, resolved);
    try {
      await vi.waitFor(async () => {
        expect(await db.daemonSessionTurn.findUnique({ where: { uuid: research.turnUuid } })).toMatchObject({ status: "running" });
      });
      expect(spawner.wake).not.toHaveBeenCalled();
      onControl({
        type: "control", command: "interrupt", targetConnectionUuid: randomUUID(),
        entityType: "idea", entityUuid: idea,
      });
      expect(reporter).toHaveBeenCalledTimes(1);
      onControl({
        type: "control", command: "interrupt", targetConnectionUuid: connection,
        entityType: "idea", entityUuid: idea,
      });
      await vi.waitFor(async () => {
        expect(await db.daemonSessionTurn.findUnique({ where: { uuid: research.turnUuid } }))
          .toMatchObject({ status: "interrupted", interruptedReason: "user" });
      });
      expect(reporter).toHaveBeenCalledWith(expect.objectContaining({
        turnUuid: research.turnUuid, status: "interrupted", interruptedReason: "user",
      }));
      releaseAdmission();
      await work;
      expect(spawner.wake).not.toHaveBeenCalled();
      expect(await db.daemonSessionTurn.findUnique({ where: { uuid: research.turnUuid } }))
        .toMatchObject({ status: "interrupted", interruptedReason: "user", backendSessionId: null });
    } finally {
      releaseAdmission();
      await work;
      waker.interruptAll();
    }
  });
  it("rejects unsupported pending Research aborts and backend binding without changing the generic FSM", async () => {
    const result = await requestResearch(params());
    const exact = {
      companyUuid: state.company, agentUuid: agent, connectionUuid: connection, sessionId: idea, turnUuid: result.turnUuid,
    };
    for (const interruptedReason of ["shutdown", "offline"]) {
      expect(await advanceTurnForWake({ ...exact, status: "interrupted", interruptedReason }))
        .toMatchObject({ ok: false, reason: "invalid_transition" });
    }
    expect(await advanceTurnForWake({
      ...exact, status: "interrupted", interruptedReason: "crash", backendSessionId: "must-not-bind",
    })).toMatchObject({ ok: false, reason: "invalid_transition" });
    expect(await advanceTurn(result.turnUuid, "interrupted", { expectedStatus: "pending", interruptedReason: "crash" }))
      .toMatchObject({ ok: false, reason: "invalid_transition" });
    const ordinary = await db.daemonSessionTurn.create({ data: {
      sessionUuid: result.sessionUuid, seq: 2, trigger: "human_instruction", promptText: "Ordinary", status: "pending",
    } });
    for (const interruptedReason of ["crash", "invalid_path", "user"]) {
      expect(await advanceTurnForWake({
        ...exact, turnUuid: ordinary.uuid, status: "interrupted", interruptedReason, backendSessionId: "must-not-bind",
      })).toMatchObject({ ok: false, reason: "invalid_transition" });
    }
    const rows = await db.daemonSessionTurn.findMany({ where: { sessionUuid: result.sessionUuid } });
    expect(rows.every((row) => row.status === "pending" && row.backendSessionId === null)).toBe(true);
    expect(await db.daemonSession.findUnique({ where: { uuid: result.sessionUuid } })).toMatchObject({ backendSessionId: null });
  });
  it("task execution writes durable history, including after reopen and a newer proposal", async () => {
    const task = await proposalTask();
    await updateTask(task.uuid, { status: "in_progress" });
    await updateTask(task.uuid, { status: "open" });
    await proposalTask();
    expect(await getResearchEligibility(state.company, idea)).toEqual({ eligible: false, reason: "development_started" });
    expect(await db.activity.count({ where: { targetUuid: task.uuid, action: "execution_started" } })).toBeGreaterThan(0);
  });
  it("executing then deleting a task preserves the Idea boundary and retires queued Research", async () => {
    const task = await proposalTask();
    const pending = await requestResearch(params());
    await updateTask(task.uuid, { status: "in_progress" });
    // The new writer must anchor execution before deletion, not rely on delete's legacy repair.
    expect(await db.activity.findFirst({ where: {
      companyUuid: state.company, projectUuid: project, targetType: "idea", targetUuid: idea, action: "execution_started",
    } })).toMatchObject({ value: { taskUuid: task.uuid, proposalUuid: task.proposalUuid } });
    await deleteTask(task.uuid);
    expect(await db.task.findUnique({ where: { uuid: task.uuid } })).toBeNull();
    expect(await db.activity.count({ where: { targetType: "task", targetUuid: task.uuid, action: "execution_started" } })).toBe(1);
    expect(await getResearchEligibility(state.company, idea)).toEqual({ eligible: false, reason: "development_started" });
    await expect(requestResearch(params())).rejects.toMatchObject({ code: "development_started" });
    expect(await advanceTurnForWake({
      companyUuid: state.company, agentUuid: agent, connectionUuid: connection,
      sessionId: idea, turnUuid: pending.turnUuid, status: "running",
    })).toMatchObject({ ok: false, reason: "invalid_transition" });
    expect(await db.daemonSessionTurn.findUnique({ where: { uuid: pending.turnUuid } }))
      .toMatchObject({ status: "interrupted", interruptedReason: "research_stage_changed" });
    // No live proposal is required to retrieve the durable Idea fact either.
    await db.proposal.delete({ where: { uuid: task.proposalUuid! } });
    expect(await getResearchEligibility(state.company, idea)).toEqual({ eligible: false, reason: "development_started" });
  });
  it.each([
    ["execution_started", { from: "open", to: "in_progress" }],
    ["force_status_change", { from: "to_verify", to: "open" }],
    ["comment_added", { statusUpdated: "in_progress" }],
    ["submitted", {}],
    ["verified", {}],
    ["completed", {}],
  ])("deleting a reopened descendant task preserves older-proposal %s history for every input Idea", async (action, value) => {
    const child = await db.idea.create({ data: {
      companyUuid: state.company, projectUuid: project, title: "Child", parentUuid: idea, createdByUuid: agent,
    } });
    const sibling = await db.idea.create({ data: {
      companyUuid: state.company, projectUuid: project, title: "Other input", createdByUuid: agent,
    } });
    const task = await proposalTask("open", child.uuid);
    await db.proposal.update({ where: { uuid: task.proposalUuid! }, data: {
      inputUuids: [child.uuid, sibling.uuid], createdAt: new Date("2020-01-01"),
    } });
    await proposalTask("open", child.uuid);
    // Fixture represents older writers: the task is already reopened and only task history exists.
    await db.activity.create({ data: {
      companyUuid: state.company, projectUuid: project, targetType: "task", targetUuid: task.uuid,
      actorType: "agent", actorUuid: agent, action, value,
    } });
    await deleteTask(task.uuid);
    expect(await db.task.findUnique({ where: { uuid: task.uuid } })).toBeNull();
    for (const targetUuid of [idea, child.uuid, sibling.uuid]) {
      expect(await getResearchEligibility(state.company, targetUuid)).toEqual({ eligible: false, reason: "development_started" });
    }
    expect(await db.activity.count({ where: {
      companyUuid: state.company, targetType: "idea", action: "execution_started",
      targetUuid: { in: [child.uuid, sibling.uuid] },
    } })).toBe(2);
  });
  it.each(["in_progress", "to_verify", "done"])("preserves legacy %s tasks without any activity on deletion", async (status) => {
    const task = await proposalTask(status);
    await deleteTask(task.uuid);
    expect(await getResearchEligibility(state.company, idea)).toEqual({ eligible: false, reason: "development_started" });
  });
  it.each(["open", "assigned", "closed"])("deleting never-executed %s tasks does not deny Research", async (status) => {
    const task = await proposalTask(status);
    await db.activity.create({ data: {
      companyUuid: state.company, projectUuid: project, targetType: "task", targetUuid: task.uuid,
      actorType: "agent", actorUuid: agent, action: "status_changed", value: { from: "assigned", to: status },
    } });
    await deleteTask(task.uuid);
    expect(await db.activity.count({ where: {
      companyUuid: state.company, targetType: "idea", targetUuid: idea, action: "execution_started",
    } })).toBe(0);
    expect(await getResearchEligibility(state.company, idea)).toEqual({ eligible: true });
    expect(await requestResearch(params())).toHaveProperty("turnUuid");
  });
  it("rolls back task execution and deletion when the Idea execution fact cannot persist", async () => {
    const task = await proposalTask();
    state.db = db.$extends({ query: { activity: {
      createMany() { throw new Error("execution fact unavailable"); },
    } } });
    try {
      await expect(updateTask(task.uuid, { status: "in_progress" })).rejects.toThrow("execution fact unavailable");
      expect(await db.task.findUnique({ where: { uuid: task.uuid } })).toMatchObject({ status: "open" });
      expect(await db.activity.count({ where: { companyUuid: state.company, targetUuid: task.uuid } })).toBe(0);
      await db.activity.create({ data: {
        companyUuid: state.company, projectUuid: project, targetType: "task", targetUuid: task.uuid,
        actorType: "system", actorUuid: "", action: "execution_started",
      } });
      await expect(deleteTask(task.uuid)).rejects.toThrow("execution fact unavailable");
      expect(await db.task.findUnique({ where: { uuid: task.uuid } })).not.toBeNull();
      expect(await getResearchEligibility(state.company, idea)).toEqual({ eligible: false, reason: "development_started" });
    } finally {
      state.db = db;
    }
  });
  it("fences legacy history and affected Proposal input Ideas by tenant and project", async () => {
    const foreignCompany = await db.company.create({ data: { name: `Foreign research ${randomUUID()}` } });
    const foreignProject = await db.project.create({ data: { companyUuid: foreignCompany.uuid, name: "Foreign" } });
    const foreignIdea = await db.idea.create({ data: {
      companyUuid: foreignCompany.uuid, projectUuid: foreignProject.uuid, title: "Foreign", createdByUuid: state.actor,
    } });
    const otherProject = await db.project.create({ data: { companyUuid: state.company, name: "Unrelated project" } });
    const otherIdea = await db.idea.create({ data: {
      companyUuid: state.company, projectUuid: otherProject.uuid, title: "Unrelated", createdByUuid: state.actor,
    } });
    try {
      const neverExecuted = await proposalTask();
      // Invalid cross-tenant/project activities must not become evidence for this task.
      await db.activity.createMany({ data: [
        { companyUuid: foreignCompany.uuid, projectUuid: foreignProject.uuid },
        { companyUuid: state.company, projectUuid: otherProject.uuid },
      ].flatMap((scope) => [
        { ...scope, targetType: "task", targetUuid: neverExecuted.uuid, actorType: "system", actorUuid: "", action: "execution_started" },
        { ...scope, targetType: "idea", targetUuid: idea, actorType: "system", actorUuid: "", action: "execution_started" },
      ]) });
      await deleteTask(neverExecuted.uuid);
      expect(await getResearchEligibility(state.company, idea)).toEqual({ eligible: true });
      const executed = await proposalTask();
      await db.proposal.update({ where: { uuid: executed.proposalUuid! }, data: {
        inputUuids: [idea, foreignIdea.uuid, otherIdea.uuid, idea, randomUUID()],
      } });
      await updateTask(executed.uuid, { status: "in_progress" });
      await deleteTask(executed.uuid);
      expect(await getResearchEligibility(state.company, idea)).toEqual({ eligible: false, reason: "development_started" });
      expect(await getResearchEligibility(foreignCompany.uuid, foreignIdea.uuid)).toEqual({ eligible: true });
      expect(await getResearchEligibility(state.company, otherIdea.uuid)).toEqual({ eligible: true });
      expect(await getResearchEligibility(foreignCompany.uuid, idea)).toEqual({ eligible: false, reason: "idea_not_found" });
      expect(await db.activity.count({ where: {
        targetType: "idea", targetUuid: { in: [foreignIdea.uuid, otherIdea.uuid] }, action: "execution_started",
      } })).toBe(0);
    } finally {
      await db.activity.deleteMany({ where: { companyUuid: foreignCompany.uuid } });
      await db.idea.delete({ where: { uuid: foreignIdea.uuid } });
      await db.project.delete({ where: { uuid: foreignProject.uuid } });
      await db.company.delete({ where: { uuid: foreignCompany.uuid } });
    }
  });
  it("theme descendants close Research only on actual execution", async () => {
    const child = await db.idea.create({ data: {
      companyUuid: state.company, projectUuid: project, title: "Child", parentUuid: idea, createdByUuid: agent,
    } });
    const task = await proposalTask("assigned", child.uuid);
    expect(await getResearchEligibility(state.company, idea)).toEqual({ eligible: true });
    await updateTask(task.uuid, { status: "in_progress" });
    expect(await getResearchEligibility(state.company, idea)).toEqual({ eligible: false, reason: "development_started" });
  });
  it("closes a derived-completed Idea with all-closed tasks, but allows mixed open/closed", async () => {
    const task = await proposalTask("closed");
    expect(await getResearchEligibility(state.company, idea)).toEqual({ eligible: false, reason: "idea_completed" });
    await db.task.create({ data: {
      companyUuid: state.company, projectUuid: project, proposalUuid: task.proposalUuid,
      title: "Still planning", status: "open", createdByUuid: agent,
    } });
    expect(await getResearchEligibility(state.company, idea)).toEqual({ eligible: true });
  });
  it("development acceptance racing consumption cannot slip between eligibility and running", async () => {
    const result = await requestResearch(params());
    const [accepted, consumed] = await Promise.all([
      development(),
      advanceTurn(result.turnUuid, "running", { expectedStatus: "pending" }),
    ]);
    expect(accepted.action).toBe("start_development");
    expect(consumed).toMatchObject({ ok: false, reason: "invalid_transition", from: "research_stage_changed" });
    expect(await db.daemonSessionTurn.findUnique({ where: { uuid: result.turnUuid } })).toMatchObject({
      status: "interrupted", interruptedReason: "research_stage_changed",
    });
  });
  it("only one concurrent consumer can claim a Research turn", async () => {
    const result = await requestResearch(params());
    const consumed = await Promise.all([
      advanceTurn(result.turnUuid, "running", { expectedStatus: "pending" }),
      advanceTurn(result.turnUuid, "running", { expectedStatus: "pending" }),
    ]);
    expect(consumed.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.daemonSessionTurn.findUnique({ where: { uuid: result.turnUuid } })).toMatchObject({ status: "running" });
  });
  it("retries the whole transaction after a real PostgreSQL unique-seq violation", async () => {
    const first = await requestResearch(params());
    await db.daemonSessionTurn.update({ where: { uuid: first.turnUuid }, data: { status: "ended" } });
    let injected = false;
    const client = db.$extends({ query: { daemonSessionTurn: {
      create({ args, query }) {
        if (!injected) {
          injected = true;
          // The existing first turn owns seq=1. This statement really aborts the tx.
          args.data.seq = 1;
        }
        return query(args);
      },
    } } });
    state.db = client;
    try {
      const second = await requestResearch(params());
      expect(injected).toBe(true);
      expect(second.sessionUuid).toBe(first.sessionUuid);
      const turns = await db.daemonSessionTurn.findMany({ where: { sessionUuid: first.sessionUuid }, orderBy: { seq: "asc" } });
      expect(turns.map((turn) => turn.seq)).toEqual([1, 2]);
      expect(await db.notification.count({ where: { companyUuid: state.company, entityUuid: idea } })).toBe(2);
    } finally {
      state.db = db;
    }
  });
  it("rolls back session and turn when notification persistence fails, emitting no wake", async () => {
    await db.idea.update({ where: { uuid: idea }, data: { status: "open", assigneeType: null, assigneeUuid: null } });
    state.db = db.$extends({ query: { notification: {
      create() { throw new Error("Injected notification failure"); },
    } } });
    try {
      await expect(requestResearch({ ...params(), selection: { agentUuid: agent, instanceUuid: instance } })).rejects.toThrow("Injected notification failure");
      expect(await db.daemonSession.count({ where: { companyUuid: state.company, directIdeaUuid: idea } })).toBe(0);
      expect(await db.idea.findUnique({ where: { uuid: idea } })).toMatchObject({ status: "open", assigneeType: null, assigneeUuid: null });
      expect(events.emit).not.toHaveBeenCalled();
    } finally {
      state.db = db;
    }
  });
  it.each(["open", "elaborating", "elaborated"])("explicit agent selection preserves %s and existing questions without initialization", async (status) => {
    await db.idea.update({ where: { uuid: idea }, data: {
      status, assigneeType: null, assigneeUuid: null, elaborationStatus: "pending_answers",
    } });
    const round = await db.elaborationRound.create({ data: {
      companyUuid: state.company, ideaUuid: idea, roundNumber: 1, createdByType: "agent", createdByUuid: agent,
      questions: { create: {
        questionId: "q1", text: "Preserve this question", category: "scope",
        options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], selectedOptionId: "a",
      } },
    }, include: { questions: true } });
    const result = await researchIdeaAction(idea, undefined, { agentUuid: agent, instanceUuid: instance });
    expect(result.success).toBe(true);
    expect(await db.idea.findUnique({ where: { uuid: idea } })).toMatchObject({
      status, elaborationStatus: "pending_answers", content: "Preserve this text.",
      assigneeType: "agent_instance", assigneeUuid: instance,
    });
    expect(await db.elaborationRound.findUnique({ where: { uuid: round.uuid }, include: { questions: true } })).toEqual(round);
    expect(await db.activity.count({ where: { companyUuid: state.company, targetUuid: idea } })).toBe(0);
    const session = await db.daemonSession.findFirstOrThrow({ where: { companyUuid: state.company, directIdeaUuid: idea } });
    expect((await db.daemonSessionTurn.findMany({ where: { sessionUuid: session.uuid } })).map((turn) => turn.trigger)).toEqual(["human_instruction"]);
    expect((await db.notification.findMany({ where: { companyUuid: state.company, entityUuid: idea } })).map((n) => n.action)).toEqual(["human_instruction"]);
  });
  it("explicitly pins a bare agent's chosen instance while keeping an open Idea open", async () => {
    await db.idea.update({ where: { uuid: idea }, data: { status: "open", assigneeType: "agent", assigneeUuid: agent } });
    const result = await requestResearch({ ...params(), selection: { agentUuid: agent, instanceUuid: instance } });
    expect(result.session.originConnectionUuid).toBe(connection);
    expect(await db.idea.findUnique({ where: { uuid: idea } })).toMatchObject({ status: "open", assigneeUuid: instance });
    expect(await db.activity.count({ where: { companyUuid: state.company, targetUuid: idea, action: "assigned" } })).toBe(0);
  });
  it("honors a project-fixed runtime cwd without repointing an existing root", async () => {
    await db.idea.update({ where: { uuid: idea }, data: { assigneeType: "agent", assigneeUuid: agent } });
    const preference = await db.projectAgentCwdPreference.create({ data: {
      companyUuid: state.company, userUuid: state.actor, projectUuid: project, agentUuid: agent,
      host: "research-test", cwd: "/fixed/research",
    } });
    try {
      const first = await requestResearch(params());
      expect(first.session.runtimeCwd).toBe("/fixed/research");
      await db.daemonSessionTurn.update({ where: { uuid: first.turnUuid }, data: { status: "ended" } });
      await db.projectAgentCwdPreference.update({ where: { uuid: preference.uuid }, data: { cwd: "/changed/fixed" } });
      await expect(requestResearch(params())).rejects.toMatchObject({ code: "origin_conflict" });
      expect(await db.daemonSession.findUnique({ where: { uuid: first.sessionUuid } })).toMatchObject({ runtimeCwd: "/fixed/research" });
    } finally {
      await db.projectAgentCwdPreference.delete({ where: { uuid: preference.uuid } });
    }
  });
  it("theme completion rolls up all-closed child plans without treating one closed child as execution", async () => {
    await db.idea.update({ where: { uuid: idea }, data: { isContainer: true } });
    const child = await db.idea.create({ data: {
      companyUuid: state.company, projectUuid: project, title: "Completed child", parentUuid: idea, status: "elaborated", createdByUuid: agent,
    } });
    await proposalTask("closed", child.uuid);
    expect(await getResearchEligibility(state.company, idea)).toEqual({ eligible: false, reason: "idea_completed" });
    await db.idea.create({ data: {
      companyUuid: state.company, projectUuid: project, title: "Open child", parentUuid: idea, status: "open", createdByUuid: agent,
    } });
    expect(await getResearchEligibility(state.company, idea)).toEqual({ eligible: true });
  });
  it("requires document read/write for references even with idea and plan permissions", async () => {
    await db.agent.update({ where: { uuid: agent }, data: {
      roles: [], permissions: ["idea:read", "idea:write", "proposal:read", "task:read"],
    } });
    await expect(requestResearch(params())).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("requires selection for multiple unconfigured instances, but preserves an existing root origin", async () => {
    await db.idea.update({ where: { uuid: idea }, data: { assigneeType: "agent", assigneeUuid: agent } });
    const extra = await db.daemonConnection.create({ data: {
      companyUuid: state.company, agentUuid: agent, clientType: "claude_code", status: "online",
      host: "another-host", cwd: "/another-cwd",
    } });
    try {
      await expect(requestResearch(params())).rejects.toMatchObject({ code: "assignment_required" });
      await db.daemonSession.create({ data: {
        companyUuid: state.company, agentUuid: agent, sessionId: idea, directIdeaUuid: idea,
        originConnectionUuid: connection, runtimeCwd: "/tmp/research-test",
      } });
      const result = await requestResearch(params());
      expect(result.session.originConnectionUuid).toBe(connection);
      expect(result.session.runtimeCwd).toBe("/tmp/research-test");
    } finally {
      await db.daemonConnection.delete({ where: { uuid: extra.uuid } });
    }
  });
  it("notification replay cannot duplicate the turn-keyed human instruction", async () => {
    const result = await requestResearch(params());
    const notification = await db.notification.findFirstOrThrow({ where: { companyUuid: state.company, entityUuid: idea } });
    const { EventRouter } = await import("../../../cli/event-router.mjs");
    const enqueue = vi.fn();
    const fetched = vi.fn().mockResolvedValue({ notifications: [notification] });
    const router = new EventRouter({
      mcpClient: { callTool: fetched },
      waker: { keyFor: vi.fn(), wakeBatch: vi.fn(), markQueued: vi.fn() },
      queue: { enqueue }, wakeActions: new Set(["human_instruction"]),
      getConnectionUuid: () => connection,
    });
    router.dispatch({ type: "new_notification", notificationUuid: notification.uuid });
    await vi.waitFor(() => expect(fetched).toHaveBeenCalledOnce());
    expect(enqueue).not.toHaveBeenCalled();
    const pending = await getPendingTurnsForConnection({ companyUuid: state.company, agentUuid: agent, connectionUuid: connection });
    const turn = pending.find((t) => t.turnUuid === result.turnUuid)!;
    router.dispatchPendingTurn(turn);
    router.dispatchPendingTurn(turn);
    expect(enqueue).toHaveBeenCalledOnce();
  });
  it("enforces tenant, human caller, agent ownership and idea edit permission", async () => {
    await expect(requestResearch({ ...params(), companyUuid: randomUUID() })).rejects.toMatchObject({ code: "idea_not_found" });
    await expect(requestResearch({ ...params(), actorType: "agent" })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(requestResearch({ ...params(), actorUuid: randomUUID() })).rejects.toMatchObject({ code: "permission_denied" });
    await db.agent.update({ where: { uuid: agent }, data: { roles: ["developer"] } });
    await expect(requestResearch(params())).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("requires explicit assignment and refuses an offline pinned instance", async () => {
    await db.idea.update({ where: { uuid: idea }, data: { assigneeType: null, assigneeUuid: null } });
    await expect(requestResearch(params())).rejects.toMatchObject({ code: "assignment_required" });
    await db.idea.update({ where: { uuid: idea }, data: { assigneeType: "agent_instance", assigneeUuid: instance } });
    await db.daemonConnection.update({ where: { uuid: connection }, data: { status: "offline" } });
    await expect(requestResearch(params())).rejects.toMatchObject({ code: "agent_offline" });
  });
  it("never repoints an existing root session to another origin", async () => {
    await db.daemonSession.create({ data: {
      companyUuid: state.company, agentUuid: agent, sessionId: idea, directIdeaUuid: idea,
      originConnectionUuid: randomUUID(), runtimeCwd: "/somewhere-else",
    } });
    await expect(requestResearch(params())).rejects.toMatchObject({ code: "origin_conflict" });
  });
});
