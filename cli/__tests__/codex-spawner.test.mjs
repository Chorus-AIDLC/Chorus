import { describe, it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSpawner, buildCodexArgs, resolveCodexPath, hasChorusMcpServer } from "../codex-spawner.mjs";
import { killProcessTree } from "../process-killer.mjs";
import { getProcessStopHook } from "../process-stop-hooks.mjs";
import { getThreadId, setThreadId } from "../codex-session-map.mjs";
import { appServerChild } from "./fixtures/codex-app-server-child.mjs";

const ANCHOR = "11111111-1111-4111-8111-111111111111";
const TID = "thread-1";
const silent = { info() {}, warn() {}, error() {} };
const methods = (child) => child.requests.map((r) => r.method).filter(Boolean);
function makeSpawner(child = appServerChild(), opts = {}) {
  return new CodexSpawner({
    codexPath: "/fake/codex", spawnImpl: vi.fn(() => child),
    logger: silent, env: { PATH: "/bin" }, platform: "linux", permissionMode: "yolo",
    getThreadIdFn: () => null, setThreadIdFn: vi.fn(), getUsageSnapshotFn: () => null,
    setUsageSnapshotFn: vi.fn(), hasChorusMcpServerFn: () => true,
    cleanupTimeoutMs: 40, stdioGraceMs: 5, inactivityTimeoutMs: 100,
    rpcLimits: { initializeTimeoutMs: 50, threadSetupTimeoutMs: 50, turnStartTimeoutMs: 50 },
    ...opts,
  });
}
const wake = (spawner, extra = {}) => spawner.wake({ prompt: "private prompt", sessionId: ANCHOR, ...extra });
async function until(fn) { await vi.waitFor(() => expect(fn()).toBeTruthy(), { timeout: 1000, interval: 1 }); }

describe("resolveCodexPath", () => {
  const isFile = (set) => (p) => set.has(p);

  it("honors CHORUS_CODEX_PATH override when it is a file", () => {
    const env = { CHORUS_CODEX_PATH: "/opt/codex", PATH: "/usr/bin" };
    expect(resolveCodexPath({ env, platform: "linux", isFile: isFile(new Set(["/opt/codex"])) })).toBe("/opt/codex");
  });

  it("walks PATH for `codex` on POSIX", () => {
    const env = { PATH: "/a:/b" };
    expect(resolveCodexPath({ env, platform: "linux", isFile: isFile(new Set(["/b/codex"])) })).toBe("/b/codex");
  });

  it("prefers codex.cmd / codex.exe on Windows", () => {
    const env = { Path: "C:\\bin" };
    const got = resolveCodexPath({ env, platform: "win32", isFile: isFile(new Set(["C:\\bin\\codex.cmd"])) });
    expect(got).toBe("C:\\bin\\codex.cmd");
  });

  it("returns null when nothing resolves", () => {
    expect(resolveCodexPath({ env: { PATH: "/x" }, platform: "linux", isFile: () => false })).toBeNull();
  });
});

describe("hasChorusMcpServer", () => {
  it("detects the configured Chorus MCP section", () => {
    const readFile = vi.fn(() => '[mcp_servers.chorus]\nurl = "https://chorus.test/api/mcp"\n');
    expect(hasChorusMcpServer({ env: { CODEX_HOME: "/codex" }, readFile })).toBe(true);
    expect(readFile).toHaveBeenCalledWith("/codex/config.toml", "utf8");
  });

  it("returns false for missing, unreadable, or unrelated config", () => {
    expect(hasChorusMcpServer({ readFile: () => '[mcp_servers.other]\nurl = "x"\n' })).toBe(false);
    expect(hasChorusMcpServer({ readFile: () => { throw new Error("missing"); } })).toBe(false);
  });

  it.each([true, false])("configured=%s: repeated successful wakes have only the expected missing-config warning", async configured => {
    const records = [];
    const logger = Object.fromEntries(["info", "warn", "error"].map(level => [level, message => records.push({ level, message })]));
    const probe = vi.fn(() => configured);
    const spawner = makeSpawner(undefined, { logger, hasChorusMcpServerFn: probe, spawnImpl: () => appServerChild() });
    expect((await wake(spawner)).exitCode).toBe(0);
    expect((await wake(spawner)).exitCode).toBe(0);
    expect(probe).toHaveBeenCalledTimes(1);
    const warnings = records.filter(r => r.level === "warn");
    expect(warnings).toHaveLength(configured ? 0 : 1);
    if (!configured) expect(warnings[0].message).toContain("no [mcp_servers.chorus]");
    expect(records.filter(r => r.level === "error")).toEqual([]);
    expect(records.filter(r => r.message.endsWith("App Server: CLOSED"))).toEqual([
      { level: "info", message: "[Chorus] Codex App Server: CLOSED" },
      { level: "info", message: "[Chorus] Codex App Server: CLOSED" },
    ]);
  });
});

