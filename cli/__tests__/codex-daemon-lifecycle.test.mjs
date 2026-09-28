// Cross-layer acceptance: actual Waker/control, spawner, maps, event adapter and
// upload hooks. Only child stdio and the HTTP boundary are synthetic.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { CodexSpawner } from "../codex-spawner.mjs";
import { Waker } from "../waker.mjs";
import { createControlHandler } from "../control-handler.mjs";
import { createTranscriptUploadHooks } from "../upload-hooks.mjs";
import { getThreadId, setThreadId } from "../codex-session-map.mjs";
import { getCodexUsageSnapshot, setCodexUsageSnapshot } from "../codex-usage-map.mjs";
import { appServerChild } from "./fixtures/codex-app-server-child.mjs";

const IDEA = "73333333-3333-4333-8333-333333333333";
const THREAD = "thread-live";
const creds = { url: "https://chorus.test", apiKey: "test-key" };
const silent = { info() {}, warn() {}, error() {} };
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function store() {
  const dir = mkdtempSync(join(tmpdir(), "chorus-app-lifecycle-"));
  dirs.push(dir);
  return { dir, sessions: join(dir, "sessions.json"), usage: join(dir, "usage.json") };
}
function harness(files, { handler, autoComplete = true, total = 100, threadId = THREAD, processId, spawnerOptions = {} } = {}) {
  const turns = [], uploads = [], interrupts = [];
  const child = appServerChild({ threadId, autoComplete, handler(req, c) {
    if (handler?.(req, c) === true) return true;
    if (req.method !== "turn/start" || !autoComplete) return;
    c.reply(req, { turn: { id: "turn-1" } });
    const item = { id: "answer-1", type: "agentMessage", text: "完整回答", phase: "final" };
    c.send({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-1", itemId: item.id, delta: "完整" } });
    c.send({ method: "item/completed", params: { threadId, turnId: "turn-1", item } });
    c.send({ method: "thread/tokenUsage/updated", params: { threadId, turnId: "turn-1", tokenUsage: { total: {
      inputTokens: total, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: total / 10,
    } } } });
    c.send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed", items: [item] } } });
    return true;
  } });
  if (processId) child.pid = processId;
  const spawner = new CodexSpawner({
    codexPath: "/fake/codex", spawnImpl: () => child, creds, logger: silent,
    hasChorusMcpServerFn: () => true, cleanupTimeoutMs: 100, stdioGraceMs: 20,
    getThreadIdFn: a => getThreadId(a, { path: files.sessions }),
    setThreadIdFn: (a, t) => setThreadId(a, t, { path: files.sessions }),
    getUsageSnapshotFn: (a, t) => getCodexUsageSnapshot(a, t, { path: files.usage }),
    setUsageSnapshotFn: (a, t, u) => setCodexUsageSnapshot(a, t, u, { path: files.usage }),
    ...spawnerOptions,
  });
  const hooks = createTranscriptUploadHooks({
    ...creds, logger: silent, batchDelayMs: 0,
    fetchImpl: vi.fn(async (_url, options) => {
      uploads.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
    }),
  });
  const waker = new Waker({
    creds, spawner, hooks, logger: silent, cwd: files.dir, sigintTimeoutMs: 100,
    lineage: { resolve: async () => ({ rootIdeaUuid: IDEA, directIdeaUuid: IDEA }) },
    writeMcpConfigFn: () => ({ path: "/unused.json", cleanup() {} }),
    isNewSessionFn: () => true,
    advanceTurn: async p => { turns.push(p); },
    reportInterrupt: async p => { interrupts.push(p); },
  });
  const control = createControlHandler({
    waker, getConnectionUuid: () => "connection", sigintTimeoutMs: 100, logger: silent,
  });
  async function wake() {
    const notification = { uuid: "notification", entityType: "task", entityUuid: "task",
      entityTitle: "Task", projectUuid: "project", action: "task_assigned", message: "",
      actorType: "user", actorUuid: "user", actorName: "Owner" };
    const resolved = await waker.keyFor(notification);
    return waker.wake(notification, resolved.key, resolved);
  }
  return { child, waker, control, wake, turns, uploads, interrupts };
}

describe("Codex App Server daemon lifecycle acceptance", () => {
  it.each(["already-gone", "descendant", "gone-race", "surviving-failure"])("Windows %s cleanup preserves the correct Waker outcome", async mode => {
    let descendantAlive = mode !== "already-gone";
    const root = { pid: 100, parentPid: 1, startedAt: "2026-09-28T10:00:00Z" };
    const descendant = { pid: 101, parentPid: 100, startedAt: "2026-09-28T10:00:01Z" };
    const targets = [];
    const h = harness(store(), { processId: 100, spawnerOptions: {
      platform: "win32", cleanupTimeoutMs: 100,
      killOptions: {
        windowsSnapshotImpl: async () => [
          ...(h.child.exitCode === null ? [root] : []),
          ...(descendantAlive ? [descendant] : []),
        ],
        spawnImpl: (cmd, args) => {
          targets.push({ cmd, pid: args[1], rootExit: h.child.exitCode });
          const tk = new EventEmitter();
          queueMicrotask(() => {
            if (mode !== "surviving-failure") descendantAlive = false;
            const code = mode === "descendant" ? 0 : 128;
            tk.emit("exit", code); tk.emit("close", code);
          });
          return tk;
        },
      },
    } });
    await h.wake();
    expect(h.turns.map(t => t.status)).toEqual(["running", mode === "surviving-failure" ? "interrupted" : "ended"]);
    if (mode === "already-gone") expect(targets).toEqual([]);
    else expect(targets).toEqual([{ cmd: "taskkill", pid: "101", rootExit: 0 }]);
    expect(h.interrupts).toHaveLength(mode === "surviving-failure" ? 1 : 0);
  });

  it("persists a first wake, deduplicates transcript, and resumes after daemon reconstruction with usage delta", async () => {
    const files = store();
    const first = harness(files);
    await first.wake();
    expect(first.turns.map(t => t.status)).toEqual(["running", "ended"]);
    expect(first.turns[1]).toMatchObject({ backendSessionId: THREAD, usage: { inputTokens: 100, outputTokens: 10, source: "codex" } });
    expect(first.uploads.flatMap(b => b.messages).filter(m => m.role === "assistant")).toHaveLength(1);
    expect(getThreadId(IDEA, { path: files.sessions })).toBe(THREAD);
    const restarted = harness(files, { total: 170 });
    await restarted.wake();
    expect(restarted.child.requests.filter(r => r.method.startsWith("thread/")).map(r => r.method)).toEqual(["thread/resume"]);
    expect(restarted.turns[1]).toMatchObject({ backendSessionId: THREAD, usage: { inputTokens: 70, outputTokens: 7 } });
    expect(restarted.child.requests.filter(r => r.method === "turn/start")).toHaveLength(1);
  });

  it("replaces explicitly unavailable history once and uploads exactly one continuity notice", async () => {
    const files = store();
    setThreadId(IDEA, "old-thread", { path: files.sessions });
    const h = harness(files, { handler(req, c) {
      if (req.method !== "thread/resume") return;
      c.send({ id: req.id, error: { code: -32600, message: "no rollout found for thread id old-thread" } });
      return true;
    } });
    await h.wake();
    expect(h.child.requests.filter(r => r.method.startsWith("thread/")).map(r => r.method)).toEqual(["thread/resume", "thread/start"]);
    expect(h.turns[1]).toMatchObject({ status: "ended", backendSessionId: THREAD });
    expect(JSON.stringify(h.uploads).match(/Previous Codex history could not be restored/g)).toHaveLength(1);
    expect(getThreadId(IDEA, { path: files.sessions })).toBe(THREAD);
  });

  it.each(["startup", "active", "shutdown"])("classifies %s cancellation through shared daemon control", async mode => {
    const files = store();
    const h = harness(files, { autoComplete: false, handler(req) {
      if (mode === "startup" && req.method === "initialize") return true;
    } });
    const running = h.wake();
    await vi.waitFor(() => expect(h.child.requests.some(r => r.method === (mode === "startup" ? "initialize" : "turn/start"))).toBe(true));
    if (mode === "shutdown") h.waker.interruptAll();
    else {
      h.control({ type: "control", command: "interrupt", targetConnectionUuid: "wrong", entityType: "idea", entityUuid: IDEA });
      expect(h.child.requests.some(r => r.method === "turn/interrupt")).toBe(false);
      h.control({ type: "control", command: "interrupt", targetConnectionUuid: "connection", entityType: "idea", entityUuid: IDEA });
    }
    await running;
    expect(h.turns.map(t => t.status)).toEqual(["running", "interrupted"]);
    expect(h.turns[1].interruptedReason).toBe(mode === "shutdown" ? "shutdown" : "user");
    expect(h.child.requests.filter(r => r.method === "turn/interrupt")).toHaveLength(mode === "startup" ? 0 : 1);
    expect(h.interrupts).toHaveLength(mode === "shutdown" ? 0 : 1);
    if (mode !== "startup") {
      expect(getThreadId(IDEA, { path: files.sessions })).toBe(THREAD);
      const resumed = harness(files);
      await resumed.wake();
      expect(resumed.turns[1].status).toBe("ended");
      expect(resumed.child.requests.some(r => r.method === "thread/resume")).toBe(true);
    }
  });

  it.each([0, 3])("missing terminal with process exit %i becomes one crash terminal", async code => {
    const h = harness(store(), { handler(req, c) {
      if (req.method !== "turn/start") return;
      c.reply(req, { turn: { id: "turn-1" } }); c.exit(code); return true;
    } });
    await h.wake();
    expect(h.turns.map(t => t.status)).toEqual(["running", "interrupted"]);
    expect(h.turns[1]).toMatchObject({ interruptedReason: "crash", backendSessionId: THREAD });
    expect(h.interrupts).toHaveLength(1);
  });
});
