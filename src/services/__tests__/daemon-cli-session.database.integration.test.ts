// cli-agent-session-sync — end-to-end server flow on a real (PGlite) database: register →
// live transcript → queued send → daemon reconnect leaves the CLI turn alone → release drains;
// expired-lease sweep idempotency; lazy origin binding.
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

const state = vi.hoisted(() => ({ db: null as unknown, companyUuid: "", agentUuid: "" }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/auth", async (original) => ({
  ...await original<typeof import("@/lib/auth")>(),
  getAuthContext: async () => ({ type: "agent", companyUuid: state.companyUuid, actorUuid: state.agentUuid, permissions: [] }),
}));

describe("CLI session sync on a real database", () => {
  let database: PGlite;
  let socket: PGLiteSocketServer;
  let directory: string;
  let pool: pg.Pool;
  let db: PrismaClient;
  let sessions: typeof import("../daemon-session.service");
  let instructions: typeof import("../daemon-instruction.service");
  let cli: typeof import("../daemon-cli-session.service");
  let registerRoute: typeof import("../../app/api/daemon-sessions/cli/route");
  let heartbeatRoute: typeof import("../../app/api/daemon-sessions/cli/[sessionUuid]/heartbeat/route");
  let releaseRoute: typeof import("../../app/api/daemon-sessions/cli/[sessionUuid]/release/route");
  let transcriptRoute: typeof import("../../app/api/daemon/transcript/route");
  let eventBus: typeof import("@/lib/event-bus").eventBus;
  let connectionUuid: string;
  const controls: Array<{ command: string; turnUuid?: string; runtimeCwd?: string }> = [];
  const capture = (event: { command: string; turnUuid?: string }) => { controls.push(event); };
  const auth = () => ({ type: "agent", companyUuid: state.companyUuid, actorUuid: state.agentUuid });

  beforeAll(async () => {
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("REDIS_HOST", "");
    database = new PGlite();
    for (const migration of (await readdir("prisma/migrations")).filter((name) => /^\d/.test(name)).sort()) {
      await database.exec(await readFile(join("prisma/migrations", migration, "migration.sql"), "utf8"));
    }
    directory = await mkdtemp(join(tmpdir(), "chorus-cli-sync-test-"));
    socket = new PGLiteSocketServer({ db: database, path: join(directory, ".s.PGSQL.5432") });
    await socket.start();
    pool = new pg.Pool({ host: directory, port: 5432, database: "postgres", user: "postgres", max: 1 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    sessions = await import("../daemon-session.service");
    instructions = await import("../daemon-instruction.service");
    cli = await import("../daemon-cli-session.service");
    registerRoute = await import("../../app/api/daemon-sessions/cli/route");
    heartbeatRoute = await import("../../app/api/daemon-sessions/cli/[sessionUuid]/heartbeat/route");
    releaseRoute = await import("../../app/api/daemon-sessions/cli/[sessionUuid]/release/route");
    transcriptRoute = await import("../../app/api/daemon/transcript/route");
    ({ eventBus } = await import("@/lib/event-bus"));
  }, 60_000);

  beforeEach(async () => {
    controls.length = 0;
    state.companyUuid = (await db.company.create({ data: { name: "cli sync" } })).uuid;
    state.agentUuid = (await db.agent.create({ data: { companyUuid: state.companyUuid, name: "terminal agent" } })).uuid;
    connectionUuid = (await db.daemonConnection.create({ data: {
      companyUuid: state.companyUuid, agentUuid: state.agentUuid, clientType: "claude_code", status: "online",
      host: "box", cwd: "/repo", lastSeenAt: new Date(),
    } })).uuid;
    eventBus.on(`control:${connectionUuid}`, capture);
  });

  afterEach(() => { eventBus?.off(`control:${connectionUuid}`, capture); });

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

  const post = (body: unknown) => new NextRequest("https://cli.invalid/api", { method: "POST", body: JSON.stringify(body) });
  const ctx = (sessionUuid: string) => ({ params: Promise.resolve({ sessionUuid }) });
  async function register(body: Record<string, unknown> = {}) {
    const res = await registerRoute.POST(post({ agentType: "claude_code", host: "box", cwd: "/repo", ...body }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    return (await res.json()).data as Awaited<ReturnType<typeof cli.registerCliSession>>;
  }
  const deliveries = () => controls.filter((c) => c.command === "deliver_turn").map((c) => c.turnUuid);

  it("register → transcript → queued send → daemon reconnect → release drains once", async () => {
    const reg = await register();
    expect(reg).toMatchObject({ originBound: true, continuable: true, leaseTtlSec: 60, heartbeatIntervalSec: 15 });

    // Live transcript lands on the CLI turn through the existing ingest.
    const tx = await transcriptRoute.POST(post({ turnUuid: reg.turnUuid, messages: [
      { role: "user", text: "hello from the terminal" }, { role: "assistant", text: "hi" },
    ] }), { params: Promise.resolve({}) });
    expect(tx.status).toBe(200);

    // A Chorus send while the terminal holds the lease is queued — pending, no wake.
    const sent = await instructions.sendInstruction(auth(), { sessionUuid: reg.sessionUuid, instructionText: "continue please" });
    expect(sent.queued).toBe(true);
    expect(sent.turn.status).toBe("pending");
    expect(deliveries()).toEqual([]);
    expect(await sessions.getPendingTurnsForConnection({ companyUuid: state.companyUuid, agentUuid: state.agentUuid, connectionUuid })).toEqual([]);

    // Daemon restart (new-generation force reconcile) leaves the CLI turn running.
    expect(await sessions.reconcileOrphanTurns(state.companyUuid, connectionUuid, { force: true })).toBe(0);
    expect((await db.daemonSessionTurn.findUniqueOrThrow({ where: { uuid: reg.turnUuid } })).status).toBe("running");
    // The daemon cannot admit the queued turn while leased.
    const admit = await sessions.advanceTurnForWake({
      companyUuid: state.companyUuid, agentUuid: state.agentUuid, connectionUuid, sessionId: reg.sessionId, status: "running",
    });
    expect(admit).toMatchObject({ ok: false, from: "cli_leased" });
    expect((await db.daemonSessionTurn.findUniqueOrThrow({ where: { uuid: sent.turn.uuid } })).status).toBe("pending");

    // Session read payload while leased.
    const detail = await sessions.getSessionDetail(auth(), reg.sessionUuid);
    expect(detail?.session).toMatchObject({ cli: { leased: true, host: "box", cwd: "/repo" }, originBound: true, continuable: true });
    expect(detail?.turns[0].messages.map((m) => m.text)).toEqual(["hello from the terminal", "hi"]);

    // Heartbeat renews; a stale holder is 409.
    expect((await heartbeatRoute.POST(post({ leaseHolder: reg.leaseHolder, backendSessionId: "claude-key" }), ctx(reg.sessionUuid))).status).toBe(200);
    expect((await heartbeatRoute.POST(post({ leaseHolder: "stale" }), ctx(reg.sessionUuid))).status).toBe(409);

    // Release ends the CLI turn and delivers the queued instruction immediately.
    const rel = await releaseRoute.POST(post({ leaseHolder: reg.leaseHolder, continuable: true }), ctx(reg.sessionUuid));
    expect(rel.status).toBe(200);
    expect((await rel.json()).data).toMatchObject({ released: true, deliveredTurnUuids: [sent.turn.uuid] });
    expect(deliveries()).toEqual([sent.turn.uuid]);
    expect((await db.daemonSessionTurn.findUniqueOrThrow({ where: { uuid: reg.turnUuid } })).status).toBe("ended");
    expect((await db.daemonSession.findUniqueOrThrow({ where: { uuid: reg.sessionUuid } })).backendSessionId).toBe("claude-key");
    const pending = await sessions.getPendingTurnsForConnection({ companyUuid: state.companyUuid, agentUuid: state.agentUuid, connectionUuid });
    expect(pending.map((p) => p.turnUuid)).toEqual([sent.turn.uuid]);
    // Released twice → 409, nothing re-delivered.
    expect((await releaseRoute.POST(post({ leaseHolder: reg.leaseHolder, continuable: true }), ctx(reg.sessionUuid))).status).toBe(409);
    expect(deliveries()).toEqual([sent.turn.uuid]);

    // After the lease is gone a send is delivered live.
    const live = await instructions.sendInstruction(auth(), { sessionUuid: reg.sessionUuid, instructionText: "and another" });
    expect(live.queued).toBe(false);
    expect(deliveries()).toEqual([sent.turn.uuid, live.turn.uuid]);
  });

  it("concurrent expiry triggers deliver queued turns exactly once; no queue → nothing woken", async () => {
    const reg = await register();
    const sent = await instructions.sendInstruction(auth(), { sessionUuid: reg.sessionUuid, instructionText: "queued" });
    await db.daemonSession.update({ where: { uuid: reg.sessionUuid }, data: { cliLeaseExpiresAt: new Date(Date.now() - 1000) } });
    const results = await Promise.all([
      sessions.sweepExpiredCliLeasesForConnection(state.companyUuid, connectionUuid),
      sessions.sweepExpiredCliLeasesForConnection(state.companyUuid, connectionUuid),
      sessions.getSessionDetail(auth(), reg.sessionUuid),
    ]);
    expect(results[0] as number + (results[1] as number)).toBeLessThanOrEqual(1);
    expect(deliveries()).toEqual([sent.turn.uuid]);
    expect((await db.daemonSessionTurn.findUniqueOrThrow({ where: { uuid: reg.turnUuid } })).status).toBe("ended");
    // A late heartbeat from the crashed run is now a conflict.
    expect((await heartbeatRoute.POST(post({ leaseHolder: reg.leaseHolder }), ctx(reg.sessionUuid))).status).toBe(409);

    const empty = await register();
    await db.daemonSession.update({ where: { uuid: empty.sessionUuid }, data: { cliLeaseExpiresAt: new Date(Date.now() - 1000) } });
    expect(await sessions.sweepExpiredCliLeasesForConnection(state.companyUuid, connectionUuid)).toBe(1);
    expect(deliveries()).toEqual([sent.turn.uuid]);
  });

  it("unbound / not-continuable sends are refused distinctly; a later daemon binds the session", async () => {
    const reg = await register({ host: "laptop", cwd: "/home/u/proj" });
    expect(reg.originBound).toBe(false);
    await expect(instructions.sendInstruction(auth(), { sessionUuid: reg.sessionUuid, instructionText: "x" }))
      .rejects.toBeInstanceOf(sessions.SessionUnboundError);

    const laptop = await db.daemonConnection.create({ data: {
      companyUuid: state.companyUuid, agentUuid: state.agentUuid, clientType: "claude_code", status: "online",
      host: "laptop", cwd: "/home/u", lastSeenAt: new Date(),
    } });
    // Own cwd differs: not served until the cwd is a discovered directory of that daemon.
    expect(await cli.bindUnboundCliSessionsForConnection(state.companyUuid, laptop.uuid)).toBe(0);
    const owner = await db.user.create({ data: { companyUuid: state.companyUuid, email: "o@x.invalid", oidcSub: "o-sub" } });
    await db.daemonDirectoryRequest.create({ data: {
      companyUuid: state.companyUuid, callerUserUuid: owner.uuid, agentUuid: state.agentUuid, targetConnectionUuid: laptop.uuid,
      operation: "roots", limit: 50, status: "success", result: { roots: ["/home/u"] }, deadlineAt: new Date(Date.now() + 60_000),
      completedAt: new Date(),
    } });
    expect(await cli.bindUnboundCliSessionsForConnection(state.companyUuid, laptop.uuid)).toBe(1);
    const bound = await db.daemonSession.findUniqueOrThrow({ where: { uuid: reg.sessionUuid } });
    expect(bound).toMatchObject({ originConnectionUuid: laptop.uuid, runtimeCwd: "/home/u/proj" });

    const rel = await releaseRoute.POST(post({ leaseHolder: reg.leaseHolder, continuable: false }), ctx(reg.sessionUuid));
    expect((await rel.json()).data).toMatchObject({ continuable: false, originBound: true, deliveredTurnUuids: [] });
    await expect(instructions.sendInstruction(auth(), { sessionUuid: reg.sessionUuid, instructionText: "x" }))
      .rejects.toBeInstanceOf(sessions.SessionNotContinuableError);
  });

  it("an Idea-anchored CLI session keeps its own key and receives its own instructions", async () => {
    const project = await db.project.create({ data: { companyUuid: state.companyUuid, name: "p", visibility: "public" } });
    const idea = await db.idea.create({ data: { companyUuid: state.companyUuid, projectUuid: project.uuid, title: "i", createdByUuid: state.agentUuid } });
    const reg = await register({ ideaUuid: idea.uuid });
    expect(reg.sessionId).not.toBe(idea.uuid);
    const sent = await instructions.sendInstruction(auth(), { sessionUuid: reg.sessionUuid, instructionText: "anchored" });
    expect(sent.turn.sessionUuid).toBe(reg.sessionUuid);
    expect(await db.daemonSession.count({ where: { companyUuid: state.companyUuid } })).toBe(1);

    const bad = await registerRoute.POST(post({ agentType: "claude_code", host: "box", cwd: "/repo", ideaUuid: "00000000-0000-4000-8000-000000000000" }), { params: Promise.resolve({}) });
    expect(bad.status).toBe(400);
  });
});
