import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../generated/prisma/client";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/generated/prisma/client", async () => import("../../generated/prisma/client"));

type Handler = (params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

describe("ordinary MCP notification visibility with isolated database", () => {
  let database: PGlite;
  let socket: PGLiteSocketServer;
  let directory: string;
  let pool: pg.Pool;
  let db: PrismaClient;
  let notifications: typeof import("../notification.service");
  let registerPublicTools: typeof import("@/mcp/tools/public").registerPublicTools;
  let companyUuid: string;
  let agentUuid: string;
  let projectUuid: string;
  let ideaUuid: string;
  const handlers: Record<string, Handler> = {};

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
    ({ registerPublicTools } = await import("@/mcp/tools/public"));
  }, 60_000);

  beforeEach(async () => {
    companyUuid = (await db.company.create({ data: { name: "isolated cutover" } })).uuid;
    agentUuid = (await db.agent.create({ data: { companyUuid, name: "ordinary reader" } })).uuid;
    projectUuid = (await db.project.create({ data: { companyUuid, name: "public cutover", visibility: "public" } })).uuid;
    ideaUuid = (await db.idea.create({ data: {
      companyUuid, projectUuid, title: "cutover idea", createdByUuid: agentUuid,
      assigneeType: "agent", assigneeUuid: agentUuid,
    } })).uuid;
    registerPublicTools({ registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers[name] = handler;
    } } as never, {
      type: "agent", companyUuid, actorUuid: agentUuid, ownerUuid: randomUUID(),
      roles: ["admin_agent"], permissions: ["idea:read"], agentName: "ordinary reader",
    });
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

  const mcpList = async (params: Record<string, unknown> = {}) => JSON.parse(
    (await handlers.chorus_get_notifications(params)).content[0].text,
  );
  const saved = (uuid: string) => db.notification.findUniqueOrThrow({ where: { uuid } });

  async function seedNotifications() {
    const historical = await db.notification.create({ data: wakeParams({ message: "historical unread" }) });
    const offline = await notifications.createReturningTurn(wakeParams({ message: "offline unread" }));
    const pinned = await notifications.createReturningTurn(wakeParams({ pinnedHost: "missing", pinnedCwd: "/missing", message: "offline pin read" }));
    const batch = await notifications.createBatch([wakeParams({ message: "batch unread" })]);
    expect(offline.turn).toBeNull();
    expect(pinned.turn).toBeNull();
    await db.daemonConnection.create({ data: {
      companyUuid, agentUuid, clientType: "codex", status: "online", host: "cutover", cwd: directory,
    } });
    const online = await notifications.createReturningTurn(wakeParams({ message: "materialized read" }));
    expect(online.turn).not.toBeNull();
    const ordinary = await notifications.create(wakeParams({ action: "updated", message: "ordinary unread" }));
    const ordered = [ordinary, online.notification, batch[0], offline.notification, pinned.notification, historical];
    for (const [index, notification] of ordered.entries()) {
      await db.notification.update({ where: { uuid: notification.uuid }, data: {
        createdAt: new Date(Date.UTC(2020, 0, 6 - index)),
        readAt: index === 1 || index === 4 ? new Date("2020-02-01") : null,
      } });
    }
    await db.notification.create({ data: wakeParams({ recipientUuid: randomUUID(), message: "another recipient" }) });
    return ordered.map((notification) => notification.uuid);
  }

  it.each([
    { status: "unread", indices: [0, 2, 3, 5] },
    { status: "read", indices: [1, 4] },
    { status: "all", indices: [0, 1, 2, 3, 4, 5] },
  ])("includes ordinary and wake notifications in MCP $status pagination and counts", async ({ status, indices }) => {
    const ordered = await seedNotifications();
    const expected = indices.map((index) => ordered[index]);
    const received: string[] = [];
    for (let offset = 0; offset < expected.length; offset += 2) {
      const page = await mcpList({ status, limit: 2, offset, autoMarkRead: false });
      expect(page).toMatchObject({ total: expected.length, unreadCount: 4 });
      expect(page.notifications.map((notification: { uuid: string }) => notification.uuid)).toEqual(expected.slice(offset, offset + 2));
      received.push(...page.notifications.map((notification: { uuid: string }) => notification.uuid));
    }
    expect(received).toEqual(expected);
    expect(await mcpList({ status, limit: 2, offset: expected.length, autoMarkRead: false })).toMatchObject({
      notifications: [], total: expected.length, unreadCount: 4,
    });
    expect(await db.notification.count({ where: { recipientUuid: agentUuid, readAt: null } })).toBe(4);
  });

  it("auto-marks only the fetched unread MCP page, including offline wakes", async () => {
    const ordered = await seedNotifications();
    const page = await mcpList({ limit: 2, offset: 1 });
    expect(page).toMatchObject({ total: 4, unreadCount: 4 });
    expect(page.notifications.map((notification: { uuid: string }) => notification.uuid)).toEqual([ordered[2], ordered[3]]);
    for (const index of [2, 3]) expect((await saved(ordered[index])).readAt).not.toBeNull();
    for (const index of [0, 5]) expect((await saved(ordered[index])).readAt).toBeNull();
    expect(await mcpList({ autoMarkRead: false })).toMatchObject({ total: 2, unreadCount: 2 });
    expect(await mcpList({ status: "read" })).toMatchObject({ total: 4, unreadCount: 2 });
    expect(await mcpList({ status: "all" })).toMatchObject({ total: 6, unreadCount: 2 });
    expect(await db.notification.count({ where: { recipientUuid: agentUuid, readAt: null } })).toBe(2);
    expect(await db.daemonSessionTurn.count({ where: { session: { agentUuid } } })).toBe(1);
  });
});
