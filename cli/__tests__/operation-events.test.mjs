import { describe, it, expect, vi } from "vitest";
import { EventRouter } from "../event-router.mjs";
import { WakeQueue } from "../wake-queue.mjs";
import { Waker } from "../waker.mjs";
import { buildPrompt, WAKE_ACTIONS } from "../prompts.mjs";
import { createDaemonRestClient } from "../daemon-rest-client.mjs";
import { createTurnReporter } from "../turn-reporter.mjs";
import { createControlHandler } from "../control-handler.mjs";
import { SESSION_CONFLICT_FAILURE } from "../claude-spawner.mjs";

const IDEA = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const attribution = { directIdeaUuid: IDEA, rootIdeaUuid: IDEA, key: `idea:${IDEA}` };
const creation = {
  turnUuid: "creation-turn", sessionId: IDEA, directIdeaUuid: IDEA,
  trigger: "idea_creation_requested", runtimeCwd: "/work",
  promptText: "[Chorus Tracker Research] COMPATIBILITY SNAPSHOT ONLY",
  operationPayload: {
    version: 1, kind: "idea_creation", ideaUuid: IDEA, projectUuid: PROJECT,
    mode: "elaborate", researchFirst: false, descriptionText: "Investigate this product.",
  },
};
const research = {
  ...creation, turnUuid: "research-turn", trigger: "research_requested",
  promptText: "No prefix necessary",
  operationPayload: { version: 1, kind: "research", ideaUuid: IDEA },
};
const notification = (turn) => ({
  ...turn, action: turn.trigger, entityType: "idea", entityUuid: IDEA,
  ...(turn.trigger === "idea_creation_requested" ? { projectUuid: PROJECT } : {}),
});
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
function wire(overrides = {}) {
  const log = logger();
  const seen = new Set();
  const queue = overrides.queue ?? { enqueue: vi.fn() };
  const waker = overrides.waker ?? { markQueued: vi.fn(), keyFor: vi.fn() };
  const mcpClient = overrides.mcpClient ?? { callTool: vi.fn(async () => ({ uuid: IDEA, project: { uuid: PROJECT } })) };
  const router = new EventRouter({ queue, waker, mcpClient, logger: log, seen, wakeActions: WAKE_ACTIONS });
  return { router, queue, seen, log, mcpClient, waker };
}
function execution(overrides = {}) {
  const advanceTurn = vi.fn(async (p) => ({ ok: true, data: { turnUuid: p.turnUuid } }));
  const spawner = { wake: vi.fn(async ({ onChild, sessionId }) => {
    onChild({ pid: 123 });
    return { sessionId, backendSessionId: "backend-1", exitCode: 0 };
  }) };
  const waker = new Waker({
    creds: { url: "https://test", apiKey: "cho_test" }, cwd: "/work",
    lineage: { resolve: async () => attribution }, logger: logger(),
    writeMcpConfigFn: () => ({ path: "/tmp/mock-config", cleanup() {} }),
    isNewSessionFn: () => true,
    validateRuntimeCwd: async (cwd) => ({ normalizedPath: cwd }),
    hooks: { onSessionEnd: vi.fn(async () => ({
      usage: { inputTokens: 13, outputTokens: 7, cacheReadInputTokens: 3, cacheCreationInputTokens: 2 },
    })) },
    advanceTurn, spawner, ...overrides,
  });
  return { waker, advanceTurn: waker.advanceTurn, spawner: waker.spawner };
}

