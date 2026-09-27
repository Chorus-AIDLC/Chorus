/**
 * T4: actual CLI control/backfill/router/queue/waker/reporter -> loopback HTTP ->
 * actual Next handlers/services -> isolated PostgreSQL wire database.
 *
 * RESEARCH_DATABASE_URL must point at :5435. Never uses DATABASE_URL.
 * Auth and headless-process/config/transcript boundaries are explicit stubs.
 * The MCP Idea read is adapted to the actual REST Idea handler over HTTP.
 * No SSE socket, Redis, MCP transport, old CLI binary, or LLM is exercised.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- plain-JS CLI interop and HTTP JSON fixtures */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { NextRequest } from "next/server";
import { PrismaClient } from "../../generated/prisma/client";
import { EventRouter } from "../../../cli/event-router.mjs";
import { WakeQueue } from "../../../cli/wake-queue.mjs";
import { Waker } from "../../../cli/waker.mjs";
import { createBackfill } from "../../../cli/backfill.mjs";
import { createControlHandler } from "../../../cli/control-handler.mjs";
import { createDaemonRestClient } from "../../../cli/daemon-rest-client.mjs";
import { createTurnReporter } from "../../../cli/turn-reporter.mjs";
import { WAKE_ACTIONS } from "../../../cli/prompts.mjs";

const state = vi.hoisted(() => ({ db: null as unknown, company: "", actor: "", agent: "" }));
// Dependency wiring uses the real Prisma client, never a query mock.
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/auth", async (original) => ({
  ...await original<typeof import("@/lib/auth")>(),
  getAuthContext: async (request: NextRequest) => ({
    type: request.headers.get("authorization") === "Bearer fixture-user" ? "user" : "agent",
    companyUuid: state.company,
    actorUuid: request.headers.get("authorization") === "Bearer fixture-user" ? state.actor : state.agent,
    permissions: ["idea:read"],
  }),
}));

