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
vi.mock("@/generated/prisma/client", async () => import("../../generated/prisma/client"));

const state = vi.hoisted(() => ({ db: null as unknown, emit: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emit: state.emit } }));

describe("durable wake recovery against isolated in-memory PostgreSQL", () => {
  let database: PGlite;
  let server: PGLiteSocketServer;
  let directory: string;
  let pool: pg.Pool;
  let db: PrismaClient;
  let service: typeof import("../daemon-session.service");
  let companyUuid: string;
  let agentUuid: string;
  let connectionUuid: string;
  let sessionUuid: string;
  let projectUuid: string;
  let ideaUuid: string;
  let admissionUuid: string;
  let turnUuids: string[];
  let legacyUuid: string;

  beforeAll(async () => {
    database = new PGlite();
    const migrations = (await readdir("prisma/migrations")).filter((name) => /^\d/.test(name)).sort();
    for (const migration of migrations) {
      if (migration === "20261008233000_daemon_wake_recovery") {
        legacyUuid = randomUUID();
        await database.query(`INSERT INTO "DaemonSessionTurn" ("uuid", "sessionUuid", "seq", "trigger") VALUES ($1, 'legacy-session', 1, 'mentioned')`, [legacyUuid]);
      }
      await database.exec(await readFile(join("prisma/migrations", migration, "migration.sql"), "utf8"));
    }
    directory = await mkdtemp(join(tmpdir(), "chorus-wake-test-"));
    server = new PGLiteSocketServer({ db: database, path: join(directory, ".s.PGSQL.5432") });
    await server.start();
    pool = new pg.Pool({ host: directory, port: 5432, database: "postgres", user: "postgres", max: 1 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    service = await import("../daemon-session.service");
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    await pool?.end();
    await server?.stop();
    await database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    state.emit.mockClear();
    companyUuid = (await db.company.create({ data: { name: "isolated wake fixture" } })).uuid;
    agentUuid = (await db.agent.create({ data: { companyUuid, name: "fixture" } })).uuid;
    projectUuid = (await db.project.create({ data: { companyUuid, name: "fixture", visibility: "public" } })).uuid;
    ideaUuid = (await db.idea.create({ data: { companyUuid, projectUuid, title: "fixture", createdByUuid: agentUuid } })).uuid;
    connectionUuid = (await db.daemonConnection.create({ data: { companyUuid, agentUuid, clientType: "codex", status: "online" } })).uuid;
    const session = await service.resolveOrCreateSession({ companyUuid, agentUuid, sessionId: ideaUuid, directIdeaUuid: ideaUuid, originConnectionUuid: connectionUuid });
    sessionUuid = session.uuid;
    turnUuids = [];
    for (let index = 0; index < 4; index++) {
      const notificationUuid = randomUUID();
      const turn = await service.createPendingTurn({ sessionUuid, trigger: index === 2 ? "human_instruction" : "mentioned", promptText: index === 2 ? "later chat" : null, wakeContext: {
        version: 1, notificationUuid, notification: {
          uuid: notificationUuid, action: index === 2 ? "human_instruction" : "mentioned", entityType: "idea", entityUuid: ideaUuid,
          recipientType: "agent", recipientUuid: agentUuid, projectUuid, projectName: "fixture", entityTitle: "fixture",
          actorType: "user", actorUuid: "fixture-user", actorName: "Fixture", message: `message ${index}`,
        },
      } });
      turnUuids.push(turn.uuid);
    }
    admissionUuid = randomUUID();
    state.emit.mockClear();
  });

  const request = (members = [turnUuids[1]]) => ({
    companyUuid, agentUuid, connectionUuid, sessionId: ideaUuid, turnUuid: members[0], turnUuids: members,
    admissionUuid, wakeRecoveryProtocol: 1 as const, status: "running" as const,
  });
  const rows = () => db.daemonSessionTurn.findMany({ where: { sessionUuid }, orderBy: { seq: "asc" } });
  const repointOrigin = async () => {
    const replacement = await db.daemonConnection.create({ data: { companyUuid, agentUuid, clientType: "codex", status: "online" } });
    await db.daemonSession.update({ where: { uuid: sessionUuid }, data: { originConnectionUuid: replacement.uuid } });
    return replacement.uuid;
  };

  it("migrates historical rows to null without guessing source or admission", async () => {
    expect(await db.daemonSessionTurn.findUnique({ where: { uuid: legacyUuid } })).toMatchObject({
      status: "pending", wakeContext: null, admissionUuid: null, admissionTurnUuids: null, admissionConnectionUuid: null,
    });
    const column = await database.query(`SELECT is_nullable, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'DaemonSessionTurn' AND column_name = 'admissionConnectionUuid'`);
    expect(column.rows).toEqual([{ is_nullable: "YES", data_type: "text" }]);
  });

  it.each([
    { count: 1, status: "ended" as const },
    { count: 2, status: "ended" as const },
    { count: 1, status: "interrupted" as const },
    { count: 2, status: "interrupted" as const },
  ])("keeps $count admitted members owned by the original connection through $status after repointing", async ({ count, status }) => {
    const params = request(turnUuids.slice(1, count + 1));
    expect(await service.advanceTurnForWake(params)).toMatchObject({ ok: true, turn: { uuid: params.turnUuid, status: "running" } });
    const admitted = await rows();
    expect(admitted[1]).toMatchObject({ admissionUuid, admissionTurnUuids: params.turnUuids, admissionConnectionUuid: connectionUuid });
    expect(admitted.filter((turn) => turn.uuid !== params.turnUuid).every((turn) => turn.admissionConnectionUuid === null)).toBe(true);
    const replacementConnectionUuid = await repointOrigin();
    const published = state.emit.mock.calls.length;
    expect(await service.advanceTurnForWake(params)).toEqual({ ok: false, reason: "not_found" });
    expect(await service.advanceTurnForWake({ ...params, connectionUuid: replacementConnectionUuid })).toEqual({ ok: false, reason: "not_found" });
    const next = { ...request([turnUuids[3]]), admissionUuid: randomUUID() };
    expect(await service.advanceTurnForWake(next)).toEqual({ ok: false, reason: "not_found" });
    const terminal = {
      ...params, status, turnUuids: status === "interrupted" ? undefined : params.turnUuids,
      interruptedReason: status === "interrupted" ? "shutdown" as const : undefined,
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 7, model: "fixture", source: "codex" as const },
    };
    expect(await service.advanceTurnForWake({ ...terminal, connectionUuid: replacementConnectionUuid })).toEqual({ ok: false, reason: "not_found" });
    expect(await rows()).toEqual(admitted);
    expect(state.emit.mock.calls.length).toBe(published);
    expect(await service.advanceTurnForWake({ ...next, connectionUuid: replacementConnectionUuid })).toMatchObject({ ok: true, turn: { uuid: next.turnUuid, status: "running" } });
    const accepted = await service.advanceTurnForWake(terminal);
    expect(accepted).toMatchObject({ ok: true, turn: { uuid: params.turnUuid, status } });
    const settled = await rows();
    const settledSession = await db.daemonSession.findUniqueOrThrow({ where: { uuid: sessionUuid } });
    const terminalPublished = state.emit.mock.calls.length;
    expect(await service.advanceTurnForWake(terminal)).toEqual(accepted);
    expect(await service.advanceTurnForWake({ ...terminal, turnUuids: params.turnUuids })).toEqual(accepted);
    expect(await service.advanceTurnForWake({ ...terminal, connectionUuid: replacementConnectionUuid })).toEqual({ ok: false, reason: "not_found" });
    expect(await rows()).toEqual(settled);
    expect(await db.daemonSession.findUniqueOrThrow({ where: { uuid: sessionUuid } })).toEqual(settledSession);
    expect(state.emit.mock.calls.length).toBe(terminalPublished);
    expect(settled.map((turn) => turn.status)).toEqual(count === 1 ? ["pending", status, "pending", "running"] : ["pending", status, "merged", "running"]);
    expect(settled[1]).toMatchObject({ admissionConnectionUuid: connectionUuid, admissionUuid, admissionTurnUuids: params.turnUuids });
    expect(settled[3]).toMatchObject({ admissionConnectionUuid: replacementConnectionUuid, admissionUuid: next.admissionUuid });
    expect(settledSession).toMatchObject({ originConnectionUuid: replacementConnectionUuid, totalInputTokens: 10, totalOutputTokens: 20, totalCacheReadTokens: 5, totalCacheCreationTokens: 7 });
    const transcript = await service.appendTranscriptMessages({ companyUuid, agentUuid, turnUuid: params.turnUuid, messages: [{ role: "assistant", text: "original connection output" }] });
    expect(transcript).toMatchObject({ ok: true, appended: 1, stored: 1, messages: [{ turnUuid: params.turnUuid, role: "assistant", text: "original connection output", seq: 1 }] });
    expect(await service.appendTranscriptMessages({ companyUuid, agentUuid, turnUuid: next.turnUuid, messages: [{ role: "assistant", text: "replacement connection output" }] })).toMatchObject({ ok: true, appended: 1 });
    expect(await db.daemonTranscriptMessage.findMany({ where: { turnUuid: { in: turnUuids } }, select: { turnUuid: true, text: true } })).toEqual(expect.arrayContaining([
      { turnUuid: params.turnUuid, text: "original connection output" },
      { turnUuid: next.turnUuid, text: "replacement connection output" },
    ]));
    expect(await db.daemonTranscriptMessage.count({ where: { turnUuid: { in: turnUuids } } })).toBe(2);
  });

  it.each(["ended", "interrupted"] as const)("rejects wrong tokens and changed members for %s after repointing without writes", async (status) => {
    const params = request(turnUuids.slice(1, 3));
    expect(await service.advanceTurnForWake(params)).toMatchObject({ ok: true });
    await repointOrigin();
    const otherSession = await service.resolveOrCreateSession({ companyUuid, agentUuid, sessionId: randomUUID(), directIdeaUuid: ideaUuid, originConnectionUuid: connectionUuid });
    const otherTurn = await service.createPendingTurn({ sessionUuid: otherSession.uuid, trigger: "mentioned" });
    const persisted = await rows();
    const published = state.emit.mock.calls.length;
    const terminal = { ...params, status };
    for (const change of [
      { admissionUuid: randomUUID() },
      { turnUuids: [params.turnUuid] },
      { turnUuids: [...params.turnUuids].reverse() },
      { turnUuids: [params.turnUuid, params.turnUuid] },
      { turnUuids: [params.turnUuid, turnUuids[3]] },
      { turnUuids: [params.turnUuid, randomUUID()] },
      { turnUuids: [params.turnUuid, otherTurn.uuid] },
      { turnUuid: turnUuids[2] },
    ]) {
      expect(await service.advanceTurnForWake({ ...terminal, ...change })).toMatchObject({ ok: false });
      expect(await rows()).toEqual(persisted);
      expect(state.emit.mock.calls.length).toBe(published);
    }
    expect(await db.daemonSessionTurn.findUniqueOrThrow({ where: { uuid: otherTurn.uuid } })).toMatchObject({ status: "pending", admissionUuid: null, admissionConnectionUuid: null });
    expect(await service.advanceTurnForWake(terminal)).toMatchObject({ ok: true, turn: { uuid: params.turnUuid, status } });
  });

  it.each(["ended", "interrupted"] as const)("rechecks real tenant and agent identities for %s and exact transcripts after repointing", async (status) => {
    const params = request(turnUuids.slice(1, 3));
    expect(await service.advanceTurnForWake(params)).toMatchObject({ ok: true });
    await repointOrigin();
    const foreignCompany = await db.company.create({ data: { name: "foreign wake fixture" } });
    const foreignAgent = await db.agent.create({ data: { companyUuid: foreignCompany.uuid, name: "foreign fixture" } });
    const otherAgent = await db.agent.create({ data: { companyUuid, name: "other fixture" } });
    const persisted = await rows();
    const published = state.emit.mock.calls.length;
    for (const identity of [{ companyUuid, agentUuid: otherAgent.uuid }, { companyUuid: foreignCompany.uuid, agentUuid: foreignAgent.uuid }]) {
      const foreignConnection = await db.daemonConnection.create({ data: { ...identity, clientType: "codex", status: "online" } });
      for (const change of [identity, { connectionUuid: foreignConnection.uuid }, { ...identity, connectionUuid: foreignConnection.uuid }]) {
        expect(await service.advanceTurnForWake({ ...params, status, ...change })).toEqual({ ok: false, reason: "not_found" });
      }
      expect(await service.appendTranscriptMessages({ ...identity, turnUuid: params.turnUuid, messages: [{ role: "assistant", text: "foreign output" }] })).toEqual({ ok: false, reason: "not_found" });
    }
    expect(await rows()).toEqual(persisted);
    expect(await db.daemonTranscriptMessage.count({ where: { turnUuid: { in: turnUuids } } })).toBe(0);
    expect(state.emit.mock.calls.length).toBe(published);
    expect(await service.advanceTurnForWake({ ...params, status })).toMatchObject({ ok: true, turn: { uuid: params.turnUuid, status } });
  });

  it.each(["ended", "interrupted"] as const)("rechecks revoked resource access on original-owner %s and its idempotent replay after repointing", async (status) => {
    const params = request(turnUuids.slice(1, 3));
    expect(await service.advanceTurnForWake(params)).toMatchObject({ ok: true });
    await repointOrigin();
    const terminal = { ...params, status, turnUuids: undefined };
    for (const settled of [false, true]) {
      if (settled) expect(await service.advanceTurnForWake(terminal)).toMatchObject({ ok: true, turn: { uuid: params.turnUuid, status } });
      const persisted = await rows();
      const published = state.emit.mock.calls.length;
      await db.project.update({ where: { uuid: projectUuid }, data: { visibility: "private" } });
      expect(await service.advanceTurnForWake(terminal)).toEqual({ ok: false, reason: "not_found" });
      expect(await rows()).toEqual(persisted);
      expect(state.emit.mock.calls.length).toBe(published);
      await db.project.update({ where: { uuid: projectUuid }, data: { visibility: "public" } });
    }
    expect(await service.advanceTurnForWake(terminal)).toMatchObject({ ok: true, turn: { uuid: params.turnUuid, status } });
  });

  it.each([1, 2])("retries a lost successful response idempotently for %i exact members", async (count) => {
    const params = request(turnUuids.slice(1, count + 1));
    const accepted = await service.advanceTurnForWake(params);
    expect(accepted.ok).toBe(true);
    const published = state.emit.mock.calls.length;
    expect(await service.advanceTurnForWake(params)).toEqual(accepted);
    expect(state.emit.mock.calls.length).toBe(published);
    const persisted = await rows();
    expect(persisted.map((turn) => turn.status)).toEqual(count === 1 ? ["pending", "running", "pending", "pending"] : ["pending", "running", "merged", "pending"]);
    expect(persisted[1]).toMatchObject({ admissionUuid, admissionTurnUuids: params.turnUuids });
    expect(await service.advanceTurnForWake({ ...params, admissionUuid: randomUUID() })).toMatchObject({ ok: false, reason: "invalid_transition" });
  });

  it("retains later chat identity rather than consuming the failed old mention", async () => {
    const accepted = await service.advanceTurnForWake(request([turnUuids[2]]));
    expect(accepted).toMatchObject({ ok: true, turn: { uuid: turnUuids[2], trigger: "human_instruction" } });
    expect((await rows()).map((turn) => turn.status)).toEqual(["pending", "pending", "running", "pending"]);
  });

  it.each([1, 2])("rolls back an uncommitted database failure for %i members, then retries with the same token", async (count) => {
    await db.$executeRawUnsafe(`CREATE FUNCTION wake_test_fail_merge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = '${count === 1 ? "running" : "merged"}' THEN RAISE EXCEPTION 'isolated admission fault'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER wake_test_fail_merge BEFORE UPDATE ON "DaemonSessionTurn" FOR EACH ROW EXECUTE FUNCTION wake_test_fail_merge()`);
    const params = request(turnUuids.slice(1, count + 1));
    try {
      await expect(service.advanceTurnForWake(params)).rejects.toThrow();
      expect((await rows()).every((turn) => turn.status === "pending" && turn.admissionUuid === null)).toBe(true);
      expect(state.emit).not.toHaveBeenCalled();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER wake_test_fail_merge ON "DaemonSessionTurn"`);
      await db.$executeRawUnsafe(`DROP FUNCTION wake_test_fail_merge()`);
    }
    expect(await service.advanceTurnForWake(params)).toMatchObject({ ok: true });
  });

  it("rejects duplicate, missing, cross-session, consumed and changed ordered members without partial writes", async () => {
    const otherSession = await service.resolveOrCreateSession({ companyUuid, agentUuid, sessionId: randomUUID(), directIdeaUuid: ideaUuid, originConnectionUuid: connectionUuid });
    const other = await service.createPendingTurn({ sessionUuid: otherSession.uuid, trigger: "mentioned" });
    for (const members of [[turnUuids[1], turnUuids[1]], [turnUuids[1], randomUUID()], [turnUuids[1], other.uuid]]) {
      expect(await service.advanceTurnForWake(request(members))).toMatchObject({ ok: false });
      expect((await rows()).every((turn) => turn.status === "pending")).toBe(true);
    }
    await db.daemonSessionTurn.update({ where: { uuid: turnUuids[2] }, data: { status: "ended" } });
    expect(await service.advanceTurnForWake(request(turnUuids.slice(1, 3)))).toMatchObject({ ok: false });
    expect((await rows())[1].status).toBe("pending");
    const members = [turnUuids[1], turnUuids[3]];
    expect(await service.advanceTurnForWake(request(members))).toMatchObject({ ok: true });
    expect(await service.advanceTurnForWake({ ...request([...members].reverse()), turnUuid: members[0] })).toMatchObject({ ok: false });
    expect(await service.advanceTurnForWake(request([turnUuids[1]]))).toMatchObject({ ok: false });
    expect(await service.advanceTurnForWake({ ...request([other.uuid]), sessionId: otherSession.sessionId })).toMatchObject({ ok: false });
    expect(await db.daemonSessionTurn.findUnique({ where: { uuid: other.uuid } })).toMatchObject({ status: "pending", admissionUuid: null });
  });

  it("rechecks tenant, agent, origin and revoked access on every lost-success retry", async () => {
    const params = request();
    expect(await service.advanceTurnForWake(params)).toMatchObject({ ok: true });
    for (const change of [{ companyUuid: randomUUID() }, { agentUuid: randomUUID() }, { connectionUuid: randomUUID() }]) {
      expect(await service.advanceTurnForWake({ ...params, ...change })).toEqual({ ok: false, reason: "not_found" });
    }
    await db.project.update({ where: { uuid: projectUuid }, data: { visibility: "private" } });
    expect(await service.advanceTurnForWake(params)).toEqual({ ok: false, reason: "not_found" });
    expect(await service.getPendingTurnsForConnection({ ...params, wakeRecoveryProtocol: 1 })).toEqual([]);
    expect(await service.getWakeRecoveryDelivery(companyUuid, agentUuid, connectionUuid, turnUuids[0])).toBeNull();
  });

  it("recovers exact context without an unread notification, hiding old/unknown contexts safely", async () => {
    const params = request();
    const pending = await service.getPendingTurnsForConnection(params);
    expect(pending[0].wakeContext).toMatchObject({ version: 1, notification: { message: "message 0", entityUuid: ideaUuid } });
    expect(pending[0].wakeContext?.notificationUuid).toBe(pending[0].wakeContext?.notification.uuid);
    expect(await db.notification.count({ where: { companyUuid } })).toBe(0);
    const notification = pending[0].wakeContext!.notification;
    await db.notification.create({ data: { ...notification, companyUuid, readAt: new Date() } });
    await db.notification.createMany({ data: Array.from({ length: 51 }, () => ({ ...notification, companyUuid, uuid: randomUUID(), message: "newer notification" })) });
    expect((await service.getPendingTurnsForConnection(params))[0].wakeContext).toEqual(pending[0].wakeContext);
    expect(await service.getWakeRecoveryDelivery(companyUuid, agentUuid, randomUUID(), turnUuids[0])).toBeNull();
    const legacy = await service.getPendingTurnsForConnection({ companyUuid, agentUuid, connectionUuid });
    expect(legacy[0]).not.toHaveProperty("wakeContext");
    await db.daemonSessionTurn.update({ where: { uuid: turnUuids[0] }, data: { wakeContext: { version: 99 } } });
    const old = await service.createPendingTurn({ sessionUuid, trigger: "mentioned" });
    const next = await service.getPendingTurnsForConnection(params);
    expect(next.some((turn) => turn.turnUuid === turnUuids[0])).toBe(false);
    expect(next.find((turn) => turn.turnUuid === old.uuid)?.wakeContext).toBeNull();
  });

  it("settles an uncertain admitted stop using the same token and never readmits a terminal turn", async () => {
    const params = request(turnUuids.slice(1, 3));
    expect(await service.advanceTurnForWake(params)).toMatchObject({ ok: true });
    const terminal = { ...params, turnUuids: undefined, status: "interrupted" as const, interruptedReason: "shutdown" };
    const first = await service.advanceTurnForWake(terminal);
    expect(first).toMatchObject({ ok: true, turn: { uuid: turnUuids[1], status: "interrupted" } });
    const published = state.emit.mock.calls.length;
    expect(await service.advanceTurnForWake(terminal)).toEqual(first);
    expect(state.emit.mock.calls.length).toBe(published);
    expect(await service.advanceTurnForWake(params)).toMatchObject({ ok: false, reason: "invalid_transition" });
  });

  it("does not fabricate execution or consume pending turns on never-committed cancellation", async () => {
    const params = request(turnUuids.slice(1, 3));
    expect(await service.advanceTurnForWake({ ...params, status: "interrupted", interruptedReason: "shutdown" })).toMatchObject({ ok: false, reason: "invalid_transition" });
    expect((await rows()).every((turn) => turn.status === "pending" && turn.startedAt === null && turn.admissionUuid === null)).toBe(true);
    expect(await service.getPendingTurnsForConnection(params)).toHaveLength(4);
    expect(state.emit).not.toHaveBeenCalled();
  });

  it("accepts a legitimate exact batch above 100 members without a new coalescing cap", async () => {
    const members = Array.from({ length: 101 }, () => randomUUID());
    await db.daemonSessionTurn.createMany({ data: members.map((uuid, index) => ({ uuid, sessionUuid, seq: index + 5, trigger: "mentioned" })) });
    expect(await service.advanceTurnForWake(request(members))).toMatchObject({ ok: true, turn: { uuid: members[0] } });
    expect(await db.daemonSessionTurn.count({ where: { sessionUuid, status: "merged" } })).toBe(100);
  }, 15_000);

  it("binds the backend returned after execution and rolls terminal usage up only once", async () => {
    const params = request();
    await service.advanceTurnForWake(params);
    const terminal = { ...params, status: "ended" as const, backendSessionId: "backend-thread", usage: {
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 7, model: "fixture", source: "codex",
    } };
    const accepted = await service.advanceTurnForWake(terminal);
    expect(accepted).toMatchObject({ ok: true, turn: { backendSessionId: "backend-thread", status: "ended" } });
    expect(await service.advanceTurnForWake(terminal)).toEqual(accepted);
    expect(await db.daemonSession.findUnique({ where: { uuid: sessionUuid } })).toMatchObject({
      backendSessionId: "backend-thread", totalInputTokens: 10, totalOutputTokens: 20, totalCacheReadTokens: 5, totalCacheCreationTokens: 7,
    });
    expect(await service.advanceTurnForWake({ ...terminal, backendSessionId: "different" })).toMatchObject({ ok: false, reason: "backend_session_conflict" });
  });

  it("serializes concurrent identical admission requests to one durable result", async () => {
    const params = request(turnUuids.slice(1, 3));
    const results = await Promise.all([service.advanceTurnForWake(params), service.advanceTurnForWake(params)]);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toEqual(results[0]);
    expect(state.emit.mock.calls.filter(([name]) => name === "session_activity")).toHaveLength(1);
  });
});