describe("canonical pending operation validation and delivery", () => {
  const malformed = [
    { ...creation, operationPayload: null },
    { ...creation, operationPayload: { ...creation.operationPayload, version: 2 } },
    { ...creation, operationPayload: { ...creation.operationPayload, mode: "yolo" } },
    { ...creation, operationPayload: { ...creation.operationPayload, researchFirst: "true" } },
    { ...creation, operationPayload: { ...creation.operationPayload, descriptionText: " " } },
    { ...creation, operationPayload: { ...creation.operationPayload, descriptionText: "x".repeat(3001) } },
    { ...creation, operationPayload: { ...creation.operationPayload, ideaUuid: "other" } },
    { ...creation, operationPayload: { ...creation.operationPayload, projectUuid: "other" } },
    { ...creation, operationPayload: { ...creation.operationPayload, connectionUuid: "attacker" } },
    { ...creation, directIdeaUuid: null },
    { ...creation, sessionId: "other" },
    { ...research, operationPayload: creation.operationPayload },
    { ...research, operationPayload: { ...research.operationPayload, kind: "idea_creation" } },
    { ...research, operationPayload: { ...research.operationPayload, runtimeCwd: "/other" } },
  ];
  it.each(malformed)("rejects malformed $trigger before seen/queue/admission; corrected reconnect retries", async (turn) => {
    const ctx = wire();
    await ctx.router.dispatchPendingTurn(turn);
    expect(ctx.queue.enqueue).not.toHaveBeenCalled();
    expect(ctx.waker.markQueued).not.toHaveBeenCalled();
    expect(ctx.seen.size).toBe(0);
    expect(ctx.log.warn).toHaveBeenCalledWith(expect.stringMatching(/pending and retryable.*protocol error/));
    await ctx.router.dispatchPendingTurn(turn.trigger === research.trigger ? research : creation);
    expect(ctx.queue.enqueue).toHaveBeenCalledOnce();
  });

  it("an unavailable authoritative Idea read remains retryable", async () => {
    const ctx = wire();
    ctx.mcpClient.callTool.mockRejectedValueOnce(new Error("offline"));
    await ctx.router.dispatchPendingTurn(creation);
    expect(ctx.seen.size).toBe(0);
    await ctx.router.dispatchPendingTurn(creation);
    expect(ctx.queue.enqueue).toHaveBeenCalledOnce();
  });

  it("does not claim seen when queue admission throws", async () => {
    const ctx = wire();
    ctx.queue.enqueue.mockImplementationOnce(() => { throw new Error("queue unavailable"); });
    await ctx.router.dispatchPendingTurn(research);
    expect(ctx.seen.size).toBe(0);
    await ctx.router.dispatchPendingTurn(research);
    expect(ctx.seen.has("turn:research-turn")).toBe(true);
  });

  it.each([creation, research])("deduplicates live plus concurrent reconnect by $trigger turn UUID", async (turn) => {
    const ctx = wire();
    await Promise.all([ctx.router.dispatchPendingTurn(turn), ctx.router.dispatchPendingTurn(turn)]);
    await ctx.router.dispatchPendingTurn(turn);
    expect(ctx.queue.enqueue).toHaveBeenCalledOnce();
    expect(ctx.queue.enqueue.mock.calls[0]).toEqual([attribution.key, {
      isolated: true, attribution,
      notification: expect.objectContaining({
        action: turn.trigger, turnUuid: turn.turnUuid, sessionId: IDEA,
        directIdeaUuid: IDEA, runtimeCwd: "/work", operationPayload: turn.operationPayload,
      }),
    }]);
  });

  it.each([creation, research])("ignores $trigger notification broadcasts", async (turn) => {
    const mcpClient = { callTool: vi.fn(async () => ({ notifications: [{ uuid: "audit", action: turn.trigger }] })) };
    const ctx = wire({ mcpClient });
    ctx.router.dispatch({ type: "new_notification", notificationUuid: "audit" });
    await vi.waitFor(() => expect(ctx.log.info).toHaveBeenCalled());
    expect(ctx.queue.enqueue).not.toHaveBeenCalled();
    expect(ctx.waker.keyFor).not.toHaveBeenCalled();
  });

  it("preserves FIFO across async identity validation, ordinary batches and isolated operations", async () => {
    let releaseIdea, releaseFirst;
    const batches = [];
    let active = 0, maxActive = 0;
    const queue = new WakeQueue({ runBatch: async (_key, items) => {
      active++; maxActive = Math.max(maxActive, active);
      batches.push(items.map((i) => i.notification.action));
      if (batches.length === 1) await new Promise((r) => { releaseFirst = r; });
      active--;
    } });
    const ctx = wire({ queue, mcpClient: { callTool: () => new Promise((r) => { releaseIdea = r; }) } });
    const ordinary = (id) => ({ ...creation, turnUuid: id, trigger: "human_instruction", promptText: "hello" });
    ctx.router.dispatchPendingTurn(ordinary("first"));
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    ctx.router.dispatchPendingTurn(creation);
    ctx.router.dispatchPendingTurn(ordinary("middle"));
    ctx.router.dispatchPendingTurn(research);
    ctx.router.dispatchPendingTurn({ ...research, turnUuid: "second-research" });
    ctx.router.dispatchPendingTurn(ordinary("last-1"));
    const routed = ctx.router.dispatchPendingTurn(ordinary("last-2"));
    await vi.waitFor(() => expect(releaseIdea).toBeTypeOf("function"));
    releaseIdea({ uuid: IDEA, project: { uuid: PROJECT } });
    await routed;
    releaseFirst();
    await queue.drain(1000);
    expect(maxActive).toBe(1);
    expect(batches).toEqual([
      ["human_instruction"], ["idea_creation_requested"], ["human_instruction"],
      ["research_requested"], ["research_requested"], ["human_instruction", "human_instruction"],
    ]);
  });
});