describe("App Server lifecycle", () => {
  it.each([false, true])("fresh/resume=%s keeps identity, cwd, credentials, policy and ordered RPC", async (resumed) => {
    const child = appServerChild();
    const spawner = makeSpawner(child, { getThreadIdFn: () => resumed ? TID : null,
      cliConfig: { args: ["-mliteral model", "-c", "model_reasoning_effort=high"], env: { CODEX_HOME: "/isolated" } },
      creds: { url: "https://chorus.test", apiKey: "secret", agentUuid: "agent-1" },
    });
    const onChild = vi.fn((c) => expect(getProcessStopHook(c)).toBeTypeOf("function"));
    const result = await wake(spawner, { cwd: "/tmp/项目 space", isNew: true, onChild });
    expect(result).toEqual({ sessionId: ANCHOR, backendSessionId: TID, isNew: !resumed, exitCode: 0 });
    expect(onChild).toHaveBeenCalledExactlyOnceWith(child);
    expect(getProcessStopHook(child)).toBeUndefined();
    const [, argv, opts] = spawner.spawnImpl.mock.calls[0];
    expect(argv).toEqual(["app-server", "--listen", "stdio://", "-c", 'model="literal model"', "-c", "model_reasoning_effort=high"]);
    expect(JSON.stringify(argv)).not.toMatch(/private prompt|secret/);
    expect(opts).toMatchObject({ cwd: "/tmp/项目 space", detached: true, shell: false, env: {
      CODEX_HOME: "/isolated", CHORUS_URL: "https://chorus.test", CHORUS_API_KEY: "secret", CHORUS_AGENT_PROFILE: "agent-1", CHORUS_DAEMON_HEADLESS: "1",
    } });
    expect(methods(child)).toEqual(["initialize", "initialized", resumed ? "thread/resume" : "thread/start", "turn/start"]);
    expect(child.requests[2].params).toMatchObject({ cwd: opts.cwd, sandbox: "danger-full-access", approvalPolicy: "never" });
    expect(child.requests[3].params).toMatchObject({ sandboxPolicy: { type: "dangerFullAccess" }, input: [{ type: "text", text: "private prompt", text_elements: [] }] });
    expect(spawner.setThreadIdFn).toHaveBeenCalledTimes(resumed ? 0 : 1);
  });

  it.each([false, true])("restricted new/resume=%s overrides historical permissions", async (resumed) => {
    const child = appServerChild();
    await wake(makeSpawner(child, { permissionMode: "chorus", getThreadIdFn: () => resumed ? TID : null }));
    expect(child.requests[2].params).toMatchObject({ sandbox: "read-only", approvalPolicy: "never" });
    expect(child.requests[3].params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
  });

  it("persists the authoritative setup response before turn/start", async () => {
    let saved = false;
    const child = appServerChild({ handler: (req) => { if (req.method === "turn/start") expect(saved).toBe(true); } });
    await wake(makeSpawner(child, { setThreadIdFn: () => { saved = true; } }));
  });

  it("uses only the exact verified history error, starts once, and emits one notice", async () => {
    const child = appServerChild({ handler(req, c) {
      if (req.method === "thread/resume") {
        c.send({ id: req.id, error: { code: -32600, message: "no rollout found for thread id old-thread" } }); return true;
      }
    } });
    const messages = [];
    const spawner = makeSpawner(child, { getThreadIdFn: () => "old-thread" });
    expect(await wake(spawner, { onMessage: (m) => messages.push(m) })).toMatchObject({ isNew: true, backendSessionId: TID, exitCode: 0 });
    expect(methods(child)).toEqual(["initialize", "initialized", "thread/resume", "thread/start", "turn/start"]);
    expect(messages.filter((m) => m.item?.text.includes("Previous Codex history"))).toHaveLength(1);
    expect(spawner.setThreadIdFn).toHaveBeenCalledExactlyOnceWith(ANCHOR, TID);
  });

  it.each(["no rollout found for thread id other", "authentication secret", "incompatible history", "thread not found: old-thread"])("does not fallback for an uncertain resume error: %s", async (message) => {
    const logger = { ...silent, error: vi.fn() };
    const child = appServerChild({ handler(req, c) {
      if (req.method === "thread/resume") { c.send({ id: req.id, error: { code: -32600, message } }); return true; }
    } });
    const spawner = makeSpawner(child, { logger, getThreadIdFn: () => "old-thread" });
    expect(await wake(spawner)).toMatchObject({ backendSessionId: "old-thread", isNew: false, exitCode: null });
    expect(methods(child)).not.toContain("thread/start");
    expect(spawner.setThreadIdFn).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(message);
  });

  it("preserves the old mapping when fresh fallback also fails", async () => {
    const child = appServerChild({ handler(req, c) {
      if (req.method.startsWith("thread/")) {
        c.send({ id: req.id, error: { code: -32600, message: req.method === "thread/resume" ? "no rollout found for thread id old-thread" : "private failure" } }); return true;
      }
    } });
    const spawner = makeSpawner(child, { getThreadIdFn: () => "old-thread" });
    expect(await wake(spawner)).toMatchObject({ backendSessionId: "old-thread", exitCode: null, isNew: false });
    expect(spawner.setThreadIdFn).not.toHaveBeenCalled();
    expect(methods(child).filter((m) => m === "thread/start")).toHaveLength(1);
  });

  it.each(["completed", "failed", "interrupted"])("classifies matched terminal %s independently of raw zero exit", async (status) => {
    const child = appServerChild({ handler(req, c) {
      if (req.method === "turn/start") { c.reply(req, { turn: { id: "turn-1" } }); c.terminal(status); return true; }
    } });
    expect((await wake(makeSpawner(child))).exitCode).toBe(status === "completed" ? 0 : 1);
  });

  it("zero process exit without terminal is failure", async () => {
    const child = appServerChild({ handler(req, c) {
      if (req.method === "turn/start") { c.reply(req, { turn: { id: "turn-1" } }); setImmediate(() => c.exit()); return true; }
    } });
    expect((await wake(makeSpawner(child))).exitCode).toBeNull();
  });

  it.each([false, true])("protocol corruption cannot become success before/after terminal (terminal first=%s)", async (terminalFirst) => {
    const child = appServerChild({ handler(req, c) {
      if (req.method === "turn/start") {
        c.reply(req, { turn: { id: "turn-1" } });
        if (terminalFirst) c.terminal();
        c.stdout.write("private malformed content\n"); return true;
      }
    } });
    expect((await wake(makeSpawner(child))).exitCode).toBeNull();
  });

  it("setup cancellation is registered before onChild and prevents all RPC startup", async () => {
    const child = appServerChild();
    let stopped;
    const result = await wake(makeSpawner(child), { onChild: (c) => { stopped = killProcessTree(c, { sigintTimeoutMs: 40 }); } });
    await stopped;
    expect(result.exitCode).toBe(130);
    expect(methods(child)).toEqual([]);
  });

  it.each(["initialize", "thread/start"])("stop during pending %s never submits turn/start", async (method) => {
    const child = appServerChild({ handler: (req) => req.method === method });
    const spawner = makeSpawner(child);
    const running = wake(spawner);
    await until(() => methods(child).includes(method));
    await killProcessTree(child, { sigintTimeoutMs: 30 });
    expect((await running).exitCode).toBe(130);
    expect(methods(child)).not.toContain("turn/start");
  });

  it("first interrupted turn persists its ID and fresh spawners resume it repeatedly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-t2-"));
    const path = join(dir, "map.json");
    try {
      for (let i = 0; i < 3; i++) {
        const child = appServerChild({ autoComplete: false });
        const spawner = makeSpawner(child, { getThreadIdFn: (a) => getThreadId(a, { path }), setThreadIdFn: (a, t) => setThreadId(a, t, { path }) });
        const running = wake(spawner);
        await until(() => methods(child).includes("turn/start"));
        await killProcessTree(child, { sigintTimeoutMs: 40 });
        expect((await running).exitCode).toBe(130);
        expect(getThreadId(ANCHOR, { path })).toBe(TID);
        expect(methods(child)[2]).toBe(i ? "thread/resume" : "thread/start");
        expect(methods(child).filter((m) => m === "turn/interrupt")).toHaveLength(1);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses observed turn ID to interrupt before the turn/start response arrives", async () => {
    let start;
    const child = appServerChild({ handler(req, c) {
      if (req.method === "turn/start") {
        start = req;
        c.send({ method: "turn/started", params: { threadId: TID, turn: { id: "turn-1" } } }); return true;
      }
      if (req.method === "turn/interrupt") {
        c.reply(req, {}); c.terminal("interrupted"); c.reply(start, { turn: { id: "turn-1" } }); return true;
      }
    } });
    const running = wake(makeSpawner(child));
    await until(() => start);
    await killProcessTree(child, { sigintTimeoutMs: 40 });
    expect((await running).exitCode).toBe(130);
    expect(child.requests.find((r) => r.method === "turn/interrupt").params).toEqual({ threadId: TID, turnId: "turn-1" });
  });

  it("completion racing user interrupt still returns a nonzero wake", async () => {
    let stopped;
    const child = appServerChild({ handler(req, c) {
      if (req.method === "turn/start") {
        c.reply(req, { turn: { id: "turn-1" } }); c.terminal();
        stopped = killProcessTree(c, { sigintTimeoutMs: 40 }); return true;
      }
    } });
    expect((await wake(makeSpawner(child))).exitCode).toBe(130);
    await stopped;
  });

  it.each(["getThreadIdFn", "setThreadIdFn"])("degrades %s IO failure and keeps the current turn with fixed diagnostics", async (store) => {
    const logger = { ...silent, error: vi.fn(), warn: vi.fn() };
    const child = appServerChild();
    const spawner = makeSpawner(child, { logger, [store]: () => { throw new Error("PRIVATE-STORE-SECRET"); } });
    expect(await wake(spawner)).toMatchObject({ exitCode: 0, backendSessionId: TID, isNew: true });
    expect(methods(child)).toContain("thread/start");
    expect(methods(child).filter(m => m === "turn/start")).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(store === "getThreadIdFn" ? "could not be read" : "future wake continuity"));
    expect(JSON.stringify([logger.error.mock.calls, logger.warn.mock.calls])).not.toContain("PRIVATE-STORE-SECRET");
  });

  it.each(["getUsageSnapshotFn", "setUsageSnapshotFn"])("contains %s IO failure with fixed diagnostics", async (store) => {
    const logger = { ...silent, error: vi.fn(), warn: vi.fn() };
    const child = appServerChild({ handler(req, c) {
      if (req.method === "turn/start") {
        c.reply(req, { turn: { id: "turn-1" } });
        c.send({ method: "thread/tokenUsage/updated", params: { threadId: TID, turnId: "turn-1", tokenUsage: { total: { inputTokens: 10 } } } });
        c.terminal(); return true;
      }
    } });
    const spawner = makeSpawner(child, { logger, ...(store === "getUsageSnapshotFn" ? { getThreadIdFn: () => TID } : {}), [store]: () => { throw new Error("PRIVATE-STORE-SECRET"); } });
    expect((await wake(spawner)).exitCode).toBeNull();
    expect(JSON.stringify([logger.error.mock.calls, logger.warn.mock.calls])).not.toContain("PRIVATE-STORE-SECRET");
    if (store !== "setUsageSnapshotFn") expect(methods(child)).not.toContain("turn/start");
  });

  it.each(["error", "nonzero", "timeout", "success"])("requires bounded Windows taskkill settlement: %s", async mode => {
    const child = appServerChild();
    child.pid = 456789;
    const tk = new EventEmitter();
    const logger = { ...silent, warn: vi.fn(), error: vi.fn() };
    const spawner = makeSpawner(child, {
      platform: "win32", logger, killOptions: { spawnImpl: () => {
        queueMicrotask(() => {
          if (mode === "error") tk.emit("error", new Error("PRIVATE-TASKKILL-SECRET"));
          if (mode === "nonzero") tk.emit("exit", 1);
          if (mode === "success") tk.emit("exit", 0);
        });
        return tk;
      } },
    });
    expect((await wake(spawner)).exitCode).toBe(mode === "success" ? 0 : null);
    expect(JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls])).not.toContain("PRIVATE-TASKKILL-SECRET");
    // An OS error may arrive after timeout/exit, before the stream close.
    expect(() => tk.emit("error", new Error("late"))).not.toThrow();
    tk.emit("close", mode === "success" ? 0 : 1);
    expect(tk.listenerCount("error")).toBe(0);
    expect(tk.listenerCount("exit")).toBe(0);
  });

  it("persists raw usage exactly once per observation without double normalization", async () => {
    const child = appServerChild({ handler(req, c) {
      if (req.method === "turn/start") {
        c.reply(req, { turn: { id: "turn-1" } });
        c.send({ method: "thread/tokenUsage/updated", params: { threadId: TID, turnId: "turn-1", tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 7 } } } });
        c.terminal(); return true;
      }
    } });
    const messages = [];
    const spawner = makeSpawner(child);
    expect((await wake(spawner, { onMessage: (m) => messages.push(m) })).exitCode).toBe(0);
    expect(spawner.setUsageSnapshotFn).toHaveBeenCalledExactlyOnceWith(ANCHOR, TID, { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 });
    expect(messages.find((m) => m.type === "turn.completed").usage.input_tokens).toBe(60);
  });

  it.each(["missing", "spawn", "incompatible"])("fails safely for %s CLI", async (mode) => {
    const child = appServerChild({ handler: (req, c) => { if (req.method === "initialize") { c.exit(2); return true; } } });
    const spawner = makeSpawner(child, mode === "missing" ? { codexPath: null, resolveCodexPathFn: () => null } : mode === "spawn" ? { spawnImpl: () => { throw new Error("secret path"); } } : {});
    const onChild = vi.fn();
    expect((await wake(spawner, { onChild })).exitCode).toBeNull();
    expect(onChild).toHaveBeenCalledTimes(mode === "incompatible" ? 1 : 0);
  });

  it("startup timeout is bounded", async () => {
    const child = appServerChild({ handler: () => true });
    expect((await wake(makeSpawner(child, { rpcLimits: { initializeTimeoutMs: 5 } }))).exitCode).toBeNull();
  });

  it("unrelated chatter cannot keep a stalled turn alive", async () => {
    const child = appServerChild({ autoComplete: false });
    const timer = setInterval(() => child.send({ method: "unrelated", params: {} }), 2);
    try { expect((await wake(makeSpawner(child, { inactivityTimeoutMs: 15 }))).exitCode).toBeNull(); }
    finally { clearInterval(timer); }
  });

  it("relevant progress permits a turn longer than the inactivity window", async () => {
    const child = appServerChild({ autoComplete: false });
    const running = wake(makeSpawner(child, { inactivityTimeoutMs: 25 }));
    await until(() => methods(child).includes("turn/start"));
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 8));
      child.send({ method: "item/agentMessage/delta", params: { threadId: TID, turnId: "turn-1", itemId: "a", delta: "x" } });
    }
    child.terminal();
    expect((await running).exitCode).toBe(0);
  });

  it.each(["item/commandExecution/requestApproval", "unknown/request", "item/tool/requestUserInput"])("headless server request %s is denied/failed and never prompts", async (method) => {
    const child = appServerChild({ handler(req, c) {
      if (req.method === "turn/start") {
        c.reply(req, { turn: { id: "turn-1" } }); c.send({ id: "server-1", method, params: {} }); return true;
      }
      if (req.id === "server-1") { if (method.includes("requestApproval")) c.terminal("failed"); return true; }
    } });
    expect((await wake(makeSpawner(child))).exitCode).not.toBe(0);
    const response = child.requests.find((r) => r.id === "server-1");
    if (method.includes("requestApproval")) expect(response.result).toEqual({ decision: "cancel" });
    else expect(response.error).toBeDefined();
  });

  it("real ChildProcess drains inherited pipes and requests bounded descendant cleanup", async () => {
    const program = `
      const {spawn}=require('node:child_process');
      require('node:readline').createInterface({input:process.stdin}).on('line', line=>{
        const r=JSON.parse(line); const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
        if(r.method==='initialize')send({id:r.id,result:{}});
        if(r.method==='thread/start')send({id:r.id,result:{thread:{id:'thread-1'}}});
        if(r.method==='turn/start'){
          send({id:r.id,result:{turn:{id:'turn-1'}}});
          send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
          spawn(process.execPath,['-e','setTimeout(()=>{},200)'],{stdio:['ignore',1,2]});
          process.exit(0);
        }
      });`;
    const killImpl = vi.fn();
    const spawner = makeSpawner(undefined, { killOptions: { killImpl }, cleanupTimeoutMs: 250, stdioGraceMs: 15,
      rpcLimits: { initializeTimeoutMs: 2000 },
      spawnImpl: (_command, _args, opts) => spawn(process.execPath, ["-e", program], opts),
    });
    const startedAt = Date.now();
    expect((await wake(spawner, { cwd: process.cwd() })).exitCode).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(killImpl).toHaveBeenCalledWith(expect.any(Number), "SIGKILL");
  });
});

