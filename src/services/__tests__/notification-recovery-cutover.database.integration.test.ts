import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../generated/prisma/client";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/generated/prisma/client", async () => import("../../generated/prisma/client"));

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("notification automated-read cutover with isolated database", () => {
  let database: PGlite;
  let socket: PGLiteSocketServer;
  let directory: string;
  let pool: pg.Pool;
  let db: PrismaClient;
  let notifications: typeof import("../notification.service");
  let recovery: typeof import("../notification-wake-recovery");
  let sessions: typeof import("../daemon-session.service");
  let eventBus: typeof import("@/lib/event-bus").eventBus;
  let companyUuid: string;
  let agentUuid: string;
  let projectUuid: string;
  let ideaUuid: string;
  let connectionUuid: string;
  const events: any[] = [];
  const capture = (event: unknown) => { events.push(event); };

  beforeAll(async () => {
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("REDIS_HOST", "");
    database = new PGlite();
    for (const migration of (await readdir("prisma/migrations")).filter((name) => /^\d/.test(name)).sort()) {
      await database.exec(await readFile(join("prisma/migrations", migration, "migration.sql"), "utf8"));
    }
    directory = await mkdtemp(join(tmpdir(), "chorus-notification-cutover-"));
    socket = new PGLiteSocketServer({ db: database, path: join(directory, ".s.PGSQL.5432") });
    await socket.start();
    pool = new pg.Pool({ host: directory, port: 5432, database: "postgres", user: "postgres", max: 1 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    notifications = await import("../notification.service");
    recovery = await import("../notification-wake-recovery");
    sessions = await import("../daemon-session.service");
    ({ eventBus } = await import("@/lib/event-bus"));
  }, 60_000);

  beforeEach(async () => {
    events.length = 0;
    companyUuid = (await db.company.create({ data: { name: "isolated cutover" } })).uuid;
    agentUuid = (await db.agent.create({ data: { companyUuid, name: "legacy reader" } })).uuid;
    projectUuid = (await db.project.create({ data: { companyUuid, name: "public cutover", visibility: "public" } })).uuid;
    ideaUuid = (await db.idea.create({ data: {
      companyUuid, projectUuid, title: "cutover idea", createdByUuid: agentUuid,
      assigneeType: "agent", assigneeUuid: agentUuid,
    } })).uuid;
    connectionUuid = (await db.daemonConnection.create({ data: {
      companyUuid, agentUuid, clientType: "codex", status: "offline", host: "cutover", cwd: directory,
    } })).uuid;
    eventBus.on(`notification:agent:${agentUuid}`, capture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    eventBus?.off(`notification:agent:${agentUuid}`, capture);
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

  function wakeParams(overrides: Partial<import("../notification.service").NotificationCreateParams> = {}) {
    return {
      companyUuid, projectUuid, projectName: "public cutover", recipientType: "agent", recipientUuid: agentUuid,
      entityType: "idea", entityUuid: ideaUuid, entityTitle: "cutover idea", action: "mentioned",
      message: "execute once", actorType: "user", actorUuid: randomUUID(), actorName: "Fixture", ...overrides,
    };
  }

  const automatedList = (overrides: Partial<import("../notification.service").NotificationListParams> = {}) => notifications.list({
    companyUuid, recipientType: "agent", recipientUuid: agentUuid, automated: true, readFilter: "unread", ...overrides,
  });
  const recover = () => recovery.recoverDeferredNotificationWakes({ companyUuid, agentUuid, connectionUuid });
  const online = () => db.daemonConnection.update({ where: { uuid: connectionUuid }, data: { status: "online", lastSeenAt: new Date() } });
  const saved = (uuid: string) => db.notification.findUniqueOrThrow({ where: { uuid } });

  it("withholds offline outbox work before and after materialization without hiding UI or ordinary notifications", async () => {
    const wake = await notifications.createReturningTurn(wakeParams());
    const notice = await notifications.create(wakeParams({ action: "comment_added" }));
    expect(wake.turn).toBeNull();
    expect(await automatedList()).toMatchObject({ total: 1, unreadCount: 1, notifications: [{ uuid: notice.uuid }] });
    expect(await automatedList({ automated: false })).toMatchObject({ total: 2, unreadCount: 2 });
    await online();
    await recover();
    expect(await saved(wake.notification.uuid)).toMatchObject({ wakeRecoveryPending: false, wakeRecovery: { deliveryOwner: "protocol1" } });
    expect(await automatedList()).toMatchObject({ total: 1, unreadCount: 1, notifications: [{ uuid: notice.uuid }] });
    await notifications.markRead(wake.notification.uuid, companyUuid, "agent", agentUuid);
    expect(await automatedList({ readFilter: "all" })).toMatchObject({ total: 1 });
    expect(await automatedList({ readFilter: "read" })).toMatchObject({ total: 0 });
    await recover();
    const turns = await sessions.getPendingTurnsForConnection({ companyUuid, agentUuid, connectionUuid, wakeRecoveryProtocol: 1 });
    expect(turns).toHaveLength(1);
    expect(turns[0].wakeContext?.notificationUuid).toBe(wake.notification.uuid);
    expect(await sessions.getPendingTurnsForConnection({ companyUuid, agentUuid, connectionUuid })).toEqual([]);
    expect(await sessions.canAgentReceiveTurn(companyUuid, agentUuid, turns[0].turnUuid, connectionUuid, true)).toBe(false);
    expect(await sessions.advanceTurnForWake({ companyUuid, agentUuid, connectionUuid, sessionId: ideaUuid, status: "running" })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await sessions.advanceTurnForWake({ companyUuid, agentUuid, connectionUuid, sessionId: ideaUuid, turnUuid: turns[0].turnUuid, status: "running" })).toMatchObject({ ok: false, reason: "not_found" });
    const admission = { companyUuid, agentUuid, connectionUuid, sessionId: ideaUuid, turnUuid: turns[0].turnUuid, turnUuids: [turns[0].turnUuid], admissionUuid: randomUUID(), wakeRecoveryProtocol: 1 as const, status: "running" as const };
    expect(await sessions.advanceTurnForWake(admission)).toMatchObject({ ok: true });
    expect(await sessions.advanceTurnForWake({ ...admission, status: "ended" })).toMatchObject({ ok: true });
    await recover();
    expect(await sessions.getPendingTurnsForConnection({ companyUuid, agentUuid, connectionUuid, wakeRecoveryProtocol: 1 })).toEqual([]);
    expect(await automatedList({ readFilter: "all" })).toMatchObject({ total: 1 });
    expect(await db.daemonSessionTurn.count({ where: { wakeNotificationUuid: wake.notification.uuid } })).toBe(1);
  });

  it("preserves already-materialized online legacy wakes and never recovers historical rows", async () => {
    const historical = await db.notification.create({ data: wakeParams({ message: "historical" }) });
    await online();
    const wake = await notifications.createReturningTurn(wakeParams({ message: "online" }));
    expect(wake.turn).not.toBeNull();
    expect(await saved(wake.notification.uuid)).toMatchObject({ wakeRecoveryPending: false, wakeRecovery: { deliveryOwner: "legacy" } });
    expect(await automatedList()).toMatchObject({ total: 2 });
    await recover();
    expect(await db.daemonSessionTurn.count({ where: { wakeNotificationUuid: historical.uuid } })).toBe(0);
    expect(events.find((event) => event.notificationUuid === wake.notification.uuid)?.wakeRecoveryOnly).toBeUndefined();
  });

  it("keeps batch-created deferred wakes out of automated reads after recovery", async () => {
    const batch = await notifications.createBatch([
      wakeParams({ message: "first deferred" }), wakeParams({ message: "second deferred" }),
    ]);
    expect(batch).toHaveLength(2);
    expect(await automatedList()).toMatchObject({ total: 0, unreadCount: 0 });
    expect(await automatedList({ automated: false })).toMatchObject({ total: 2 });
    await online();
    await recover();
    expect(await automatedList()).toMatchObject({ total: 0, unreadCount: 0 });
    for (const notification of batch) {
      expect(await saved(notification.uuid)).toMatchObject({ wakeRecoveryPending: false, wakeRecovery: { deliveryOwner: "protocol1" } });
      expect(await db.daemonSessionTurn.count({ where: { wakeNotificationUuid: notification.uuid } })).toBe(1);
    }
  });

  it("filters before pagination and preserves read-independent recovery and hard pins", async () => {
    const historical = await db.notification.create({ data: wakeParams({ message: "historical" }) });
    const wake = await notifications.createReturningTurn(wakeParams({ pinnedHost: "cutover", pinnedCwd: directory }));
    expect(await automatedList({ take: 1 })).toMatchObject({ total: 1, notifications: [{ uuid: historical.uuid }] });
    await notifications.markRead(wake.notification.uuid, companyUuid, "agent", agentUuid);
    const otherConnection = await db.daemonConnection.create({ data: {
      companyUuid, agentUuid, clientType: "codex", status: "online", host: "other", cwd: "/other",
    } });
    await recovery.recoverDeferredNotificationWakes({ companyUuid, agentUuid, connectionUuid: otherConnection.uuid });
    expect(await saved(wake.notification.uuid)).toMatchObject({ wakeRecoveryPending: true });
    await online();
    await recover();
    expect(await saved(wake.notification.uuid)).toMatchObject({ wakeRecoveryPending: false });
    expect(await db.daemonSessionTurn.count({ where: { wakeNotificationUuid: wake.notification.uuid } })).toBe(1);
  });

  it("does not expose an automated notification when protocol recovery wins initial settlement", async () => {
    await online();
    const waiting = barrier();
    const resume = barrier();
    const original = db.notification.findUnique.bind(db.notification);
    vi.spyOn(db.notification, "findUnique").mockImplementationOnce((async (args: any) => {
      const snapshot = await original(args);
      waiting.release();
      await resume.promise;
      return snapshot;
    }) as any);
    const creation = notifications.createReturningTurn(wakeParams());
    try {
      await waiting.promise;
      expect(await automatedList()).toMatchObject({ total: 0 });
      await recover();
    } finally {
      resume.release();
    }
    const wake = await creation;
    expect(await saved(wake.notification.uuid)).toMatchObject({ wakeRecoveryPending: false, wakeRecovery: { deliveryOwner: "protocol1" } });
    expect(await automatedList()).toMatchObject({ total: 0 });
    expect(events.find((event) => event.notificationUuid === wake.notification.uuid)?.wakeRecoveryOnly).toBeUndefined();
  });

  it("does not claim a stale outbox snapshot after initial online settlement", async () => {
    await online();
    const waiting = barrier();
    const resume = barrier();
    const initialWaiting = barrier();
    const initialResume = barrier();
    const originalUnique = db.notification.findUnique.bind(db.notification);
    vi.spyOn(db.notification, "findUnique").mockImplementationOnce((async (args: any) => {
      const snapshot = await originalUnique(args);
      initialWaiting.release();
      await initialResume.promise;
      return snapshot;
    }) as any);
    const creation = notifications.createReturningTurn(wakeParams());
    await initialWaiting.promise;
    const originalMany = db.notification.findMany.bind(db.notification);
    vi.spyOn(db.notification, "findMany").mockImplementationOnce((async (args: any) => {
      const snapshot = await originalMany(args);
      waiting.release();
      await resume.promise;
      return snapshot;
    }) as any);
    const recoveryAttempt = recover();
    let wake: Awaited<typeof creation>;
    try {
      await waiting.promise;
      initialResume.release();
      wake = await creation;
    } finally {
      initialResume.release();
      resume.release();
    }
    await recoveryAttempt;
    expect(await saved(wake.notification.uuid)).toMatchObject({ wakeRecoveryPending: false, wakeRecovery: { deliveryOwner: "legacy" } });
    expect(await automatedList()).toMatchObject({ total: 1 });
  });
});