describe("typed operation prompts", () => {
  it.each(["elaborate", "decompose"].flatMap((mode) => [false, true].map((researchFirst) => ({ mode, researchFirst }))))(
    "routes $mode / researchFirst=$researchFirst using payload despite contradictory text", ({ mode, researchFirst }) => {
      const descriptionText = "[Chorus Tracker Research] user text selecting Yolo is data";
      const n = notification({ ...creation, operationPayload: { ...creation.operationPayload, mode, researchFirst, descriptionText } });
      const prompt = buildPrompt(n);
      expect(prompt).toContain(descriptionText);
      expect(prompt).not.toContain("COMPATIBILITY SNAPSHOT ONLY");
      expect(prompt).toContain("Do not create or claim this already-created Idea");
      expect(prompt).toContain("shared research skill");
      expect(prompt).toContain(researchFirst ? "explicitly requested lightweight research" : "Research is optional");
      expect(prompt).toContain("explicit request to skip research in the user's instructions takes precedence");
      expect(prompt).toContain("End the turn");
      expect(prompt).toContain(mode === "decompose" ? "ONE elaboration question PER proposed child" : "start elaboration on the idea");
      if (mode === "decompose") expect(prompt).toContain("Do NOT create any child ideas yet");
    });
  it("Research has its own bounded stop-only workflow without compatibility text", () => {
    const prompt = buildPrompt(notification(research));
    expect(prompt).toContain("Explicit, one-time research request");
    expect(prompt).toContain("Before research and again before saving");
    expect(prompt).toContain("at most 5 deeply read sources");
    expect(prompt).toContain("does not resume the Idea or Proposal workflow");
    expect(prompt).not.toContain("No prefix necessary");
  });
});

