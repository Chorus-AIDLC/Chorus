import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

const legacyCliDirectory = process.env.CHORUS_TEST_LEGACY_CLI_DIR;
const currentCli = {
  EventRouter, WakeQueue, Waker, LineageResolver, validateDirectory,
  createDaemonRestClient, createTurnReporter, createTranscriptUploadHooks, WAKE_ACTIONS,
};

const state = vi.hoisted(() => ({ db: null as unknown, companyUuid: "", agentUuid: "" }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/auth", async (original) => ({
  ...await original<typeof import("@/lib/auth")>(),
  getAuthContext: async () => ({
    type: "agent", companyUuid: state.companyUuid, actorUuid: state.agentUuid, permissions: ["idea:read", "task:read"],
  }),
}));

type AdmissionFault = "none" | "precommit503" | "lost-response" | "delayed-request" | "delayed-response";
type WireRequest = { path: string; search: string; body: any; status?: number };

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
  let registerPublicTools: typeof import("@/mcp/tools/public").registerPublicTools;
  let pendingRoute: typeof import("../../app/api/daemon/pending-turns/route");
  let advanceRoute: typeof import("../../app/api/daemon/turn-advance/route");
  let transcriptRoute: typeof import("../../app/api/daemon/transcript/route");
  let lineageRoute: typeof import("../../app/api/entities/[type]/[uuid]/root-idea/route");
  let eventBus: typeof import("@/lib/event-bus").eventBus;
  let legacyCli: typeof currentCli;
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
    if (legacyCliDirectory) {
      const [routing, queue, waking, lineage, discovery, rest, reporter, uploads, prompts] = await Promise.all([
        "event-router.mjs", "wake-queue.mjs", "waker.mjs", "lineage.mjs", "directory-discovery.mjs",
        "daemon-rest-client.mjs", "turn-reporter.mjs", "upload-hooks.mjs", "prompts.mjs",
      ].map((filename) => import(pathToFileURL(resolve(legacyCliDirectory, filename)).href)));
      legacyCli = {
        EventRouter: routing.EventRouter, WakeQueue: queue.WakeQueue, Waker: waking.Waker,
        LineageResolver: lineage.LineageResolver, validateDirectory: discovery.validateDirectory,
        createDaemonRestClient: rest.createDaemonRestClient, createTurnReporter: reporter.createTurnReporter,
        createTranscriptUploadHooks: uploads.createTranscriptUploadHooks, WAKE_ACTIONS: prompts.WAKE_ACTIONS,
      };
      expect(legacyCli.EventRouter).not.toBe(currentCli.EventRouter);
      expect(legacyCli.Waker).not.toBe(currentCli.Waker);
      expect(legacyCli.createTurnReporter).not.toBe(currentCli.createTurnReporter);
      expect(legacyCli.createTranscriptUploadHooks).not.toBe(currentCli.createTranscriptUploadHooks);
    }
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
    ({ registerPublicTools } = await import("@/mcp/tools/public"));
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
    const lineage = address.pathname.match(/^\/api\/entities\/(idea|task)\/([^/]+)\/root-idea$/);
    if (lineage) {
      return lineageRoute.GET(request, { params: Promise.resolve({ type: lineage[1], uuid: lineage[2] }) });
    }
    throw new Error(`Unexpected isolated request ${address.pathname}`);
  }

  function harness(options: { fault?: AdmissionFault; pauseQueue?: boolean; failReads?: boolean; legacyTurnUuid?: string; cli?: typeof currentCli } = {}) {
    const cli = options.cli ?? currentCli;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const wire: WireRequest[] = [];
    const mcpCalls: { name: string; args: any }[] = [];
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
        const record: WireRequest = { path, search: new URL(String(input)).search, body };
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
    const rest = cli.createDaemonRestClient(clientOptions);
    const handlers: Record<string, (params: any) => Promise<{ content: Array<{ text: string }> }>> = {};
    registerPublicTools({ registerTool: (name: string, _config: unknown, handler: typeof handlers[string]) => {
      handlers[name] = handler;
    } } as never, {
      type: "agent", companyUuid: state.companyUuid, actorUuid: state.agentUuid, ownerUuid: randomUUID(),
      roles: ["admin_agent"], permissions: ["idea:read", "task:read"], agentName: "fake subprocess",
    });
    const mcpClient = { callTool: async (name: string, args: any) => {
      mcpCalls.push({ name, args });
      if (name !== "chorus_get_notifications") throw new Error(`Unexpected MCP adaptation ${name}`);
      if (faults.reads) {
        faults.notificationFailures++;
        throw new TypeError("isolated notification read ECONNRESET");
      }
      expect(args.autoMarkRead).toBe(false);
      return JSON.parse((await handlers[name](args)).content[0].text);
    } };
    const seen = new Set<string>();
    let router: EventRouter;
    const waker = new cli.Waker({
      creds: clientOptions, cwd: directory, logger, lineage: new cli.LineageResolver(clientOptions),
      validateRuntimeCwd: (cwd: string) => cli.validateDirectory({ cwd, browseRoots: [directory] }),
      advanceTurn: cli.createTurnReporter(clientOptions),
      hooks: cli.createTranscriptUploadHooks({ ...clientOptions, batchDelayMs: 60_000 }),
      onAdmissionCancelled: (turnUuids: string[]) => router.releaseAccepted(turnUuids),
      spawner: { wake: async (params: any) => {
        const turnUuid = batches.at(-1)![0].turnUuid ?? options.legacyTurnUuid;
        launches.push({ prompt: params.prompt, turnUuid });
        if (options.legacyTurnUuid) params.onChild({ pid: 0 });
        try {
          if (options.legacyTurnUuid) {
            await vi.waitFor(async () => expect(await savedTurn(turnUuid)).toMatchObject({ status: "running", admissionUuid: null }));
          } else {
            expect(await savedTurn(turnUuid)).toMatchObject({ status: "running", admissionUuid: expect.any(String) });
          }
          expect(JSON.parse(await readFile(params.mcpConfigPath, "utf8")).mcpServers.chorus.url).toBe("https://delivery.invalid/api/mcp");
        } catch (error) { errors.push(error); }
        if (!options.legacyTurnUuid) params.onChild({ pid: 0 });
        params.onMessage({ type: "assistant", message: { role: "assistant", content: `reply:${turnUuid}` } });
        return { sessionId: params.sessionId, backendSessionId: `isolated-${params.sessionId}`, exitCode: 0, isNew: true };
      } },
    } as any);
    const queue = new cli.WakeQueue({ logger, maxConcurrency: options.pauseQueue ? 0 : 1, runBatch: async (key: string, items: any[]) => {
      batches.push(items.map((item) => item.notification));
      try { await waker.wakeBatch(items.map((item) => item.notification), key, items[0].attribution); }
      catch (error) { errors.push(error); }
    } });
    router = new cli.EventRouter({ queue, waker, mcpClient, seen, wakeActions: cli.WAKE_ACTIONS, logger, getConnectionUuid: clientOptions.getConnectionUuid } as any);
    const backfill = createBackfill({ ...clientOptions, mcpClient, seen,
      dispatch: (event: any) => router.dispatch(event),
      dispatchPendingTurn: (turn: any, dispatchOptions: any) => router.dispatchPendingTurn(turn, dispatchOptions),
    } as any) as unknown as (() => Promise<void>) & { pendingTurnsOnly: (turnUuid?: string) => Promise<unknown> };
    const recovery = createDeliveryRecovery({ router, backfill, getConnectionUuid: clientOptions.getConnectionUuid, logger, intervalMs: 75 });
    const control = createControlHandler({ waker, getConnectionUuid: clientOptions.getConnectionUuid, logger,
      deliverTurn: (turnUuid: string) => recovery.deliver(turnUuid),
    } as any);
    const stop = () => { recovery.stop(); queue.stop(); waker.stop?.(); };
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
    return { faults, wire, mcpCalls, launches, batches, logger, rest, router, backfill, recovery, control, seen, queue, stop, gate, settled };
  }

  async function expectLegacyUntouched() {
    expect(await savedTurn(legacyUuid)).toMatchObject({ status: "pending", startedAt: null, endedAt: null, admissionUuid: null, wakeContext: null });
    expect(await messages(legacyUuid)).toEqual([]);
  }

  function wakeParams(overrides: Partial<Parameters<typeof notifications.createReturningTurn>[0]> = {}) {
    return {
      companyUuid: state.companyUuid, projectUuid, projectName: "delivery project",
      recipientType: "agent", recipientUuid: state.agentUuid, entityType: "idea", entityUuid: ideaUuid,
      entityTitle: "delivery idea", action: "mentioned", message: "offline comment", actorType: "user",
      actorUuid: randomUUID(), actorName: "Fixture human", ...overrides,
    };
  }

  async function pendingFor(target = connectionUuid) {
    const response = await routeFetch(`https://delivery.invalid/api/daemon/pending-turns?connectionUuid=${target}&operationProtocol=1&wakeRecoveryProtocol=1`);
    expect(response.status).toBe(200);
    return (await response.json()).data.turns as any[];
  }

  it.each([
    { selection: "none", read: false }, { selection: "none", read: true },
    { selection: "offline_pin", read: false }, { selection: "offline_pin", read: true },
  ])("never materializes long-aged $selection notifications on pending GET, read=$read", async ({ selection, read }) => {
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "offline" } });
    const other = selection === "offline_pin" ? await db.daemonConnection.create({ data: {
      companyUuid: state.companyUuid, agentUuid: state.agentUuid, clientType: "codex", status: "online", host: "other-host", cwd: "/other",
    } }) : null;
    const before = await db.daemonSessionTurn.count({ where: { session: { agentUuid: state.agentUuid } } });
    const wake = await notifications.createReturningTurn(wakeParams(selection === "offline_pin"
      ? { pinnedHost: "isolated-delivery", pinnedCwd: directory } : {}));
    expect(wake.turn).toBeNull();
    const historical = await db.notification.create({ data: wakeParams({ message: "historical notice" }) });
    const notificationUuids = [wake.notification.uuid, historical.uuid];
    const readAt = read ? new Date("2020-02-01") : null;
    await db.notification.updateMany({ where: { uuid: { in: notificationUuids } }, data: { createdAt: new Date("2020-01-01"), readAt } });
    expect(await db.daemonSessionTurn.count({ where: { wakeNotificationUuid: { in: notificationUuids } } })).toBe(0);
    if (other) expect(await pendingFor(other.uuid)).toEqual([]);
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "online", lastSeenAt: new Date() } });
    for (const pending of await Promise.all([pendingFor(), pendingFor()])) {
      expect(pending.map((turn) => turn.turnUuid)).toEqual([legacyUuid]);
    }
    if (other) expect(await pendingFor(other.uuid)).toEqual([]);
    expect(await db.daemonSessionTurn.count({ where: { wakeNotificationUuid: { in: notificationUuids } } })).toBe(0);
    expect(await db.daemonSessionTurn.count({ where: { session: { agentUuid: state.agentUuid } } })).toBe(before);
    for (const uuid of notificationUuids) expect(await db.notification.findUniqueOrThrow({ where: { uuid } })).toMatchObject({ readAt });
    await expectLegacyUntouched();
  });

  it.each([false, true])("does not create a turn when an agent's first-ever daemon comes online, read=%s", async (read) => {
    const recipientUuid = (await db.agent.create({ data: { companyUuid: state.companyUuid, name: "never registered" } })).uuid;
    const idea = await db.idea.create({ data: {
      companyUuid: state.companyUuid, projectUuid, title: "before first daemon", createdByUuid: recipientUuid,
      assigneeType: "agent", assigneeUuid: recipientUuid,
    } });
    expect(await db.daemonConnection.count({ where: { agentUuid: recipientUuid } })).toBe(0);
    const wake = await notifications.createReturningTurn(wakeParams({ recipientUuid, entityUuid: idea.uuid }));
    expect(wake.turn).toBeNull();
    const readAt = read ? new Date("2020-02-01") : null;
    await db.notification.update({ where: { uuid: wake.notification.uuid }, data: { createdAt: new Date("2020-01-01"), readAt } });
    expect(await db.daemonSessionTurn.count({ where: { session: { agentUuid: recipientUuid } } })).toBe(0);
    const first = await db.daemonConnection.create({ data: {
      companyUuid: state.companyUuid, agentUuid: recipientUuid, clientType: "codex", status: "online", host: "first-ever", cwd: directory,
    } });
    const originalAgentUuid = state.agentUuid;
    try {
      state.agentUuid = recipientUuid;
      expect(await pendingFor(first.uuid)).toEqual([]);
      expect(await pendingFor(first.uuid)).toEqual([]);
    } finally {
      state.agentUuid = originalAgentUuid;
    }
    expect(await db.daemonSessionTurn.count({ where: { session: { agentUuid: recipientUuid } } })).toBe(0);
    expect(await db.daemonSessionTurn.count({ where: { wakeNotificationUuid: wake.notification.uuid } })).toBe(0);
    expect(await db.notification.findUniqueOrThrow({ where: { uuid: wake.notification.uuid } })).toMatchObject({ readAt });
    await expectLegacyUntouched();
  });

  it("withholds existing pending turns after project access revocation and recovers after regrant", async () => {
    const wake = await createWake("recover only with project access");
    await db.project.update({ where: { uuid: projectUuid }, data: { visibility: "private" } });
    expect(await pendingFor()).toEqual([]);
    expect(await savedTurn(wake.turn.uuid)).toMatchObject({ status: "pending" });
    await db.project.update({ where: { uuid: projectUuid }, data: { visibility: "public" } });
    expect(await pendingFor()).toEqual(expect.arrayContaining([expect.objectContaining({ turnUuid: wake.turn.uuid })]));
  });

  it("retains proposal ambiguity suppression without creating a turn on pending GET", async () => {
    const standalone = await db.idea.create({ data: { companyUuid: state.companyUuid, projectUuid, title: "no canonical session", createdByUuid: state.agentUuid } });
    const other = await db.daemonConnection.create({ data: { companyUuid: state.companyUuid, agentUuid: state.agentUuid, clientType: "codex", status: "online", host: "second-host", cwd: "/second" } });
    const wake = await notifications.createReturningTurn(wakeParams({ action: "proposal_approved", entityUuid: standalone.uuid }));
    expect(wake.turn).toBeNull();
    await Promise.all([pendingFor(), pendingFor(other.uuid)]);
    expect(await db.daemonSessionTurn.findUnique({ where: { wakeNotificationUuid: wake.notification.uuid } })).toBeNull();
  });

  async function verifyLegacyUpgrade(cli: typeof currentCli) {
    const task = await db.task.create({ data: { companyUuid: state.companyUuid, projectUuid, title: "legacy task", createdByUuid: state.agentUuid } });
    const wake = await notifications.createReturningTurn(wakeParams({ entityType: "task", entityUuid: task.uuid, pinnedHost: "isolated-delivery", pinnedCwd: directory, message: "legacy execution once" }));
    expect(wake.turn).not.toBeNull();
    const worker = harness({ legacyTurnUuid: wake.turn!.uuid, cli });
    const dispatch = worker.router.dispatch({ type: "new_notification", notificationUuid: wake.notification.uuid });
    if (cli === currentCli) {
      expect(await dispatch, JSON.stringify(worker.logger.warn.mock.calls)).toMatchObject({ status: "accepted" });
    } else {
      expect(dispatch).toBeUndefined();
    }
    await vi.waitFor(() => expect(worker.launches, JSON.stringify(worker.logger.error.mock.calls)).toHaveLength(1));
    await worker.settled();
    expect(worker.launches, JSON.stringify(worker.logger.warn.mock.calls)).toEqual([{ turnUuid: wake.turn!.uuid, prompt: expect.stringContaining("legacy execution once") }]);
    await vi.waitFor(async () => expect(await savedTurn(wake.turn!.uuid)).toMatchObject({ status: "ended", admissionUuid: null, wakeNotificationUuid: wake.notification.uuid }));
    expect(await db.notification.findUniqueOrThrow({ where: { uuid: wake.notification.uuid } })).toMatchObject({ readAt: null });
    expect(await messages(wake.turn!.uuid)).toMatchObject([{ text: `reply:${wake.turn!.uuid}` }]);
    const running = worker.wire.find((record) => record.body?.status === "running");
    expect(running).toMatchObject({ status: 200 });
    expect(running!.body.wakeRecoveryProtocol).toBeUndefined();
    expect(running!.body.admissionUuid).toBeUndefined();
    expect(worker.mcpCalls).toEqual([{ name: "chorus_get_notifications", args: { status: cli === currentCli ? "all" : "unread", limit: 50, autoMarkRead: false } }]);
    worker.stop();
    const protocolWorker = harness();
    protocolWorker.recovery.register();
    await protocolWorker.recovery.deliver(wake.turn!.uuid);
    await vi.waitFor(() => expect(protocolWorker.wire.filter((record) => record.path === "/api/daemon/pending-turns" && record.status === 200).length).toBeGreaterThan(0));
    await protocolWorker.settled();
    expect(protocolWorker.launches).toEqual([]);
    expect(protocolWorker.mcpCalls).toEqual([]);
    for (const request of protocolWorker.wire.filter((record) => record.path === "/api/daemon/pending-turns")) {
      expect(new URLSearchParams(request.search).get("wakeRecoveryProtocol")).toBe("1");
      expect(new URLSearchParams(request.search).get("operationProtocol")).toBe("1");
    }
    expect((await pendingFor()).some((turn) => turn.turnUuid === wake.turn!.uuid)).toBe(false);
    expect(await db.daemonSessionTurn.count({ where: { wakeNotificationUuid: wake.notification.uuid } })).toBe(1);
    await expectLegacyUntouched();
  }

  it("executes an online-created turn using CURRENT CLI legacy-wire mode without protocol-1 replay", async () => {
    await verifyLegacyUpgrade(currentCli);
  });

  it.skipIf(!legacyCliDirectory)("executes an online-created turn using EXTERNAL OLD CLI source and real MCP without upgraded protocol-1 replay", async () => {
    await verifyLegacyUpgrade(legacyCli);
  });

  it("enforces one durable turn per wake notification in the database", async () => {
    const wake = await createWake("unique notification identity");
    await expect(database.query(
      'INSERT INTO "DaemonSessionTurn" ("uuid", "sessionUuid", "seq", "trigger", "wakeNotificationUuid") VALUES ($1, $2, $3, $4, $5)',
      [randomUUID(), sessionUuid, wake.turn.seq + 1, "mentioned", wake.notification.uuid],
    )).rejects.toMatchObject({ code: "23505", constraint: "DaemonSessionTurn_wakeNotificationUuid_key" });
    expect(await db.daemonSessionTurn.count({ where: { wakeNotificationUuid: wake.notification.uuid } })).toBe(1);
    expect(await savedTurn(wake.turn.uuid)).toMatchObject({ status: "pending" });
  });

  it("does not materialize batch-created offline mentions after archival and reconnect", async () => {
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "offline" } });
    const batch = await notifications.createBatch([
      wakeParams({ pinnedHost: "isolated-delivery", pinnedCwd: directory, message: "batch one" }),
      wakeParams({ pinnedHost: "isolated-delivery", pinnedCwd: directory, message: "batch two" }),
    ]);
    const notificationUuids = batch.map((notification) => notification.uuid);
    await db.notification.updateMany({ where: { uuid: { in: notificationUuids } }, data: {
      createdAt: new Date("2020-01-01"), archivedAt: new Date("2020-02-01"), readAt: new Date("2020-02-01"),
    } });
    await db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "online", lastSeenAt: new Date() } });
    expect((await pendingFor()).map((turn) => turn.turnUuid)).toEqual([legacyUuid]);
    expect(await db.daemonSessionTurn.count({ where: { wakeNotificationUuid: { in: notificationUuids } } })).toBe(0);
    await expectLegacyUntouched();
  });

  it("repoints standalone task sessions while preserving immutable admission ownership", async () => {
    const task = await db.task.create({ data: { companyUuid: state.companyUuid, projectUuid, title: "quick task", createdByUuid: state.agentUuid } });
    const params = wakeParams({ entityType: "task", entityUuid: task.uuid, pinnedHost: "isolated-delivery", pinnedCwd: directory });
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
    const second = await db.daemonConnection.create({ data: { companyUuid: state.companyUuid, agentUuid: state.agentUuid, clientType: "codex", status: "online", host: "pinned-second", cwd: "/second" } });
    const firstWake = await notifications.createReturningTurn(wakeParams({ entityType, entityUuid, pinnedHost: "isolated-delivery", pinnedCwd: directory, message: "only execute on A" }));
    expect(firstWake.turn).not.toBeNull();
    const secondWake = await notifications.createReturningTurn(wakeParams({ entityType, entityUuid, pinnedHost: "pinned-second", pinnedCwd: "/second", message: "only execute on B" }));
    expect(secondWake.turn).not.toBeNull();
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