describe("bounded stop and cleanup failures", () => {
  it("interrupt acknowledgement without terminal/exit uses only the original deadline", async () => {
    const child = appServerChild({ autoComplete: false, closeOnEnd: false, handler: (req, c) => {
      if (req.method === "turn/interrupt") { c.reply(req, {}); return true; }
    } });
    child.pid = 987654;
    const killImpl = vi.fn();
    const spawner = makeSpawner(child, { cleanupTimeoutMs: 5000, killOptions: { killImpl } });
    const running = wake(spawner);
    await until(() => methods(child).includes("turn/start"));
    const start = Date.now();
    await killProcessTree(child, { sigintTimeoutMs: 20, killImpl });
    expect((await running).exitCode).toBe(130);
    expect(Date.now() - start).toBeLessThan(250);
    expect(killImpl.mock.calls).toEqual([[-987654, "SIGKILL"]]);
    child.exit();
  });

  it("successful terminal cannot hide failed descendant cleanup", async () => {
    const child = appServerChild(); child.pid = 987655;
    const logger = { ...silent, error: vi.fn() };
    const spawner = makeSpawner(child, { logger, killOptions: { killImpl: () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); } } });
    expect((await wake(spawner)).exitCode).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("process-tree cleanup failed"));
  });

  it.each(["--oss", "--unknown=PRIVATE"])("unsupported %s fails visibly before spawn", async (arg) => {
    const logger = { ...silent, error: vi.fn() };
    const spawner = makeSpawner(undefined, { logger, cliConfig: { args: [arg] } });
    expect((await wake(spawner)).exitCode).toBeNull();
    expect(spawner.spawnImpl).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("UNSUPPORTED_DAEMON_ARGS"));
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("PRIVATE");
  });
});