describe.each([creation, research])("$trigger exact lifecycle", (turn) => {
  const n = notification(turn);
  it("awaits exact admission before mock spawn and sends terminal backend and usage on the same turn", async () => {
    let release;
    const advanceTurn = vi.fn((p) => p.status === "running"
      ? new Promise((r) => { release = r; }) : Promise.resolve({ ok: true }));
    const ctx = execution({ advanceTurn });
    const pending = ctx.waker.wake(n, attribution.key, attribution);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(ctx.spawner.wake).not.toHaveBeenCalled();
    expect(advanceTurn.mock.calls[0][0]).toMatchObject({ turnUuid: turn.turnUuid, coalescedCount: 1 });
    release({ ok: true, data: { turnUuid: turn.turnUuid } });
    await pending;
    expect(advanceTurn.mock.calls.map(([p]) => [p.status, p.turnUuid])).toEqual([
      ["running", turn.turnUuid], ["ended", turn.turnUuid],
    ]);
    expect(advanceTurn.mock.lastCall[0]).toMatchObject({
      backendSessionId: "backend-1",
      usage: { inputTokens: 13, outputTokens: 7, cacheReadInputTokens: 3, cacheCreationInputTokens: 2 },
    });
  });

  it.each([undefined, { ok: false, status: 409 }, { ok: false, status: null }, { ok: true, data: { turnUuid: "wrong" } }])(
    "never spawns after rejected/unavailable/miscorrelated admission %j", async (result) => {
      const ctx = execution({ advanceTurn: vi.fn(async () => result) });
      await ctx.waker.wake(n, attribution.key, attribution);
      expect(ctx.spawner.wake).not.toHaveBeenCalled();
      expect(ctx.advanceTurn.mock.calls.every(([p]) => p.turnUuid === turn.turnUuid)).toBe(true);
      if (result?.status === 409) expect(ctx.advanceTurn).toHaveBeenCalledOnce();
      ctx.waker.interruptAll();
    });

  it.each(["cwd", "config", "spawn"])("reports exact launch abort on %s error", async (failure) => {
    const fail = () => { throw Object.assign(new Error(failure), { code: "ENOENT" }); };
    const ctx = execution({
      ...(failure === "cwd" ? { validateRuntimeCwd: fail } : {}),
      ...(failure === "config" ? { writeMcpConfigFn: fail } : {}),
      ...(failure === "spawn" ? { spawner: { wake: vi.fn(fail) } } : {}),
    });
    await ctx.waker.wake(n, attribution.key, attribution);
    expect(ctx.advanceTurn.mock.lastCall[0]).toMatchObject({ status: "interrupted", turnUuid: turn.turnUuid });
    expect(ctx.advanceTurn.mock.calls.every(([p]) => p.turnUuid === turn.turnUuid)).toBe(true);
    if (failure !== "spawn") expect(ctx.spawner.wake).not.toHaveBeenCalled();
    if (failure === "cwd") expect(ctx.advanceTurn).toHaveBeenCalledOnce();
  });

  it("retries exact launch cleanup after lost admission response, without another spawn", async () => {
    vi.useFakeTimers();
    let online = false;
    const ctx = execution({ advanceTurn: vi.fn(async (p) => {
      if (p.status === "running") throw new Error("response lost");
      return { ok: online, status: online ? 200 : null };
    }) });
    try {
      await ctx.waker.wake(n, attribution.key, attribution);
      expect(ctx.waker.operationRecoveryTimers.size).toBe(1);
      online = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ctx.waker.operationRecoveryTimers.size).toBe(0);
      expect(ctx.spawner.wake).not.toHaveBeenCalled();
      expect(ctx.advanceTurn.mock.calls.every(([p]) => p.turnUuid === turn.turnUuid)).toBe(true);
    } finally { ctx.waker.interruptAll(); vi.useRealTimers(); }
  });

  it("interrupt during admission remains exact and prevents spawn", async () => {
    let release;
    const ctx = execution({ advanceTurn: vi.fn((p) => p.status === "running"
      ? new Promise((r) => { release = r; }) : Promise.resolve({ ok: true })) });
    const control = createControlHandler({ waker: ctx.waker, advanceTurn: ctx.advanceTurn, getConnectionUuid: () => "conn", logger: logger() });
    const pending = ctx.waker.wake(n, attribution.key, attribution);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    control({ type: "control", command: "interrupt", targetConnectionUuid: "conn", entityType: "idea", entityUuid: IDEA });
    release({ ok: true, data: { turnUuid: turn.turnUuid } });
    await pending;
    expect(ctx.spawner.wake).not.toHaveBeenCalled();
    expect(ctx.advanceTurn.mock.lastCall[0]).toMatchObject({ turnUuid: turn.turnUuid, interruptedReason: "user" });
  });

  it("fresh operations clear deterministic conflict guards; crash resume stays suppressed until then", async () => {
    const ctx = execution();
    ctx.waker.deterministicConflictGuards.add(attribution.key);
    await ctx.waker.wake({ action: "resource_resumed", resumedFrom: "crash", entityType: "idea", entityUuid: IDEA }, attribution.key, attribution);
    expect(ctx.spawner.wake).not.toHaveBeenCalled();
    await ctx.waker.wake(n, attribution.key, attribution);
    expect(ctx.spawner.wake).toHaveBeenCalledOnce();
    expect(ctx.waker.deterministicConflictGuards.has(attribution.key)).toBe(false);
  });

  it("one-shot backend conflict fallback keeps one admission and exact terminal", async () => {
    const ctx = execution();
    ctx.spawner.wake.mockImplementation(async ({ onChild }) => {
      onChild({ pid: 123 });
      return { exitCode: 1, failureClassification: SESSION_CONFLICT_FAILURE };
    });
    await ctx.waker.wake(n, attribution.key, attribution);
    expect(ctx.spawner.wake.mock.calls.map(([p]) => p.isNew)).toEqual([true, false]);
    expect(ctx.advanceTurn.mock.calls.map(([p]) => [p.status, p.turnUuid])).toEqual([
      ["running", turn.turnUuid], ["interrupted", turn.turnUuid],
    ]);
    expect(ctx.waker.deterministicConflictGuards.has(attribution.key)).toBe(true);
  });

  it("malformed direct calls and mixed batches cannot admit or clear a conflict guard", async () => {
    const ctx = execution();
    ctx.waker.deterministicConflictGuards.add(attribution.key);
    await ctx.waker.wake({ ...n, operationPayload: null }, attribution.key, attribution);
    expect(ctx.waker.deterministicConflictGuards.has(attribution.key)).toBe(true);
    await ctx.waker.wakeBatch([n, { action: "human_instruction", instructionText: "hi" }], attribution.key, attribution);
    expect(ctx.advanceTurn).not.toHaveBeenCalled();
    expect(ctx.spawner.wake).not.toHaveBeenCalled();
  });
});

