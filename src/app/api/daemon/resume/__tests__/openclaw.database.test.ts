import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { NextRequest } from "next/server";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../../../../generated/prisma/client";
import type { AuthContext } from "@/types/auth";
import { createWakeContext } from "@/services/daemon-wake-context";
import "../../../../../../packages/openclaw-plugin/src/openclaw-sdk.d.ts";
import { OpenClawDaemonClient, type WakeRequest, type WakeRunContext } from "../../../../../../packages/openclaw-plugin/src/daemon-client";
import { createDaemonRestClient } from "../../../../../../packages/openclaw-plugin/src/daemon-rest-client";
import { createControlHandler, type ControlEvent } from "../../../../../../packages/openclaw-plugin/src/control-handler";

vi.mock("@/generated/prisma/client", async () => import("../../../../../generated/prisma/client"));
const state = vi.hoisted(() => ({
  db: null as unknown,
  owner: null as unknown as AuthContext,
  agent: null as unknown as AuthContext,
  emit: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/auth", () => ({
  getAuthContext: async (request: NextRequest) => request.nextUrl.pathname.endsWith("/resume") ? state.owner : state.agent,
  hasPermission: () => false,
}));
vi.mock("@/lib/event-bus", () => ({
  eventBus: { emit: state.emit, emitChange: vi.fn(), on: vi.fn() },
  controlEventName: (uuid: string) => `control:${uuid}`,
  transcriptEventName: (uuid: string) => `transcript:${uuid}`,
}));

