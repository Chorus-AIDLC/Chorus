import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../generated/prisma/client";
import { EventRouter } from "../../../cli/event-router.mjs";
import { WakeQueue } from "../../../cli/wake-queue.mjs";
import { Waker } from "../../../cli/waker.mjs";
import { LineageResolver } from "../../../cli/lineage.mjs";
import { validateDirectory } from "../../../cli/directory-discovery.mjs";
import { createBackfill } from "../../../cli/backfill.mjs";
import { createControlHandler } from "../../../cli/control-handler.mjs";
import { createDeliveryRecovery } from "../../../cli/delivery-recovery.mjs";
import { createDaemonRestClient } from "../../../cli/daemon-rest-client.mjs";
import { createTurnReporter } from "../../../cli/turn-reporter.mjs";
import { createTranscriptUploadHooks } from "../../../cli/upload-hooks.mjs";
import { WAKE_ACTIONS } from "../../../cli/prompts.mjs";

const state = vi.hoisted(() => ({ db: null as unknown, companyUuid: "", agentUuid: "" }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/auth", async (original) => ({
  ...await original<typeof import("@/lib/auth")>(),
  getAuthContext: async () => ({
    type: "agent", companyUuid: state.companyUuid, actorUuid: state.agentUuid, permissions: ["idea:read"],
  }),
}));