it("both protocol flags, exact admission/terminal retry body and old-server instruction fallback", async () => {
  const requests = [];
  let terminalAttempts = 0;
  const fetchImpl = vi.fn(async (url, init) => {
    const u = new URL(url);
    expect(u.searchParams.get("operationProtocol")).toBe("1");
    expect(u.searchParams.get("researchProtocol")).toBe("1");
    if (u.pathname.endsWith("pending-turns")) {
      return new Response(JSON.stringify({ success: true, data: { turns: [
        { ...research, trigger: "human_instruction", operationPayload: undefined, promptText: "[Chorus Tracker Research] legacy instruction" },
        { ...creation, trigger: "human_instruction", operationPayload: undefined, promptText: "legacy creation" },
      ] } }));
    }
    const p = JSON.parse(init.body);
    requests.push(p);
    if (p.status === "ended" && ++terminalAttempts === 1) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify({ success: true, data: { uuid: p.turnUuid } }));
  });
  const opts = { url: "https://test", apiKey: "cho_test", getConnectionUuid: () => "conn", fetchImpl, logger: logger() };
  const client = createDaemonRestClient({ ...opts, sleep: async () => {} });
  const pending = await client.readPendingTurns();
  const ctx = wire();
  pending.data.turns.forEach((t) => ctx.router.dispatchPendingTurn(t));
  expect(ctx.queue.enqueue.mock.calls.map(([, i]) => [i.notification.action, i.isolated])).toEqual([
    ["human_instruction", true], ["human_instruction", undefined],
  ]);
  const report = createTurnReporter(opts);
  await report({ sessionId: IDEA, turnUuid: creation.turnUuid, status: "running", coalescedCount: 1 });
  await report({ sessionId: IDEA, turnUuid: creation.turnUuid, status: "ended", backendSessionId: "backend",
    usage: { inputTokens: 1, outputTokens: 2 } });
  expect(requests[0]).toMatchObject({ connectionUuid: "conn", turnUuid: creation.turnUuid, coalescedCount: 1 });
  expect(requests).toHaveLength(3);
  expect(requests[1]).toEqual(requests[2]);
  expect(requests[1]).toMatchObject({ turnUuid: creation.turnUuid, backendSessionId: "backend", usage: { inputTokens: 1, outputTokens: 2 } });
});