describe("OpenClaw resume route-to-client against isolated PostgreSQL", () => {
  let database: PGlite;
  let server: PGLiteSocketServer;
  let directory: string;
  let pool: pg.Pool;
  let db: PrismaClient;
  let resume: typeof import("../route")["POST"];
  let pending: typeof import("../../pending-turns/route")["GET"];
  let advance: typeof import("../../turn-advance/route")["POST"];
  let projectUuid: string;
  const routeContext = { params: Promise.resolve({}) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeAll(async () => {
    database = new PGlite();
    for (const migration of (await readdir("prisma/migrations")).filter((name) => /^\d/.test(name)).sort()) {
      await database.exec(await readFile(join("prisma/migrations", migration, "migration.sql"), "utf8"));
    }
    directory = await mkdtemp(join(tmpdir(), "chorus-openclaw-resume-test-"));
    server = new PGLiteSocketServer({ db: database, path: join(directory, ".s.PGSQL.5432") });
    await server.start();
    pool = new pg.Pool({ host: directory, port: 5432, database: "postgres", user: "postgres", max: 1 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    resume = (await import("../route")).POST;
    pending = (await import("../../pending-turns/route")).GET;
    advance = (await import("../../turn-advance/route")).POST;
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    await pool?.end();
    await server?.stop();
    await database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    const company = await db.company.create({ data: { name: "Isolated OpenClaw resume" } });
    const owner = await db.user.create({ data: { companyUuid: company.uuid, oidcSub: randomUUID() } });
    const agent = await db.agent.create({ data: { companyUuid: company.uuid, ownerUuid: owner.uuid, name: "OpenClaw", roles: ["admin_agent"] } });
    state.owner = { type: "user", companyUuid: company.uuid, actorUuid: owner.uuid };
    state.agent = { type: "agent", companyUuid: company.uuid, actorUuid: agent.uuid, ownerUuid: owner.uuid };
    projectUuid = (await db.project.create({ data: { companyUuid: company.uuid, name: "Resume", createdByUuid: owner.uuid } })).uuid;
    const template = await db.agentTeam.create({ data: {
      companyUuid: company.uuid, ownerUuid: owner.uuid, name: "Team",
      members: { create: [{ role: "development", agentUuid: agent.uuid }] },
    } });
    await db.projectAgentTeam.create({ data: {
      companyUuid: company.uuid, ownerUuid: owner.uuid, projectUuid,
      templateUuid: template.uuid, templateName: "Team", snapshot: {},
    } });
  });

  async function interrupted(kind: "task" | "legacy" | "current", reason: "user" | "crash" = "user") {
    const companyUuid = state.owner.companyUuid;
    const agentUuid = state.agent.actorUuid;
    const entityType = kind === "task" ? "task" : "idea";
    const entity = kind === "task"
      ? await db.task.create({ data: { companyUuid, projectUuid, title: "Quick task", createdByUuid: state.owner.actorUuid } })
      : await db.idea.create({ data: {
        companyUuid, projectUuid, title: "Idea", createdByUuid: state.owner.actorUuid,
        status: "elaborating", assigneeType: "agent", assigneeUuid: agentUuid,
        teamOwnerUuid: state.owner.actorUuid, teamLeadAgentUuid: agentUuid,
        ...(kind === "current" ? { teamEnrollmentVersion: 1, teamGeneration: 1, teamEnrolledAt: new Date(), teamEnrolledByUuid: state.owner.actorUuid } : {}),
      } });
    const directIdeaUuid = kind === "task" ? null : entity.uuid;
    const connection = await db.daemonConnection.create({ data: { companyUuid, agentUuid, clientType: "openclaw", host: randomUUID(), cwd: "/work", status: "online" } });
    const session = await db.daemonSession.create({ data: { companyUuid, agentUuid, sessionId: entity.uuid, directIdeaUuid, originConnectionUuid: connection.uuid } });
    const execution = await db.daemonExecution.create({ data: {
      companyUuid, agentUuid, connectionUuid: connection.uuid, entityType, entityUuid: entity.uuid,
      directIdeaUuid, status: "interrupted", interruptedReason: reason,
    } });
    const notification = await db.notification.create({ data: {
      companyUuid, projectUuid, recipientType: "agent", recipientUuid: agentUuid, entityType, entityUuid: entity.uuid,
      action: "assigned", actorType: "user", actorUuid: state.owner.actorUuid, message: "Continue", entityTitle: entity.title,
      projectName: "Resume", actorName: "Owner",
    } });
    const wakeContext = kind === "current" ? {
      ...createWakeContext(notification)!,
      ideaTeam: { ideaUuid: entity.uuid, generation: 1, ownerUuid: state.owner.actorUuid, agentUuid, role: "orchestrator" as const },
    } : undefined;
    await db.daemonSessionTurn.create({ data: {
      sessionUuid: session.uuid, executionUuid: execution.uuid, seq: 1, trigger: "task_assigned", status: "interrupted",
      ...(wakeContext ? { wakeContext, wakeTargetConnectionUuid: connection.uuid } : {}),
    } });
    const body = { connectionUuid: connection.uuid, entityType, entityUuid: entity.uuid };
    return { body, session, execution, wakeContext, reason };
  }

  function clientFor(connectionUuid: string, beforeRun?: () => Promise<unknown>) {
    const requests: WakeRequest[] = [];
    const runs: Promise<void>[] = [];
    const admissions: number[] = [];
    const runEmbeddedAgent = vi.fn(async () => ({ meta: { durationMs: 0 } }));
    const restClient = createDaemonRestClient({
      url: "http://chorus.test", apiKey: "test", getConnectionUuid: () => connectionUuid,
      fetchImpl: async (input, init) => {
        const request = new NextRequest(String(input), { ...init, signal: init?.signal ?? undefined });
        if (request.nextUrl.pathname.endsWith("/pending-turns")) return pending(request, routeContext);
        if (request.nextUrl.pathname.endsWith("/turn-advance")) {
          const response = await advance(request, routeContext);
          admissions.push(response.status);
          return response;
        }
        return Response.json({ success: true });
      },
    });
    const runContext: WakeRunContext = {
      config: { mcp: { servers: { chorus: { url: "http://chorus.test/api/mcp", transport: "streamable-http" } } } },
      agent: { runEmbeddedAgent,
        resolveAgentDir: () => "/work", resolveAgentWorkspaceDir: () => "/work", resolveAgentTimeoutMs: () => 1000,
        session: {
        getSessionEntry: () => undefined,
        resolveSessionFilePath: (sessionId: string) => `/sessions/${sessionId}.jsonl`,
      } },
      sessionKey: "agent:main:main", agentId: "main", workspaceDir: "/work", timeoutMs: 1000, modelRef: null,
    };
    const client = new OpenClawDaemonClient({
      restClient, resolveRunContext: () => runContext, logger, buildTurnPrompt: () => "Continue",
      redispatch: (request) => {
        requests.push(request);
        runs.push(Promise.resolve().then(beforeRun).then(() => client.runWake(request)));
      },
    });
    const control = createControlHandler({ connectionState: { getConnectionUuid: () => connectionUuid }, logger,
      hooks: { onResume: (entityType, entityUuid) => client.resume(entityType, entityUuid) },
    });
    return { client, control, requests, runs, admissions, runEmbeddedAgent, restClient };
  }

  function post(body: unknown) {
    return resume(new NextRequest("http://chorus.test/api/daemon/resume", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), routeContext);
  }

  function controlEvents() {
    return state.emit.mock.calls.filter(([name]) => name.startsWith("control:")).map(([, event]) => event as ControlEvent);
  }

  it.each([
    ["task", "user"], ["task", "crash"],
    ["legacy", "user"], ["legacy", "crash"],
    ["current", "user"], ["current", "crash"],
  ] as const)("resumes %s after %s interruption with a persisted continuation that OpenClaw admits and runs", async (kind, reason) => {
    const fixture = await interrupted(kind, reason);
    const runtime = clientFor(fixture.body.connectionUuid);
    expect((await runtime.restClient.readPendingTurns()).data?.turns).toEqual([]);
    expect((await post(fixture.body)).status).toBe(200);
    const continuation = await db.daemonSessionTurn.findFirstOrThrow({ where: { sessionUuid: fixture.session.uuid, trigger: "resume" } });
    expect(continuation).toMatchObject({ status: "pending", executionUuid: fixture.execution.uuid });
    if (fixture.wakeContext) expect(continuation.wakeContext).toEqual(fixture.wakeContext);
    expect(controlEvents()).toEqual([expect.objectContaining({ command: "resume", targetConnectionUuid: fixture.body.connectionUuid, turnUuid: continuation.uuid, resumeReason: reason })]);
    runtime.control(controlEvents()[0]);
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    await Promise.all(runtime.runs);
    expect(runtime.requests[0]).toMatchObject({ entityType: fixture.body.entityType, entityUuid: fixture.body.entityUuid, sessionId: fixture.session.sessionId, turnUuid: continuation.uuid });
    expect(runtime.admissions).toEqual([200, 200]);
    expect(runtime.runEmbeddedAgent).toHaveBeenCalledTimes(1);
    expect(await db.daemonSessionTurn.findUniqueOrThrow({ where: { uuid: continuation.uuid } })).toMatchObject({ status: "ended", admissionConnectionUuid: fixture.body.connectionUuid });
    runtime.control(controlEvents()[0]);
    await runtime.client.deliverTurn();
    expect(runtime.requests).toHaveLength(1);
  });

  it.each(["user", "crash"] as const)("restores %s interruption and emits no control when the v1 generation is stale", async (reason) => {
    const fixture = await interrupted("current", reason);
    const runtime = clientFor(fixture.body.connectionUuid);
    await db.idea.update({ where: { uuid: fixture.body.entityUuid }, data: { teamGeneration: { increment: 1 } } });
    expect((await post(fixture.body)).status).toBe(409);
    expect(controlEvents()).toEqual([]);
    expect(await db.daemonExecution.findUniqueOrThrow({ where: { uuid: fixture.execution.uuid } })).toMatchObject({ status: "interrupted", interruptedReason: reason });
    expect(await db.daemonSessionTurn.count({ where: { sessionUuid: fixture.session.uuid, trigger: "resume" } })).toBe(0);
    await runtime.client.deliverTurn();
    expect(runtime.requests).toEqual([]);
    expect(runtime.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("rejects a v1 continuation revoked between pending delivery and admission without a turnless retry", async () => {
    const fixture = await interrupted("current");
    const runtime = clientFor(fixture.body.connectionUuid, () => db.idea.update({
      where: { uuid: fixture.body.entityUuid }, data: { teamGeneration: { increment: 1 } },
    }));
    expect((await post(fixture.body)).status).toBe(200);
    runtime.control(controlEvents()[0]);
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    await Promise.all(runtime.runs);
    expect(runtime.admissions).toHaveLength(1);
    expect(runtime.admissions[0]).toBeGreaterThanOrEqual(400);
    expect(runtime.runEmbeddedAgent).not.toHaveBeenCalled();
    await runtime.client.deliverTurn();
    expect(runtime.requests).toHaveLength(1);
    expect(await db.daemonSessionTurn.findUniqueOrThrow({ where: { uuid: runtime.requests[0].turnUuid! } })).toMatchObject({ status: "pending", admissionUuid: null });
  });

  it("fails closed for v1 when the interrupted source turn is missing", async () => {
    const fixture = await interrupted("current");
    await db.daemonSessionTurn.deleteMany({ where: { sessionUuid: fixture.session.uuid } });
    expect((await post(fixture.body)).status).toBe(409);
    expect(controlEvents()).toEqual([]);
    expect(await db.daemonSessionTurn.count({ where: { sessionUuid: fixture.session.uuid } })).toBe(0);
    expect(await db.daemonExecution.findUniqueOrThrow({ where: { uuid: fixture.execution.uuid } })).toMatchObject({ status: "interrupted" });
  });
});