type AdmissionFault = "none" | "precommit503" | "lost-response" | "delayed-request" | "delayed-response";
type WireRequest = { path: string; body: any; status?: number };

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("isolated database / CLI durable wake delivery", () => {
  let database: PGlite;
  let socket: PGLiteSocketServer;
  let directory: string;
  let pool: pg.Pool;
  let db: PrismaClient;
  let sessions: typeof import("../daemon-session.service");
  let notifications: typeof import("../notification.service");
  let pendingRoute: typeof import("../../app/api/daemon/pending-turns/route");
  let advanceRoute: typeof import("../../app/api/daemon/turn-advance/route");
  let transcriptRoute: typeof import("../../app/api/daemon/transcript/route");
  let lineageRoute: typeof import("../../app/api/entities/[type]/[uuid]/root-idea/route");
  let eventBus: typeof import("@/lib/event-bus").eventBus;
  let projectUuid: string;
  let ideaUuid: string;
  let connectionUuid: string;
  let sessionUuid: string;
  let legacyUuid: string;
  const events: any[] = [];
  const controls: any[] = [];
  const disposers: (() => Promise<void>)[] = [];
  const captureNotification = (event: unknown) => { events.push(event); };
  const captureControl = (event: unknown) => { controls.push(event); };

  beforeAll(async () => {
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("REDIS_HOST", "");
    database = new PGlite();
    for (const migration of (await readdir("prisma/migrations")).filter((name) => /^\d/.test(name)).sort()) {
      await database.exec(await readFile(join("prisma/migrations", migration, "migration.sql"), "utf8"));
    }
    directory = await mkdtemp(join(tmpdir(), "chorus-delivery-test-"));
    socket = new PGLiteSocketServer({ db: database, path: join(directory, ".s.PGSQL.5432") });
    await socket.start();
    pool = new pg.Pool({ host: directory, port: 5432, database: "postgres", user: "postgres", max: 1 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    sessions = await import("../daemon-session.service");
    notifications = await import("../notification.service");
    pendingRoute = await import("../../app/api/daemon/pending-turns/route");
    advanceRoute = await import("../../app/api/daemon/turn-advance/route");
    transcriptRoute = await import("../../app/api/daemon/transcript/route");
    lineageRoute = await import("../../app/api/entities/[type]/[uuid]/root-idea/route");
    ({ eventBus } = await import("@/lib/event-bus"));
  }, 60_000);

  beforeEach(async () => {
    events.length = 0;
    controls.length = 0;
    state.companyUuid = (await db.company.create({ data: { name: "isolated delivery" } })).uuid;
    state.agentUuid = (await db.agent.create({ data: { companyUuid: state.companyUuid, name: "fake subprocess" } })).uuid;
    projectUuid = (await db.project.create({ data: { companyUuid: state.companyUuid, name: "delivery project", visibility: "public" } })).uuid;
    ideaUuid = (await db.idea.create({ data: {
      companyUuid: state.companyUuid, projectUuid, title: "delivery idea", createdByUuid: state.agentUuid,
      assigneeType: "agent", assigneeUuid: state.agentUuid,
    } })).uuid;
    connectionUuid = (await db.daemonConnection.create({ data: {
      companyUuid: state.companyUuid, agentUuid: state.agentUuid, clientType: "codex", status: "online",
      host: "isolated-delivery", cwd: directory,
    } })).uuid;
    sessionUuid = (await sessions.resolveOrCreateSession({
      companyUuid: state.companyUuid, agentUuid: state.agentUuid, sessionId: ideaUuid,
      directIdeaUuid: ideaUuid, originConnectionUuid: connectionUuid,
    })).uuid;
    legacyUuid = (await sessions.createPendingTurn({ sessionUuid, trigger: "mentioned" })).uuid;
    eventBus.on(`notification:agent:${state.agentUuid}`, captureNotification);
    eventBus.on(`control:${connectionUuid}`, captureControl);
  });

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
    eventBus?.off(`notification:agent:${state.agentUuid}`, captureNotification);
    eventBus?.off(`control:${connectionUuid}`, captureControl);
  });

  afterAll(async () => {
    try {
      await db?.$disconnect();
      await pool?.end();
      await socket?.stop();
      await database?.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  const savedTurn = (uuid: string) => db.daemonSessionTurn.findUniqueOrThrow({ where: { uuid } });
  const messages = (turnUuid: string) => db.daemonTranscriptMessage.findMany({ where: { turnUuid }, orderBy: { seq: "asc" } });

  async function createWake(message: string, action = "mentioned") {
    const result = await notifications.createReturningTurn({
      companyUuid: state.companyUuid, projectUuid, projectName: "delivery project",
      recipientType: "agent", recipientUuid: state.agentUuid, entityType: "idea", entityUuid: ideaUuid,
      entityTitle: "delivery idea", action, message, actorType: "user", actorUuid: randomUUID(), actorName: "Fixture human",
      instructionText: action === "human_instruction" ? message : null,
      pinnedHost: "isolated-delivery", pinnedCwd: directory,
    });
    expect(result.turn).not.toBeNull();
    const turn = await savedTurn(result.turn!.uuid);
    expect(turn).toMatchObject({ sessionUuid, status: "pending", wakeContext: {
      version: 1, notificationUuid: result.notification.uuid, notification: { message, action, entityUuid: ideaUuid },
    } });
    return { ...result, turn, event: events.find((event) => event.notificationUuid === result.notification.uuid) };
  }

  async function hideNotification(wake: Awaited<ReturnType<typeof createWake>>) {
    await notifications.markRead(wake.notification.uuid, state.companyUuid, "agent", state.agentUuid);
    await db.notification.createMany({ data: Array.from({ length: 51 }, () => ({
      companyUuid: state.companyUuid, projectUuid, projectName: "delivery project", recipientType: "agent",
      recipientUuid: state.agentUuid, entityType: "idea", entityUuid: ideaUuid, entityTitle: "newer unrelated notice",
      action: "updated", message: "not the original comment", actorType: "user", actorUuid: randomUUID(),
      actorName: "Fixture", createdAt: new Date(Date.now() + 1_000),
    })) });
    const recent = await notifications.list({ companyUuid: state.companyUuid, recipientType: "agent", recipientUuid: state.agentUuid, readFilter: "all", take: 50 });
    expect(recent.notifications).toHaveLength(50);
    expect(recent.notifications.some((notification) => notification.uuid === wake.notification.uuid)).toBe(false);
  }

  async function routeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const address = new URL(String(input));
    expect(address.origin).toBe("https://delivery.invalid");
    const request = new NextRequest(address, { method: init?.method, headers: init?.headers, body: init?.body });
    if (address.pathname === "/api/daemon/pending-turns") return pendingRoute.GET(request, { params: Promise.resolve({}) });
    if (address.pathname === "/api/daemon/turn-advance") return advanceRoute.POST(request, { params: Promise.resolve({}) });
    if (address.pathname === "/api/daemon/transcript") return transcriptRoute.POST(request, { params: Promise.resolve({}) });
    if (address.pathname === `/api/entities/idea/${ideaUuid}/root-idea`) {
      return lineageRoute.GET(request, { params: Promise.resolve({ type: "idea", uuid: ideaUuid }) });
    }
    throw new Error(`Unexpected isolated request ${address.pathname}`);
  }

  function harness(options: { fault?: AdmissionFault; pauseQueue?: boolean; failReads?: boolean } = {}) {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const wire: WireRequest[] = [];
    const launches: { prompt: string; turnUuid: string }[] = [];
    const batches: any[][] = [];
    const errors: unknown[] = [];
    const inFlight = new Set<Promise<Response>>();
    const gate = deferred();
    const faults = { reads: options.failReads ?? false, pendingFailures: 0, notificationFailures: 0, admissionAttempts: 0 };
    const fetchImpl: typeof fetch = (input, init) => {
      const running = (async () => {
        const path = new URL(String(input)).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        const record: WireRequest = { path, body };
        wire.push(record);
        if (path === "/api/daemon/pending-turns" && faults.reads) {
          faults.pendingFailures++;
          throw new TypeError("isolated pending read ECONNRESET");
        }
        const firstAdmission = path === "/api/daemon/turn-advance" && body.status === "running" && ++faults.admissionAttempts === 1;
        if (firstAdmission && options.fault === "precommit503") {
          record.status = 503;
          return new Response("precommit unavailable", { status: 503 });
        }
        if (firstAdmission && options.fault === "delayed-request") await gate.promise;
        const response = await routeFetch(input, init);
        record.status = response.status;
        if (firstAdmission && options.fault === "lost-response") throw new TypeError("isolated committed response ECONNRESET");
        if (firstAdmission && options.fault === "delayed-response") await gate.promise;
        return response;
      })();
      inFlight.add(running);
      void running.then(() => inFlight.delete(running), () => inFlight.delete(running));
      return running;
    };
    const clientOptions = { url: "https://delivery.invalid", apiKey: "isolated-fixture", getConnectionUuid: () => connectionUuid, fetchImpl, logger };
    const rest = createDaemonRestClient(clientOptions);
    const mcpClient = { callTool: async (name: string, args: any) => {
      if (name !== "chorus_get_notifications") throw new Error(`Unexpected MCP adaptation ${name}`);
      if (faults.reads) {
        faults.notificationFailures++;
        throw new TypeError("isolated notification read ECONNRESET");
      }
      expect(args.autoMarkRead).toBe(false);
      return notifications.list({ companyUuid: state.companyUuid, recipientType: "agent", recipientUuid: state.agentUuid, readFilter: args.status, take: args.limit });
    } };
    const seen = new Set<string>();
    let router: EventRouter;
    const waker = new Waker({
      creds: clientOptions, cwd: directory, logger, lineage: new LineageResolver(clientOptions),
      validateRuntimeCwd: (cwd: string) => validateDirectory({ cwd, browseRoots: [directory] }),
      advanceTurn: createTurnReporter(clientOptions),
      hooks: createTranscriptUploadHooks({ ...clientOptions, batchDelayMs: 60_000 }),
      onAdmissionCancelled: (turnUuids: string[]) => router.releaseAccepted(turnUuids),
      spawner: { wake: async (params: any) => {
        const turnUuid = batches.at(-1)![0].turnUuid;
        launches.push({ prompt: params.prompt, turnUuid });
        try {
          expect(await savedTurn(turnUuid)).toMatchObject({ status: "running", admissionUuid: expect.any(String) });
          expect(JSON.parse(await readFile(params.mcpConfigPath, "utf8")).mcpServers.chorus.url).toBe("https://delivery.invalid/api/mcp");
        } catch (error) { errors.push(error); }
        params.onChild({ pid: 0 });
        params.onMessage({ type: "assistant", message: { role: "assistant", content: `reply:${turnUuid}` } });
        return { sessionId: params.sessionId, backendSessionId: `isolated-${params.sessionId}`, exitCode: 0, isNew: true };
      } },
    } as any);
    const queue = new WakeQueue({ logger, maxConcurrency: options.pauseQueue ? 0 : 1, runBatch: async (key: string, items: any[]) => {
      batches.push(items.map((item) => item.notification));
      try { await waker.wakeBatch(items.map((item) => item.notification), key, items[0].attribution); }
      catch (error) { errors.push(error); }
    } });
    router = new EventRouter({ queue, waker, mcpClient, seen, wakeActions: WAKE_ACTIONS, logger, getConnectionUuid: clientOptions.getConnectionUuid } as any);
    const backfill = createBackfill({ ...clientOptions, mcpClient, seen,
      dispatch: (event: any) => router.dispatch(event),
      dispatchPendingTurn: (turn: any, dispatchOptions: any) => router.dispatchPendingTurn(turn, dispatchOptions),
    } as any) as unknown as (() => Promise<void>) & { pendingTurnsOnly: (turnUuid?: string) => Promise<unknown> };
    const recovery = createDeliveryRecovery({ router, backfill, getConnectionUuid: clientOptions.getConnectionUuid, logger, intervalMs: 75 });
    const control = createControlHandler({ waker, getConnectionUuid: clientOptions.getConnectionUuid, logger,
      deliverTurn: (turnUuid: string) => recovery.deliver(turnUuid),
    } as any);
    const stop = () => { recovery.stop(); queue.stop(); waker.stop(); };
    disposers.push(async () => {
      stop();
      gate.release();
      await Promise.allSettled([...inFlight]);
      expect(await queue.drain(5_000)).toBe(true);
      await vi.waitFor(() => expect(inFlight.size).toBe(0));
    });
    const settled = async () => {
      expect(await queue.drain(5_000)).toBe(true);
      expect(queue.pendingKeyCount).toBe(0);
      expect(errors).toEqual([]);
    };
    return { faults, wire, launches, batches, logger, rest, router, backfill, recovery, control, seen, queue, stop, gate, settled };
  }

  async function expectLegacyUntouched() {
    expect(await savedTurn(legacyUuid)).toMatchObject({ status: "pending", startedAt: null, endedAt: null, admissionUuid: null, wakeContext: null });
    expect(await messages(legacyUuid)).toEqual([]);
  }

  function deferredWakeParams(overrides: Partial<Parameters<typeof notifications.createReturningTurn>[0]> = {}) {
    return {
      companyUuid: state.companyUuid, projectUuid, projectName: "delivery project",
      recipientType: "agent", recipientUuid: state.agentUuid, entityType: "idea", entityUuid: ideaUuid,
      entityTitle: "delivery idea", action: "mentioned", message: "offline comment", actorType: "user",
      actorUuid: randomUUID(), actorName: "Fixture human", ...overrides,
    };
  }

  async function pendingFor(target = connectionUuid) {
    const response = await routeFetch(`https://delivery.invalid/api/daemon/pending-turns?connectionUuid=${target}&wakeRecoveryProtocol=1`);
    expect(response.status).toBe(200);
    return (await response.json()).data.turns as any[];
  }

  it("recovers newly persisted offline notifications even after read, but never historical unread rows", async () => {
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "offline" } });
    const wake = await notifications.createReturningTurn(deferredWakeParams());
    expect(wake.turn).toBeNull();
    expect(await db.notification.findUniqueOrThrow({ where: { uuid: wake.notification.uuid } })).toMatchObject({ wakeRecoveryPending: true, wakeRecovery: { version: 1 } });
    const historical = await db.notification.create({ data: deferredWakeParams({ message: "historical unread" }) });
    await notifications.markRead(wake.notification.uuid, state.companyUuid, "agent", state.agentUuid);
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "online", lastSeenAt: new Date() } });
    const worker = harness();
    worker.recovery.register();
    await vi.waitFor(() => expect(worker.launches).toHaveLength(1), { timeout: 5_000 });
    await worker.settled();
    const recovered = await db.daemonSessionTurn.findUniqueOrThrow({ where: { wakeNotificationUuid: wake.notification.uuid } });
    expect(recovered).toMatchObject({ status: "ended", wakeContext: { notificationUuid: wake.notification.uuid } });
    expect(worker.launches[0].prompt).toContain("offline comment");
    await pendingFor();
    expect(await db.daemonSessionTurn.count({ where: { wakeNotificationUuid: wake.notification.uuid } })).toBe(1);
    expect(await db.daemonSessionTurn.findUnique({ where: { wakeNotificationUuid: historical.uuid } })).toBeNull();
    expect(await db.notification.findUniqueOrThrow({ where: { uuid: wake.notification.uuid } })).toMatchObject({ wakeRecoveryPending: false });
    await expectLegacyUntouched();
  });

  it("preserves explicit offline pins through other connections and recovers only on the selected target", async () => {
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "offline" } });
    const other = await db.daemonConnection.create({ data: { companyUuid: state.companyUuid, agentUuid: state.agentUuid, clientType: "codex", status: "online", host: "other-host", cwd: "/other" } });
    const wake = await notifications.createReturningTurn(deferredWakeParams({ pinnedHost: "isolated-delivery", pinnedCwd: directory }));
    expect(wake.turn).toBeNull();
    expect(await pendingFor(other.uuid)).toEqual([]);
    expect(await db.daemonSessionTurn.findUnique({ where: { wakeNotificationUuid: wake.notification.uuid } })).toBeNull();
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "online", lastSeenAt: new Date() } });
    expect(await pendingFor(other.uuid)).toEqual([]);
    expect(await pendingFor()).toEqual(expect.arrayContaining([expect.objectContaining({ wakeContext: expect.objectContaining({ notificationUuid: wake.notification.uuid }) })]));
  });

  it("does not recover deferred work after project access revocation", async () => {
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "offline" } });
    const wake = await notifications.createReturningTurn(deferredWakeParams());
    await db.project.update({ where: { uuid: projectUuid }, data: { visibility: "private" } });
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "online", lastSeenAt: new Date() } });
    expect(await pendingFor()).toEqual([]);
    expect(await db.daemonSessionTurn.findUnique({ where: { wakeNotificationUuid: wake.notification.uuid } })).toBeNull();
    expect(await db.notification.findUniqueOrThrow({ where: { uuid: wake.notification.uuid } })).toMatchObject({ wakeRecoveryPending: false });
  });

  it("retains proposal ambiguity suppression during offline recovery", async () => {
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "offline" } });
    const standalone = await db.idea.create({ data: { companyUuid: state.companyUuid, projectUuid, title: "no canonical session", createdByUuid: state.agentUuid } });
    const wake = await notifications.createReturningTurn(deferredWakeParams({ action: "proposal_approved", entityUuid: standalone.uuid }));
    expect(wake.turn).toBeNull();
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "online", lastSeenAt: new Date() } });
    await db.daemonConnection.create({ data: { companyUuid: state.companyUuid, agentUuid: state.agentUuid, clientType: "codex", status: "online", host: "second-host", cwd: "/second" } });
    await pendingFor();
    expect(await db.daemonSessionTurn.findUnique({ where: { wakeNotificationUuid: wake.notification.uuid } })).toBeNull();
    expect(await db.notification.findUniqueOrThrow({ where: { uuid: wake.notification.uuid } })).toMatchObject({ wakeRecoveryPending: false });
  });

  it("deduplicates concurrent materialization and repairs a lost outbox settlement without replay", async () => {
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "offline" } });
    const wake = await notifications.createReturningTurn(deferredWakeParams());
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "online", lastSeenAt: new Date() } });
    await Promise.all([pendingFor(), pendingFor()]);
    const recovered = await db.daemonSessionTurn.findUniqueOrThrow({ where: { wakeNotificationUuid: wake.notification.uuid } });
    expect(await db.daemonSessionTurn.count({ where: { wakeNotificationUuid: wake.notification.uuid } })).toBe(1);
    await db.daemonSessionTurn.update({ where: { uuid: recovered.uuid }, data: { status: "ended" } });
    await db.notification.update({ where: { uuid: wake.notification.uuid }, data: { wakeRecoveryPending: true } });
    await pendingFor();
    expect(await db.daemonSessionTurn.count({ where: { wakeNotificationUuid: wake.notification.uuid } })).toBe(1);
    expect(await db.notification.findUniqueOrThrow({ where: { uuid: wake.notification.uuid } })).toMatchObject({ wakeRecoveryPending: false });
  });

  it("recovers batch-created offline mentions with their original pins after archival", async () => {
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "offline" } });
    const batch = await notifications.createBatch([
      deferredWakeParams({ pinnedHost: "isolated-delivery", pinnedCwd: directory, message: "batch one" }),
      deferredWakeParams({ pinnedHost: "isolated-delivery", pinnedCwd: directory, message: "batch two" }),
    ]);
    await db.notification.updateMany({ where: { uuid: { in: batch.map((notification) => notification.uuid) } }, data: { archivedAt: new Date(), readAt: new Date() } });
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "online", lastSeenAt: new Date() } });
    const recovered = (await pendingFor()).filter((turn) => turn.wakeContext);
    expect(recovered.map((turn) => turn.wakeContext.notification.message)).toEqual(["batch one", "batch two"]);
    expect(new Set(recovered.map((turn) => turn.turnUuid)).size).toBe(2);
    expect(await db.notification.count({ where: { recipientUuid: state.agentUuid, wakeRecoveryPending: true } })).toBe(0);
  });

  it("repoints standalone task sessions while preserving immutable admission ownership", async () => {
    const task = await db.task.create({ data: { companyUuid: state.companyUuid, projectUuid, title: "quick task", createdByUuid: state.agentUuid } });
    const params = deferredWakeParams({ entityType: "task", entityUuid: task.uuid, pinnedHost: "isolated-delivery", pinnedCwd: directory });
    const first = await notifications.createReturningTurn(params);
    expect(first.turn).not.toBeNull();
    const admission = { companyUuid: state.companyUuid, agentUuid: state.agentUuid, connectionUuid, sessionId: task.uuid, turnUuid: first.turn!.uuid, turnUuids: [first.turn!.uuid], admissionUuid: randomUUID(), wakeRecoveryProtocol: 1 as const, status: "running" as const };
    expect(await sessions.advanceTurnForWake(admission)).toMatchObject({ ok: true });
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "offline" } });
    const replacement = await db.daemonConnection.create({ data: { companyUuid: state.companyUuid, agentUuid: state.agentUuid, clientType: "codex", status: "online", host: "new-host", cwd: "/new" } });
    const next = await notifications.createReturningTurn({ ...params, pinnedHost: "new-host", pinnedCwd: "/new" });
    expect(next.turn).not.toBeNull();
    expect(await db.daemonSession.findUniqueOrThrow({ where: { uuid: next.turn!.sessionUuid } })).toMatchObject({ sessionId: task.uuid, directIdeaUuid: null, originConnectionUuid: replacement.uuid, runtimeCwd: "/new" });
    expect(await pendingFor(replacement.uuid)).toEqual(expect.arrayContaining([expect.objectContaining({ turnUuid: next.turn!.uuid })]));
    expect(await sessions.advanceTurnForWake({ ...admission, connectionUuid: replacement.uuid, status: "ended" })).toMatchObject({ ok: false });
    expect(await sessions.advanceTurnForWake({ ...admission, status: "ended" })).toMatchObject({ ok: true });
    expect(await sessions.advanceTurnForWake({ ...admission, connectionUuid: replacement.uuid, turnUuid: next.turn!.uuid, turnUuids: [next.turn!.uuid], admissionUuid: randomUUID() })).toMatchObject({ ok: true });
  });

  it.each(["task", "idea"])("keeps materialized %s hard pins owned by their target after canonical origin changes", async (entityType) => {
    const entityUuid = entityType === "idea" ? ideaUuid : (await db.task.create({ data: { companyUuid: state.companyUuid, projectUuid, title: "pinned task", createdByUuid: state.agentUuid } })).uuid;
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "offline" } });
    const second = await db.daemonConnection.create({ data: { companyUuid: state.companyUuid, agentUuid: state.agentUuid, clientType: "codex", status: "offline", host: "pinned-second", cwd: "/second" } });
    const firstWake = await notifications.createReturningTurn(deferredWakeParams({ entityType, entityUuid, pinnedHost: "isolated-delivery", pinnedCwd: directory, message: "only execute on A" }));
    const secondWake = await notifications.createReturningTurn(deferredWakeParams({ entityType, entityUuid, pinnedHost: "pinned-second", pinnedCwd: "/second", message: "only execute on B" }));
    expect(firstWake.turn).toBeNull();
    expect(secondWake.turn).toBeNull();
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "online", lastSeenAt: new Date() } });
    const firstTurn = (await pendingFor()).find((turn) => turn.wakeContext?.notificationUuid === firstWake.notification.uuid);
    expect(firstTurn).toBeDefined();
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "offline" } });
    await db.daemonConnection.update({ where: { uuid: second.uuid }, data: { status: "online", lastSeenAt: new Date() } });
    const onSecond = await pendingFor(second.uuid);
    const secondTurn = onSecond.find((turn) => turn.wakeContext?.notificationUuid === secondWake.notification.uuid);
    expect(secondTurn).toMatchObject({ runtimeCwd: "/second" });
    expect(onSecond.some((turn) => turn.turnUuid === firstTurn.turnUuid)).toBe(false);
    expect(await sessions.getWakeRecoveryDelivery(state.companyUuid, state.agentUuid, second.uuid, firstTurn.turnUuid)).toBeNull();
    expect(await sessions.canAgentReceiveTurn(state.companyUuid, state.agentUuid, firstTurn.turnUuid, second.uuid)).toBe(false);
    const admission = { companyUuid: state.companyUuid, agentUuid: state.agentUuid, connectionUuid: second.uuid, sessionId: entityUuid, turnUuid: firstTurn.turnUuid, turnUuids: [firstTurn.turnUuid], admissionUuid: randomUUID(), wakeRecoveryProtocol: 1 as const, status: "running" as const };
    expect(await sessions.advanceTurnForWake(admission)).toMatchObject({ ok: false, reason: "not_found" });
    expect(await sessions.advanceTurnForWake({ ...admission, turnUuid: secondTurn.turnUuid, turnUuids: [secondTurn.turnUuid, firstTurn.turnUuid] })).toMatchObject({ ok: false });
    expect(await savedTurn(firstTurn.turnUuid)).toMatchObject({ status: "pending", wakeTargetConnectionUuid: connectionUuid, wakeRuntimeCwd: directory });
    expect(await savedTurn(secondTurn.turnUuid)).toMatchObject({ status: "pending" });
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "online", lastSeenAt: new Date() } });
    expect((await pendingFor()).find((turn) => turn.turnUuid === firstTurn.turnUuid)).toMatchObject({ runtimeCwd: directory });
    expect(await sessions.getWakeRecoveryDelivery(state.companyUuid, state.agentUuid, connectionUuid, firstTurn.turnUuid)).toMatchObject({ runtimeCwd: directory });
    expect(await sessions.advanceTurnForWake({ ...admission, connectionUuid })).toMatchObject({ ok: true });
    expect(await sessions.advanceTurnForWake({ ...admission, connectionUuid })).toMatchObject({ ok: true });
    expect(await sessions.advanceTurnForWake({ ...admission, connectionUuid, status: "ended" })).toMatchObject({ ok: true });
    expect(await sessions.advanceTurnForWake({ ...admission, turnUuid: secondTurn.turnUuid, turnUuids: [secondTurn.turnUuid], admissionUuid: randomUUID() })).toMatchObject({ ok: true });
  });

  it.each([false, true])("recovers read/out-of-window context after both initial reads fail, later chat=%s", async (laterChat) => {
    const original = await createWake("original comment: recover this exact context");
    const worker = harness({ failReads: true });
    const registration = connectionUuid;
    worker.recovery.register();
    const sparseEvent = { type: "new_notification", notificationUuid: original.notification.uuid, targetConnectionUuid: connectionUuid };
    await Promise.all([worker.recovery.dispatch(sparseEvent), worker.recovery.dispatch(sparseEvent)]);
    worker.control(controls.find((event) => event.turnUuid === original.turn.uuid));
    await vi.waitFor(() => {
      expect(worker.faults.pendingFailures).toBeGreaterThan(0);
      expect(worker.faults.notificationFailures).toBeGreaterThan(0);
    });
    expect(worker.launches).toHaveLength(0);
    expect(worker.seen.has(original.notification.uuid)).toBe(false);
    expect(worker.seen.has(`turn:${original.turn.uuid}`)).toBe(false);
    expect(await savedTurn(original.turn.uuid)).toMatchObject({ status: "pending", startedAt: null });
    await hideNotification(original);
    let chat: Awaited<ReturnType<typeof createWake>> | undefined;
    if (laterChat) {
      chat = await createWake("later chat: a separate exact instruction", "human_instruction");
      const response = await routeFetch(`https://delivery.invalid/api/daemon/pending-turns?connectionUuid=${connectionUuid}&wakeRecoveryProtocol=1`);
      const pending = (await response.json()).data.turns;
      await worker.router.dispatchPendingTurn(pending.find((turn: any) => turn.turnUuid === chat!.turn.uuid));
      await worker.settled();
      expect(await savedTurn(chat.turn.uuid)).toMatchObject({ status: "ended" });
      expect(await savedTurn(original.turn.uuid)).toMatchObject({ status: "pending", startedAt: null });
      expect(worker.launches[0]).toMatchObject({ turnUuid: chat.turn.uuid, prompt: expect.stringContaining(chat.notification.message) });
      expect(worker.launches[0].prompt).not.toContain(original.notification.message);
    }
    worker.faults.reads = false;
    await vi.waitFor(async () => expect(await savedTurn(original.turn.uuid), JSON.stringify(worker.logger.warn.mock.calls)).toMatchObject({ status: "ended" }), { timeout: 5_000 });
    await worker.settled();
    expect(connectionUuid).toBe(registration);
    expect(worker.launches).toHaveLength(laterChat ? 2 : 1);
    expect(worker.launches.at(-1)).toMatchObject({ turnUuid: original.turn.uuid, prompt: expect.stringContaining(original.notification.message) });
    expect(worker.batches.at(-1)![0]).toMatchObject({ uuid: original.notification.uuid, turnUuid: original.turn.uuid, message: original.notification.message });
    expect(await messages(original.turn.uuid)).toMatchObject([{ turnUuid: original.turn.uuid, role: "assistant", text: `reply:${original.turn.uuid}` }]);
    if (chat) {
      expect(await messages(chat.turn.uuid)).toMatchObject([{ turnUuid: chat.turn.uuid, role: "assistant", text: `reply:${chat.turn.uuid}` }]);
      expect(worker.launches.at(-1)!.prompt).not.toContain(chat.notification.message);
    }
    await worker.recovery.dispatch(original.event);
    await worker.recovery.deliver(original.turn.uuid);
    await worker.settled();
    expect(worker.launches).toHaveLength(laterChat ? 2 : 1);
    await expectLegacyUntouched();
  }, 15_000);

  it.each([
    { count: 1, fault: "precommit503" }, { count: 2, fault: "precommit503" },
    { count: 1, fault: "lost-response" }, { count: 2, fault: "lost-response" },
  ] as const)("admits $count exact members once after $fault, including duplicate delivery during wait", async ({ count, fault }) => {
    const wakes: Awaited<ReturnType<typeof createWake>>[] = [];
    for (let index = 0; index < count; index++) wakes.push(await createWake(`exact batch comment ${index}`));
    const worker = harness({ fault, pauseQueue: count > 1 });
    for (const [index, wake] of wakes.entries()) {
      if (index === count - 1) worker.queue.maxConcurrency = 1;
      await worker.backfill.pendingTurnsOnly(wake.turn.uuid);
    }
    const admissions = () => worker.wire.filter((record) => record.body?.status === "running");
    await vi.waitFor(() => expect(admissions()[0]?.status).toBe(fault === "precommit503" ? 503 : 200));
    const initial = await Promise.all(wakes.map((wake) => savedTurn(wake.turn.uuid)));
    expect(initial.map((turn) => turn.status)).toEqual(fault === "precommit503" ? wakes.map(() => "pending") : wakes.map((_wake, index) => index ? "merged" : "running"));
    expect(worker.launches).toHaveLength(0);
    expect(await messages(wakes[0].turn.uuid)).toEqual([]);
    worker.recovery.register();
    for (const wake of wakes) {
      await worker.recovery.dispatch(wake.event);
      await worker.recovery.deliver(wake.turn.uuid);
    }
    expect(worker.launches).toHaveLength(0);
    await vi.waitFor(async () => expect(await savedTurn(wakes[0].turn.uuid)).toMatchObject({ status: "ended" }), { timeout: 5_000 });
    await worker.settled();
    expect(admissions()).toHaveLength(2);
    expect(admissions()[1].body).toEqual(admissions()[0].body);
    const token = admissions()[0].body.admissionUuid;
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(admissions()[0].body).toMatchObject({ turnUuid: wakes[0].turn.uuid, turnUuids: wakes.map((wake) => wake.turn.uuid), wakeRecoveryProtocol: 1 });
    expect(worker.launches).toHaveLength(1);
    expect(worker.batches).toHaveLength(1);
    expect(worker.launches[0].prompt).toContain(wakes.at(-1)!.notification.message);
    expect(worker.batches[0].map((notification) => ({ turnUuid: notification.turnUuid, message: notification.message })))
      .toEqual(wakes.map((wake) => ({ turnUuid: wake.turn.uuid, message: wake.notification.message })));
    const final = await Promise.all(wakes.map((wake) => savedTurn(wake.turn.uuid)));
    expect(final.map((turn) => turn.status)).toEqual(wakes.map((_wake, index) => index ? "merged" : "ended"));
    expect(final[0]).toMatchObject({ admissionUuid: token, admissionTurnUuids: wakes.map((wake) => wake.turn.uuid) });
    for (const [index, turn] of final.entries()) {
      if (fault === "lost-response") expect(turn.startedAt).toEqual(initial[index].startedAt);
      if (index) expect(await messages(turn.uuid)).toEqual([]);
    }
    expect(await messages(wakes[0].turn.uuid)).toMatchObject([{ turnUuid: wakes[0].turn.uuid, text: `reply:${wakes[0].turn.uuid}` }]);
    expect(worker.wire.filter((record) => record.body?.status === "ended")).toMatchObject([{ status: 200, body: { turnUuid: wakes[0].turn.uuid, admissionUuid: token } }]);
    await expectLegacyUntouched();
  }, 15_000);

  it.each(["stop", "revocation"] as const)("does not launch when %s precedes delayed admission confirmation", async (reason) => {
    const wake = await createWake(`delayed admission ${reason}`);
    const worker = harness({ fault: reason === "stop" ? "delayed-response" : "delayed-request" });
    await worker.backfill.pendingTurnsOnly(wake.turn.uuid);
    await vi.waitFor(() => expect(worker.faults.admissionAttempts).toBe(1));
    if (reason === "stop") {
      await vi.waitFor(async () => expect(await savedTurn(wake.turn.uuid)).toMatchObject({ status: "running" }));
      worker.stop();
    } else {
      await db.project.update({ where: { uuid: projectUuid }, data: { visibility: "private" } });
    }
    worker.gate.release();
    await worker.settled();
    await vi.waitFor(async () => expect(await savedTurn(wake.turn.uuid)).toMatchObject(reason === "stop"
      ? { status: "interrupted", interruptedReason: "shutdown" }
      : { status: "pending", startedAt: null, admissionUuid: null }));
    expect(worker.launches).toHaveLength(0);
    expect(await messages(wake.turn.uuid)).toEqual([]);
    const reports = worker.wire.filter((record) => record.body?.admissionUuid);
    expect(new Set(reports.map((record) => record.body.admissionUuid)).size).toBe(1);
    if (reason === "revocation") expect(reports).toMatchObject([{ status: 404 }]);
    await expectLegacyUntouched();
  }, 15_000);
});