const url = process.env.RESEARCH_DATABASE_URL;
type Mode = "both" | "operation-only" | "research-only" | "legacy" | "old-server";
describe.skipIf(!url)("Dedicated operations CLI / HTTP / real database", () => {
  let db: PrismaClient;
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  let project: string;
  let instance: string;
  let connection: string;
  let otherConnection: string;
  let idea: string;
  let requestResearch: typeof import("../research.service").requestResearch;
  let updateTask: typeof import("../task.service").updateTask;
  let eventBus: typeof import("@/lib/event-bus").eventBus;
  const controls: any[] = [];
  const wire: { path: string; body: any; status: number }[] = [];
  const disposers: (() => Promise<void>)[] = [];
  // Server-side compatibility adapter models an older server ignoring the new flag.
  let oldServer = false;
  let loseTerminalResponse = false;

  beforeAll(async () => {
    if (!url || new URL(url).port !== "5435") throw new Error("T4 requires isolated :5435");
    if (process.env.REDIS_URL || process.env.REDIS_HOST) throw new Error("T4 requires local event bus, unset Redis");
    pool = new pg.Pool({ connectionString: url, max: 1 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    state.db = db;
    ({ requestResearch } = await import("../research.service"));
    ({ updateTask } = await import("../task.service"));
    ({ eventBus } = await import("@/lib/event-bus"));
    const pending = await import("../../app/api/daemon/pending-turns/route");
    const advance = await import("../../app/api/daemon/turn-advance/route");
    const create = await import("../../app/api/ideas/conversational/route");
    const detail = await import("../../app/api/ideas/[uuid]/route");
    state.company = (await db.company.create({ data: { name: `T4 ${randomUUID()}` } })).uuid;
    state.actor = randomUUID();
    project = (await db.project.create({ data: { companyUuid: state.company, name: "T4 HTTP" } })).uuid;
    state.agent = (await db.agent.create({ data: {
      companyUuid: state.company, name: "T4 process stub", roles: ["pm"], ownerUuid: state.actor,
    } })).uuid;
    instance = (await db.agentInstance.create({ data: {
      companyUuid: state.company, agentUuid: state.agent, host: "t4", cwd: "/tmp/t4-operation",
    } })).uuid;
    for (const wrong of [false, true]) {
      const row = await db.daemonConnection.create({ data: {
        companyUuid: state.company, agentUuid: state.agent, agentInstanceUuid: instance,
        host: "t4", cwd: wrong ? "/tmp/t4-other" : "/tmp/t4-operation", status: "online", clientType: "claude_code",
      } });
      if (wrong) otherConnection = row.uuid;
      else connection = row.uuid;
    }
    await db.projectAgentCwdPreference.create({ data: {
      companyUuid: state.company, userUuid: state.actor, projectUuid: project, agentUuid: state.agent,
      host: "t4", cwd: "/tmp/t4-operation", anchorAgentInstanceUuid: instance,
    } });
    eventBus.on(`control:${connection}`, captureControl);
    server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString();
        const address = new URL(req.url!, base);
        const originalPath = address.pathname + address.search;
        if (oldServer) address.searchParams.delete("operationProtocol");
        const request = new NextRequest(address, {
          method: req.method, headers: { authorization: req.headers.authorization ?? "", "Content-Type": "application/json" },
          ...(text ? { body: text } : {}),
        });
        const ctx = { params: Promise.resolve({}) };
        let response: Response;
        if (address.pathname === "/api/daemon/pending-turns") response = await pending.GET(request, ctx);
        else if (address.pathname === "/api/daemon/turn-advance") response = await advance.POST(request, ctx);
        else if (address.pathname === "/api/ideas/conversational") response = await create.POST(request, ctx);
        else if (/^\/api\/ideas\/[^/]+$/.test(address.pathname)) {
          response = await detail.GET(request, { params: Promise.resolve({ uuid: address.pathname.split("/").at(-1)! }) });
        } else throw new Error(`Unexpected HTTP path ${address.pathname}`);
        const body = text ? JSON.parse(text) : null;
        wire.push({ path: originalPath, body, status: response.status });
        // Commit the terminal edge, then simulate a lost response at the HTTP boundary.
        if (loseTerminalResponse && body?.status === "ended" && response.ok) {
          loseTerminalResponse = false;
          res.writeHead(503).end("Terminal response lost after commit");
        } else {
          res.writeHead(response.status, { "Content-Type": "application/json" }).end(await response.text());
        }
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback port");
    base = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  function captureControl(event: any) { controls.push(event); }
  beforeEach(async () => {
    controls.length = 0;
    wire.length = 0;
    oldServer = false;
    loseTerminalResponse = false;
    // A failed assertion must not leave pending fixtures for another test's sweep.
    await db.daemonSessionTurn.deleteMany({ where: { session: { companyUuid: state.company } } });
    await db.daemonSession.deleteMany({ where: { companyUuid: state.company } });
    await db.daemonConnection.updateMany({ where: { companyUuid: state.company }, data: { lastSeenAt: new Date() } });
    idea = (await db.idea.create({ data: {
      companyUuid: state.company, projectUuid: project, title: "T4 Idea", content: "Preserve me",
      status: "elaborated", elaborationStatus: "resolved", assigneeType: "agent_instance",
      assigneeUuid: instance, createdByUuid: state.actor,
    } })).uuid;
  });
  afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
  });
  afterAll(async () => {
    eventBus?.off(`control:${connection}`, captureControl);
    if (server) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    if (!db || !state.company) return;
    const tenant = { companyUuid: state.company };
    await db.daemonSessionTurn.deleteMany({ where: { session: tenant } });
    await db.daemonSession.deleteMany({ where: tenant });
    await db.notification.deleteMany({ where: tenant });
    await db.activity.deleteMany({ where: tenant });
    await db.acceptanceCriterion.deleteMany({ where: { task: tenant } });
    await db.task.deleteMany({ where: tenant });
    await db.proposal.deleteMany({ where: tenant });
    await db.idea.updateMany({ where: tenant, data: { parentUuid: null } });
    await db.idea.deleteMany({ where: tenant });
    await db.daemonConnection.deleteMany({ where: tenant });
    await db.projectAgentCwdPreference.deleteMany({ where: tenant });
    await db.agentInstance.deleteMany({ where: tenant });
    await db.agent.deleteMany({ where: tenant });
    await db.project.deleteMany({ where: tenant });
    await db.company.delete({ where: { uuid: state.company } });
    await db.$disconnect();
    await pool.end();
  });

  const research = () => requestResearch({
    companyUuid: state.company, actorUuid: state.actor, actorType: "user", ideaUuid: idea,
  });
  const savedTurn = (uuid: string) => db.daemonSessionTurn.findUniqueOrThrow({ where: { uuid } });
  async function creation(decompose = false) {
    const response = await fetch(`${base}/api/ideas/conversational`, {
      method: "POST", headers: { authorization: "Bearer fixture-user", "Content-Type": "application/json" },
      body: JSON.stringify({ projectUuid: project, agentUuid: state.agent, connectionUuid: connection,
        descriptionText: "T4 create via HTTP", decompose, researchFirst: decompose }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()).data;
    idea = result.idea.uuid;
    return result;
  }
  async function ordinary(sessionUuid: string, text: string) {
    const last = await db.daemonSessionTurn.aggregate({ where: { sessionUuid }, _max: { seq: true } });
    return db.daemonSessionTurn.create({ data: {
      sessionUuid, seq: (last._max.seq ?? 0) + 1, trigger: "human_instruction", promptText: text,
    } });
  }
  function client(mode: Mode = "both", conn = connection) {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    // Capability adapter retains real fetch/network. No fabricated response bodies.
    const fetchImpl = (input: any, init?: RequestInit) => {
      const address = new URL(String(input));
      if (mode === "operation-only" || mode === "legacy") address.searchParams.delete("researchProtocol");
      if (mode === "research-only" || mode === "legacy") address.searchParams.delete("operationProtocol");
      return fetch(address, init);
    };
    const opts = { url: base, apiKey: "fixture-agent", getConnectionUuid: () => conn, logger, fetchImpl };
    return { opts, rest: createDaemonRestClient(opts), report: createTurnReporter(opts), logger };
  }
  function harness(mode: Mode = "both", options: {
    conn?: string; failure?: "cwd" | "config"; hold?: Promise<void>; processHold?: Promise<void>;
  } = {}) {
    const c = client(mode, options.conn);
    const seen = new Set<string>();
    const batches: any[][] = [];
    const launches: any[] = [];
    const errors: unknown[] = [];
    const deliveries: Promise<void>[] = [];
    let active = 0;
    let maxActive = 0;
    const mcpClient = { callTool: async (name: string, args: any) => {
      if (name !== "chorus_get_idea") throw new Error(`Unexpected MCP adaptation ${name}`);
      const response = await fetch(`${base}/api/ideas/${args.ideaUuid}`, { headers: { authorization: "Bearer fixture-agent" } });
      if (!response.ok) throw new Error(`Idea read ${response.status}`);
      return (await response.json()).data;
    } };
    const waker = new Waker({
      creds: { url: base, apiKey: "fixture-agent" }, cwd: "/tmp/WRONG-default-cwd",
      lineage: { resolve: async () => { throw new Error("Pending turns must carry their own attribution"); } },
      logger: c.logger, advanceTurn: c.report,
      validateRuntimeCwd: async (cwd: string) => {
        if (options.failure === "cwd") throw Object.assign(new Error("fixture missing cwd"), { code: "ENOENT" });
        return { normalizedPath: cwd };
      },
      writeMcpConfigFn: () => {
        if (options.failure === "config") throw new Error("fixture config failure");
        return { path: "/tmp/never-created-t4-config", cleanup() {} };
      },
      isNewSessionFn: () => true,
      hooks: { onSessionEnd: async () => ({ usage: { source: "t4-process-stub", inputTokens: 7, outputTokens: 3 } }) },
      spawner: { wake: async (params: any) => {
        launches.push(params);
        const exact = batches.at(-1)![0].turnUuid;
        if (exact) {
          // Persistence is observed at the actual process boundary, before onChild.
          try { expect(await savedTurn(exact)).toMatchObject({ status: "running" }); }
          catch (error) { errors.push(error); }
        }
        params.onChild({ pid: 0 });
        await options.processHold;
        return { sessionId: params.sessionId, backendSessionId: `t4-${params.sessionId}`, exitCode: 0, isNew: true };
      } },
    } as any);
    const queue = new WakeQueue({ logger: c.logger, runBatch: async (key: string, items: any[]) => {
      await options.hold;
      maxActive = Math.max(maxActive, ++active);
      batches.push(items.map((item) => item.notification));
      try { await waker.wakeBatch(items.map((item) => item.notification), key, items[0].attribution); }
      finally { active--; }
    } });
    const router = new EventRouter({ queue, waker, mcpClient, seen, wakeActions: WAKE_ACTIONS, logger: c.logger } as any);
    const backfill = createBackfill({
      ...c.opts, mcpClient, seen, dispatch: () => { throw new Error("Use turn-only recovery"); },
      dispatchPendingTurn: (turn: any) => {
        if (mode !== "legacy") return router.dispatchPendingTurn(turn);
        // Historical FIFO client adapter: all projected instructions are ordinary.
        // It runs the actual shared queue/waker, without today's Research detector.
        if (seen.has(`turn:${turn.turnUuid}`)) return;
        seen.add(`turn:${turn.turnUuid}`);
        const key = `idea:${turn.directIdeaUuid}`;
        // A neutral envelope avoids the current Waker's prefix detector; historical
        // Wakers did not have that detector. Keep the entire saved prompt as data.
        queue.enqueue(key, { notification: { action: "human_instruction", instructionText: `Legacy FIFO delivery:\n${turn.promptText}`,
          entityType: "idea", entityUuid: turn.directIdeaUuid, runtimeCwd: turn.runtimeCwd },
          attribution: { key, directIdeaUuid: turn.directIdeaUuid, rootIdeaUuid: turn.directIdeaUuid } });
      },
    } as any) as unknown as (() => Promise<void>) & { pendingTurnsOnly: (uuid?: string) => Promise<void> };
    const control = createControlHandler({ waker, getConnectionUuid: c.opts.getConnectionUuid,
      logger: c.logger, deliverTurn: (uuid?: string) => {
        const delivery = backfill.pendingTurnsOnly(uuid);
        deliveries.push(delivery);
        return delivery;
      } } as any);
    async function settle() {
      await Promise.all(deliveries);
      // Backfill schedules async creation identity validation without awaiting it.
      await router.pendingDispatch;
      expect(await queue.drain(5000)).toBe(true);
      expect(queue.pendingKeyCount).toBe(0);
      expect(errors).toEqual([]);
      expect(maxActive).toBeLessThanOrEqual(1);
    }
    disposers.push(async () => { queue.stop(); await waker.interruptAll(); });
    return { ...c, router, queue, backfill, control, settle, seen, batches, launches };
  }

  it.each(["both", "operation-only", "research-only", "legacy", "old-server"] as Mode[])(
    "%s dispatches elaborate/decompose/Research through CLI to terminal, preserving UUID/cwd and reconnect emptiness",
    async (mode) => {
      oldServer = mode === "old-server";
      const h = harness(mode);
      for (const decompose of [false, true]) {
        const result = await creation(decompose);
        const pending = await h.rest.readPendingTurns();
        expect(pending.ok).toBe(true);
        const dto = pending.data!.turns.find((row: any) => row.turnUuid === result.turn.uuid);
        expect(dto).toMatchObject({ sessionId: idea, runtimeCwd: "/tmp/t4-operation",
          trigger: mode === "both" || mode === "operation-only" ? "idea_creation_requested" : "human_instruction" });
        await h.backfill.pendingTurnsOnly(result.turn.uuid);
        await h.settle();
        expect(await savedTurn(result.turn.uuid)).toMatchObject({ trigger: "idea_creation_requested", status: "ended" });
        expect(h.launches.at(-1)).toMatchObject({ sessionId: idea, cwd: "/tmp/t4-operation" });
        expect(h.launches.at(-1).prompt).toMatch(decompose
          ? /ONE single-select question per child|ONE elaboration question PER proposed child/
          : /start elaboration/);
        const r = await research();
        await h.backfill.pendingTurnsOnly(r.turnUuid);
        await h.settle();
        expect(await savedTurn(r.turnUuid)).toMatchObject({ trigger: "research_requested", status: "ended" });
        expect(h.launches.at(-1).prompt).toMatch(/research-only|ONE bounded pass/);
        const reconnect = await h.rest.readPendingTurns();
        expect(reconnect.ok).toBe(true);
        expect(reconnect.data!.turns.filter((row: any) => row.sessionId === idea)).toEqual([]);
      }
      expect(h.launches).toHaveLength(4);
      expect(wire.filter((row) => row.body?.status).every((row) => row.status === 200)).toBe(true);
      if (mode === "old-server") expect(wire.filter((row) => row.path.includes("/api/daemon/"))
        .every((row) => row.path.includes("operationProtocol=1") && row.path.includes("researchProtocol=1"))).toBe(true);
    },
  );

  it("deduplicates actual live control pings plus backfill; independent same-origin admission cannot launch twice", async () => {
    const r = await research();
    let finish!: () => void;
    const h = harness("both", { processHold: new Promise<void>((resolve) => { finish = resolve; }) });
    const loser = harness();
    const dto = (await h.rest.readPendingTurns()).data!.turns.find((row: any) => row.turnUuid === r.turnUuid);
    const ping = controls.find((event) => event.turnUuid === r.turnUuid);
    expect(ping).toMatchObject({ command: "deliver_turn", targetConnectionUuid: connection });
    h.control(ping);
    h.control(ping);
    await h.backfill.pendingTurnsOnly();
    try {
      await vi.waitFor(() => expect(h.launches).toHaveLength(1));
      // Another process has no seen state and still holds the stale pending read.
      await loser.router.dispatchPendingTurn(dto);
      await loser.settle();
      expect(loser.launches).toHaveLength(0);
      expect(await savedTurn(r.turnUuid)).toMatchObject({ status: "running" });
    } finally { finish(); }
    await h.settle();
    expect(await savedTurn(r.turnUuid)).toMatchObject({ status: "ended" });
    expect(wire.some((row) => row.body?.turnUuid === r.turnUuid && row.status === 409)).toBe(true);
  });

  it("serializes two Research requests among ordinary batches and keeps terminal retry usage idempotent", async () => {
    const first = await research();
    const a = await ordinary(first.sessionUuid, "ordinary before second research");
    const second = await research();
    const b = await ordinary(first.sessionUuid, "ordinary tail one");
    const c = await ordinary(first.sessionUuid, "ordinary tail two");
    let release!: () => void;
    const h = harness("both", { hold: new Promise<void>((resolve) => { release = resolve; }) });
    await h.backfill.pendingTurnsOnly();
    await h.router.pendingDispatch;
    loseTerminalResponse = true;
    release();
    await h.settle();
    expect(h.batches.map((batch) => batch.map((n) => n.action))).toEqual([
      ["research_requested"], ["human_instruction"], ["research_requested"], ["human_instruction", "human_instruction"],
    ]);
    expect(await Promise.all([first.turnUuid, a.uuid, second.turnUuid, b.uuid, c.uuid].map(async (uuid) => (await savedTurn(uuid)).status)))
      .toEqual(["ended", "ended", "ended", "ended", "merged"]);
    expect((await savedTurn(first.turnUuid)).usage).toMatchObject({ inputTokens: 7 });
    expect(await db.daemonSession.findUniqueOrThrow({ where: { uuid: first.sessionUuid } }))
      .toMatchObject({ totalInputTokens: 28, totalOutputTokens: 12 });
    expect(wire.filter((row) => row.body?.status === "ended" && row.body.turnUuid === first.turnUuid)).toHaveLength(2);
    expect((await h.rest.readPendingTurns()).data!.turns.filter((row: any) => row.sessionId === idea)).toEqual([]);
  });

  it("legacy FIFO coalesces canonical creation and two Research rows without replaying merged rows", async () => {
    const created = await creation(true);
    const first = await research();
    const second = await research();
    let release!: () => void;
    const h = harness("legacy", { hold: new Promise<void>((resolve) => { release = resolve; }) });
    await h.backfill.pendingTurnsOnly();
    release();
    await h.settle();
    expect(h.batches.map((batch) => batch.length)).toEqual([1, 2]);
    expect(await Promise.all([created.turn.uuid, first.turnUuid, second.turnUuid].map(async (uuid) => (await savedTurn(uuid)).status)))
      .toEqual(["ended", "ended", "merged"]);
    const restarted = harness("legacy");
    await restarted.backfill.pendingTurnsOnly();
    await restarted.settle();
    expect(restarted.launches).toHaveLength(0);
  });

  it("wrong connection rejects live control, pending read and exact admission without consuming the origin turn", async () => {
    const r = await research();
    const h = harness("both", { conn: otherConnection });
    h.control(controls.find((event) => event.turnUuid === r.turnUuid));
    await h.backfill.pendingTurnsOnly();
    await h.settle();
    expect(h.launches).toHaveLength(0);
    expect((await h.rest.readPendingTurns()).data!.turns.some((row: any) => row.turnUuid === r.turnUuid)).toBe(false);
    const outcome = await h.report({ sessionId: idea, turnUuid: r.turnUuid, status: "running" });
    expect(outcome?.ok).toBe(false);
    expect(await savedTurn(r.turnUuid)).toMatchObject({ status: "pending", backendSessionId: null });
    // End the fixture through its actual origin, so later reconnect tests see no residue.
    const origin = harness();
    await origin.backfill.pendingTurnsOnly(r.turnUuid);
    await origin.settle();
    expect(origin.launches).toHaveLength(1);
  });

  it("invalid payload is visible and pending without seen ownership; corrected same UUID retries through HTTP", async () => {
    const r = await research();
    await db.daemonSessionTurn.update({ where: { uuid: r.turnUuid }, data: {
      operationPayload: { version: 99, kind: "research", ideaUuid: idea },
    } });
    const h = harness();
    await h.backfill.pendingTurnsOnly(r.turnUuid);
    await h.settle();
    expect(h.launches).toHaveLength(0);
    expect(h.seen.has(`turn:${r.turnUuid}`)).toBe(false);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/pending and retryable/));
    expect((await h.report({ sessionId: idea, turnUuid: r.turnUuid, status: "running" }))?.status).toBe(409);
    expect(await savedTurn(r.turnUuid)).toMatchObject({ status: "pending" });
    await db.daemonSessionTurn.update({ where: { uuid: r.turnUuid }, data: {
      operationPayload: { version: 1, kind: "research", ideaUuid: idea },
    } });
    await h.backfill.pendingTurnsOnly(r.turnUuid);
    await h.settle();
    expect(h.launches).toHaveLength(1);
    expect(await savedTurn(r.turnUuid)).toMatchObject({ status: "ended" });
  });

  it.each(["read", "admission"])("descendant execution retires queued Research at %s while ordinary work survives", async (boundary) => {
    const r = await research();
    const o = await ordinary(r.sessionUuid, "must survive stage retirement");
    const h = harness();
    const dto = (await h.rest.readPendingTurns()).data!.turns.find((row: any) => row.turnUuid === r.turnUuid);
    await db.idea.update({ where: { uuid: idea }, data: { isContainer: true } });
    const child = await db.idea.create({ data: {
      companyUuid: state.company, projectUuid: project, parentUuid: idea, title: "Child", createdByUuid: state.actor,
    } });
    const proposal = await db.proposal.create({ data: {
      companyUuid: state.company, projectUuid: project, title: "Child plan", inputType: "idea",
      inputUuids: [child.uuid], status: "approved", createdByUuid: state.agent,
    } });
    const task = await db.task.create({ data: {
      companyUuid: state.company, projectUuid: project, proposalUuid: proposal.uuid,
      title: "Child task", status: "open", createdByUuid: state.agent,
    } });
    await updateTask(task.uuid, { status: "in_progress" });
    if (boundary === "read") await h.backfill.pendingTurnsOnly(r.turnUuid);
    else await h.router.dispatchPendingTurn(dto);
    await h.settle();
    expect(h.launches).toHaveLength(0);
    expect(await savedTurn(r.turnUuid)).toMatchObject({ status: "interrupted", interruptedReason: "research_stage_changed" });
    expect(await savedTurn(o.uuid)).toMatchObject({ status: "pending" });
    await h.backfill.pendingTurnsOnly();
    await h.settle();
    expect(h.launches).toHaveLength(1);
    expect(await savedTurn(o.uuid)).toMatchObject({ status: "ended" });
  });

  it.each(["cwd", "config"] as const)("%s prelaunch failure retires only the exact turn and reconnect runs its neighbor", async (failure) => {
    const first = await research();
    const second = await research();
    const h = harness("both", { failure });
    await h.backfill.pendingTurnsOnly(first.turnUuid);
    await h.settle();
    expect(h.launches).toHaveLength(0);
    expect(await savedTurn(first.turnUuid)).toMatchObject({ status: "interrupted" });
    expect(await savedTurn(second.turnUuid)).toMatchObject({ status: "pending" });
    const restarted = harness();
    await restarted.backfill.pendingTurnsOnly();
    await restarted.settle();
    expect(restarted.launches).toHaveLength(1);
    expect(await savedTurn(second.turnUuid)).toMatchObject({ status: "ended" });
  });
});
