// cli/__tests__/cli-session-sync-backends.test.mjs
// Backend adapters for `chorus agents run` session sync (OpenSpec change
// cli-agent-session-sync, design D3): Pi (caller-supplied id), Codex / TRAE (discovered
// App Server thread + ownership-keyed session map), Kiro (discovered session + ownership
// record + the daemon's real verifier). Every store is a fixture tree in a temp dir; the
// fixture record shapes mirror the installed CLIs (codex-cli 0.167.0, traecli 0.209.1,
// pi 1.3.0) and the repo's verified Kiro 2.12.1 shapes. Also: the exit budget and the
// `--idea --no-sync` parse fix from the core review.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { parseRunArgs, runAgentLaunch } from "../agent-launcher.mjs";
import { CliSessionSync, redactSecrets } from "../cli-session-sync.mjs";
import { getSessionSyncAdapter, normalizeAdapter } from "../cli-session-sync/index.mjs";
import { createPiAdapter, inspectPiArgs, piDefaultSessionDir, piDiskEntryToMessage } from "../cli-session-sync/pi.mjs";
import {
  createCodexFamilyAdapter, makeCodexInspector, scanRollouts, rolloutRoots, createRolloutMessageMapper, parseSessionMeta,
} from "../cli-session-sync/codex.mjs";
import { createKiroAdapter, inspectKiroArgs, scanKiroSessions } from "../cli-session-sync/kiro.mjs";
import { backendSessionKey } from "../backend-session-identity.mjs";
import { CODEX_FAMILY } from "../codex-family.mjs";
import { familySessionMap } from "../codex-session-map.mjs";
import { kiroSessionMap } from "../kiro-session-map.mjs";
import { CodexSpawner } from "../codex-spawner.mjs";
import { PiSpawner } from "../pi-spawner.mjs";
import { KiroSpawner } from "../kiro-spawner.mjs";
import { selectSpawner } from "../spawner-select.mjs";
import {
  recordKiroSessionOwnership, verifyKiroSessionOwnership, readKiroSessionOwnership,
} from "../kiro-session-ownership.mjs";
import { appServerChild } from "./fixtures/codex-app-server-child.mjs";

const SECRET = "cho_SUPERSECRET_backend_key";
const AGENT_UUID = "11111111-2222-4333-8444-555555555555";
const OTHER_AGENT = "66666666-2222-4333-8444-555555555555";
const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SESSION_UUID = "99999999-8888-4777-8666-555555555555";
const TURN_UUID = "12121212-3434-4565-8787-909090909090";
const KEY = backendSessionKey(SESSION_ID, AGENT_UUID);
const T1 = "01a1c08c-a600-7713-8c53-a1cec0e37473";
const T2 = "01a1c08f-3a7d-7f11-b785-9ecb6c248d4d";
const QUIET = { info() {}, warn() {}, error() {} };

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "chorus-sync-backends-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function memLogger() {
  const lines = [];
  const push = (level) => (m) => lines.push(`[${level}] ${redactSecrets(m, SECRET)}`);
  return { path: join(tmp, "sync.log"), lines, info: push("info"), warn: push("warn"), error: push("error") };
}

function ctxFor({ cwd = join(tmp, "work"), env = {}, inspection, launchedAt = Date.now() - 100, agentUuid = AGENT_UUID } = {}) {
  return { sessionId: SESSION_ID, sessionUuid: SESSION_UUID, agentUuid, cwd, env: { HOME: join(tmp, "home"), ...env }, platform: "linux", launchedAt, backendSessionId: null, inspection, logger: memLogger() };
}

function json(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}
function fakeServer(overrides = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ path, body });
    const route = path === "/api/daemon-sessions/cli" ? "register"
      : path.endsWith("/heartbeat") ? "heartbeat" : path.endsWith("/release") ? "release"
      : path === "/api/daemon/transcript" ? "transcript" : "unknown";
    if (overrides[route]) return overrides[route](body, init);
    const data = {
      register: { sessionUuid: SESSION_UUID, sessionId: SESSION_ID, turnUuid: TURN_UUID, leaseHolder: "h", heartbeatIntervalSec: 15, originBound: true, continuable: body.continuable ?? true },
      heartbeat: { originBound: true }, release: { released: true, deliveredTurnUuids: [] }, transcript: { appended: 1 },
    }[route];
    return json(200, { success: true, data });
  });
  const of = (route) => calls.filter((c) => (route === "register" ? c.path === "/api/daemon-sessions/cli"
    : route === "transcript" ? c.path === "/api/daemon/transcript" : c.path.endsWith(`/${route}`)));
  return { fetchImpl, calls, of };
}

function writeJsonl(file, entries) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

// ─── Codex / TRAE fixture stores ────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, "0");
function rolloutPath(root, id, at = new Date()) {
  const day = join(String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()));
  const ts = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
  return join(root, day, `rollout-${ts}-${id}.jsonl`);
}
function sessionMeta(id, cwd, { at = new Date(), originator = "codex-tui", source = "cli", extra = {} } = {}) {
  return { timestamp: at.toISOString(), type: "session_meta", payload: { session_id: id, id, timestamp: at.toISOString(), cwd, originator, cli_version: "0.167.0", source, thread_source: "user", base_instructions: { text: "x".repeat(70_000) }, ...extra } };
}
const codexUser = (id, text) => ({ type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id, content: [{ type: "text", text, text_elements: [] }] } } });
const codexAgent = (id, text) => ({ type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", id, content: [{ type: "Text", text }], phase: "final_answer" } } });
const codexNoise = [
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…</environment_context>" }] } },
  { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "skills" }] } },
  { type: "event_msg", payload: { type: "item_completed", item: { type: "Reasoning", id: "r1", summary: [] } } },
  { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "c1", command: "ls" } } },
  { type: "event_msg", payload: { type: "token_count", info: {} } },
];
const traeMutation = (items) => ({ type: "history_mutation", payload: { version: 1, operation: "append", display_completions: items.map((item) => ({ item })), items: [] } });

describe.each([
  ["codex", CODEX_FAMILY.codex, (home) => ({ CODEX_HOME: home }), (home) => join(home, "sessions")],
  ["trae", CODEX_FAMILY.trae, (home) => ({ TRAE_HOME: home }), (home) => join(home, "cli", "sessions")],
])("%s adapter", (agentType, profile, envFor, rootFor) => {
  let home; let root; let mapPath; let adapter; let cwd;
  beforeEach(() => {
    home = join(tmp, `.${agentType}`);
    root = rootFor(home);
    mapPath = join(tmp, "chorus", profile.sessionMapFile);
    cwd = join(tmp, "work");
    mkdirSync(cwd, { recursive: true });
    adapter = normalizeAdapter(createCodexFamilyAdapter(profile, { mapDeps: { path: mapPath } }));
  });
  const ctx = (o = {}) => {
    const c = ctxFor({ cwd, env: envFor(home), ...o });
    c.inspection = c.inspection ?? adapter.inspectArgs({ args: [], userArgs: [] });
    return c;
  };
  const map = () => (existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, "utf8")) : {});

  it("store roots honor the profile home env", () => {
    expect(rolloutRoots(profile, envFor(home), "linux")).toEqual([root]);
  });

  it("missing store → nothing discovered; finalize not continuable (no_session_discovered)", async () => {
    const c = ctx();
    expect(adapter.prepareArgs(["--model", "x"], c)).toEqual({ args: ["--model", "x"], backendSessionId: null, continuable: true });
    expect(await adapter.discoverSessionId(c)).toBeNull();
    expect(await adapter.finalize(c)).toEqual({ continuable: false, reason: "no_session_discovered" });
    expect(map()).toEqual({});
  });

  it("discovers the single new thread in the launch cwd, writes the ownership-keyed map entry, and tails it live", async () => {
    const c = ctx();
    // Pre-launch thread in the same cwd, a thread in another cwd, a daemon thread and a sub-agent thread: never candidates.
    const old = new Date(c.launchedAt - 60_000);
    writeJsonl(rolloutPath(root, "old-thread", old), [sessionMeta("old-thread", cwd, { at: old })]);
    writeJsonl(rolloutPath(root, "elsewhere"), [sessionMeta("elsewhere", join(tmp, "other"))]);
    writeJsonl(rolloutPath(root, "daemon-thread"), [sessionMeta("daemon-thread", cwd, { originator: "chorus" })]);
    writeJsonl(rolloutPath(root, "sub"), [sessionMeta("sub", cwd, { source: { subagent: { thread_spawn: { parent_thread_id: T1 } } } })]);
    expect(await adapter.discoverSessionId(c)).toBeNull(); // created lazily on the first message

    const file = rolloutPath(root, T1);
    const records = agentType === "codex"
      ? [sessionMeta(T1, cwd), ...codexNoise, codexUser("u1", "hello"), codexAgent("a1", "pong")]
      : [sessionMeta(T1, cwd, { originator: "traex-tui" }), traeMutation([{ type: "UserMessage", id: "u1", content: [{ type: "text", text: "hello" }] }]),
        traeMutation([{ type: "Reasoning", id: "r" }, { type: "AgentMessage", id: "a1", content: [{ type: "Text", text: "pong" }] }])];
    writeJsonl(file, records);
    expect(await adapter.discoverSessionId(c)).toBe(T1);
    expect(map()).toEqual({ [KEY]: T1 });
    c.backendSessionId = T1;
    const src = adapter.transcriptSource(c);
    expect(src.mode).toBe("live");
    expect(await src.next()).toEqual([{ role: "user", text: "hello" }, { role: "assistant", text: "pong" }]);
    writeJsonl(file, agentType === "codex" ? [codexAgent("a1", "pong"), codexUser("u2", "again")] : [traeMutation([{ type: "UserMessage", id: "u2", content: [{ type: "text", text: "again" }] }])]);
    expect(await src.next()).toEqual([{ role: "user", text: "again" }]); // duplicate item ids dropped
    expect(await adapter.finalize(c)).toEqual({ continuable: true, reason: null });
  });

  it("a subsequent daemon wake resumes the discovered thread (CodexSpawner reads the same keyed entry)", async () => {
    const c = ctx();
    writeJsonl(rolloutPath(root, T1), [sessionMeta(T1, cwd)]);
    expect(await adapter.discoverSessionId(c)).toBe(T1);
    expect((await adapter.finalize(c)).continuable).toBe(true);
    const sessions = familySessionMap(profile);
    const child = appServerChild({ threadId: T1 });
    const spawner = new CodexSpawner({
      profile, codexPath: "/fake/bin", spawnImpl: vi.fn(() => child), logger: QUIET, env: { PATH: "/bin" }, platform: "linux",
      permissionMode: "yolo", creds: { agentUuid: AGENT_UUID },
      getThreadIdFn: (k) => sessions.get(k, { path: mapPath }), setThreadIdFn: (k, v) => sessions.set(k, v, { path: mapPath }),
      getUsageSnapshotFn: () => null, setUsageSnapshotFn: vi.fn(), hasChorusMcpServerFn: () => true,
      cleanupTimeoutMs: 40, stdioGraceMs: 5, rpcLimits: { initializeTimeoutMs: 200, threadSetupTimeoutMs: 200, turnStartTimeoutMs: 200 },
    });
    const result = await spawner.wake({ prompt: "continue", sessionId: SESSION_ID, cwd });
    expect(result).toMatchObject({ isNew: false, backendSessionId: T1 });
    const methods = child.requests.map((r) => r.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
    expect(child.requests.find((r) => r.method === "thread/resume").params.threadId).toBe(T1);
  });

  it("two new threads in one cwd: waits; withdraws on ambiguity at exit; skips threads another run claimed", async () => {
    const c = ctx();
    writeJsonl(rolloutPath(root, T1), [sessionMeta(T1, cwd)]);
    writeJsonl(rolloutPath(root, T2), [sessionMeta(T2, cwd)]);
    expect(await adapter.discoverSessionId(c)).toBeNull();
    expect(await adapter.finalize(c)).toEqual({ continuable: false, reason: "ambiguous_session" });

    // A concurrent `chorus agents run` already claimed T2 under its own key → T1 is ours.
    mkdirSync(dirname(mapPath), { recursive: true });
    writeFileSync(mapPath, JSON.stringify({ "other-key": T2 }));
    const c2 = ctx();
    expect(await adapter.discoverSessionId(c2)).toBe(T1);
    expect((await adapter.finalize(c2)).continuable).toBe(true);
    expect(map()).toEqual({ "other-key": T2, [KEY]: T1 });

    // Race: a second thread appears after we bound (in-TUI new session / another terminal) → withdraw.
    rmSync(mapPath);
    const lone = join(tmp, "lone");
    mkdirSync(lone);
    const c3 = ctxFor({ cwd: lone, env: envFor(home), inspection: adapter.inspectArgs({ args: [], userArgs: [] }) });
    writeJsonl(rolloutPath(root, "x-1"), [sessionMeta("x-1", lone)]);
    expect(await adapter.discoverSessionId(c3)).toBe("x-1");
    writeJsonl(rolloutPath(root, "x-2"), [sessionMeta("x-2", lone)]);
    expect(await adapter.finalize(c3)).toEqual({ continuable: false, reason: "ambiguous_session" });
    expect(map()).toEqual({});
  });

  it("format drift fails soft: unparsable / foreign first lines and a half-written first line are skipped", async () => {
    const c = ctx();
    const garbage = rolloutPath(root, "garbage");
    mkdirSync(dirname(garbage), { recursive: true });
    writeFileSync(garbage, "{not json\n");
    writeJsonl(rolloutPath(root, "noid"), [{ type: "session_meta", payload: { cwd } }]);
    writeJsonl(rolloutPath(root, "turn"), [{ type: "turn_context", payload: {} }]);
    const partial = rolloutPath(root, T1);
    writeFileSync(partial, JSON.stringify(sessionMeta(T1, cwd)).slice(0, 500)); // no newline yet
    expect(await adapter.discoverSessionId(c)).toBeNull();
    writeFileSync(partial, JSON.stringify(sessionMeta(T1, cwd)) + "\n");
    expect(await adapter.discoverSessionId(c)).toBe(T1);
    expect(parseSessionMeta("[]", "p")).toBeNull();
    const mapper = createRolloutMessageMapper();
    expect(mapper({ type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "z", content: "str" } } })).toEqual([]);
    expect(mapper({ type: "history_mutation", payload: { display_completions: "nope" } })).toEqual([]);
    expect(mapper(null)).toEqual([]);
  });

  it("files untouched since before launch are not even opened", () => {
    const c = ctx();
    const file = rolloutPath(root, T1);
    writeJsonl(file, [sessionMeta(T1, cwd)]);
    const past = new Date(c.launchedAt - 3_600_000);
    utimesSync(file, past, past);
    const openSync = vi.fn(() => { throw new Error("should not open"); });
    const fs = { readdirSync: (d) => require_readdir(d), statSync: (p) => require_stat(p), openSync, readSync: vi.fn(), closeSync: vi.fn() };
    expect(scanRollouts({ roots: [root], cwd, launchedAt: c.launchedAt, fs })).toEqual([]);
    expect(openSync).not.toHaveBeenCalled();
  });

  it("user-chosen thread / cwd flags → registered not continuable, nothing bound", async () => {
    const inspect = makeCodexInspector(agentType);
    const flags = agentType === "codex"
      ? [["resume", T1], ["fork"], ["-C", "/x"], ["-C/x"], ["--cd=/x"], ["--worktree"], ["--remote", "ws://h:1"]]
      : [["resume"], ["--resume"], ["--resume", T1], ["--session-id", "n"], ["-w"], ["--worktree", "x"], ["-C", "/x"], ["--remote", "ws://h"]];
    for (const args of flags) {
      const v = inspect({ args, userArgs: args });
      expect(v, JSON.stringify(args)).toMatchObject({ sync: true, inject: false, continuable: false, reason: "user_session_flag" });
      const c = ctx({ inspection: v });
      writeJsonl(rolloutPath(root, `u-${args.join("")}`.replace(/[^A-Za-z0-9-]/g, "")), [sessionMeta(`u-${args.length}`, cwd)]);
      expect(adapter.prepareArgs(args, c).continuable).toBe(false);
      expect(await adapter.discoverSessionId(c)).toBeNull();
      expect((await adapter.finalize(c)).continuable).toBe(false);
    }
    expect(map()).toEqual({});
  });

  it("subcommands / info flags are not conversations; exec and plain prompts are", () => {
    const inspect = makeCodexInspector(agentType);
    for (const args of [["login"], ["mcp", "list"], ["--help"], ["-V"], ["-m", "o3", "doctor"], ["apply"]]) {
      expect(inspect({ args, userArgs: args }).sync, JSON.stringify(args)).toBe(false);
    }
    for (const args of [[], ["fix the bug"], ["-m", "review", "hi"], ["exec", "do it"], ["-c", "model=x"]]) {
      expect(inspect({ args, userArgs: args }), JSON.stringify(args)).toMatchObject({ sync: true, continuable: true, inject: false });
    }
    if (agentType === "trae") expect(inspect({ args: ["--acp"], userArgs: [] }).sync).toBe(false);
  });

  it("no agent uuid → cannot key the map → not continuable", () => {
    const c = ctx({ agentUuid: null });
    expect(adapter.prepareArgs([], c).continuable).toBe(false);
  });
});

// Real fs helpers for the "not opened" test (statSync/readdirSync pass-through).
import { readdirSync as realReaddir, statSync as realStat } from "node:fs";
const require_readdir = (d) => realReaddir(d);
const require_stat = (p) => realStat(p);

describe("codex/trae launcher end-to-end", () => {
  it.each(["codex", "trae"])("%s: discovers during the run, uploads the transcript, releases continuable, map keyed for the daemon", async (agentType) => {
    const profile = CODEX_FAMILY[agentType];
    const home = join(tmp, `.${agentType}`);
    const root = agentType === "codex" ? join(home, "sessions") : join(home, "cli", "sessions");
    const mapPath = join(tmp, "chorus", profile.sessionMapFile);
    const cwd = join(tmp, "work");
    const server = fakeServer();
    const spawnImpl = vi.fn((command, argv, options) => {
      const child = new EventEmitter();
      child.kill = vi.fn();
      setTimeout(() => writeJsonl(rolloutPath(root, T1), [sessionMeta(T1, options.cwd), codexUser("u", "hi"), codexAgent("a", "yo")]), 5);
      setTimeout(() => child.emit("close", 0, null), 60);
      return child;
    });
    const adapter = normalizeAdapter(createCodexFamilyAdapter(profile, { mapDeps: { path: mapPath } }));
    const code = await runAgentLaunch(["--name", "work", "--", "-m", "x"], {
      stdout: { write() {} }, stderr: { write() {} },
      env: { PATH: "/usr/bin", [profile.homeEnv]: home, HOME: join(tmp, "home") }, platform: "linux",
      loginPath: "/x/daemon.json", isFile: () => true, cwd, spawnImpl,
      readJson: () => ({ agents: [{ agentUuid: AGENT_UUID, agentName: "work", agentType, url: "https://c.example", apiKey: SECRET }] }),
      sessionSync: { fetchImpl: server.fetchImpl, logger: memLogger(), processRef: new EventEmitter(), host: "h", pollIntervalMs: 10, flushBudgetMs: 800, adapter },
    });
    expect(code).toBe(0);
    expect(spawnImpl.mock.calls[0][1]).toEqual(["-m", "x"]); // nothing injected
    expect(server.of("register")[0].body).toMatchObject({ agentType, continuable: true });
    expect(server.of("heartbeat").some((h) => h.body.backendSessionId === T1)).toBe(true);
    expect(server.of("transcript").flatMap((t) => t.body.messages)).toEqual([{ role: "user", text: "hi" }, { role: "assistant", text: "yo" }]);
    expect(server.of("release")[0].body.continuable).toBe(true);
    expect(JSON.parse(readFileSync(mapPath, "utf8"))).toEqual({ [KEY]: T1 });
  });
});

// ─── Pi ──────────────────────────────────────────────────────────────────────

describe("pi adapter", () => {
  const agentDir = () => join(tmp, "pi-agent");
  const cwd = () => join(tmp, "work");
  const ctx = (args = []) => {
    const c = ctxFor({ cwd: cwd(), env: { PI_CODING_AGENT_DIR: agentDir() } });
    c.inspection = inspectPiArgs({ args, userArgs: args });
    return c;
  };
  const adapter = () => normalizeAdapter(createPiAdapter());

  it("injects the daemon-derived key with --session-id; the daemon PiSpawner resumes the same id", async () => {
    const a = adapter();
    const c = ctx(["--model", "x"]);
    const planned = a.prepareArgs(["--model", "x"], c);
    expect(planned).toEqual({ args: ["--session-id", KEY, "--model", "x"], backendSessionId: KEY, continuable: true });

    // Daemon wake for the same Chorus session: same key on the same cwd-scoped store.
    const child = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    let argv;
    const spawner = new PiSpawner({
      piPath: "/usr/bin/pi", spawnImpl: vi.fn((cmd, av) => { argv = av; queueMicrotask(() => child.emit("close", 1)); return child; }),
      creds: { agentUuid: AGENT_UUID }, platform: "linux", logger: QUIET, versionProbeFn: async () => "1.3.0\n", env: {}, readdirImpl: () => [],
    });
    await spawner.wake({ prompt: "continue", sessionId: SESSION_ID, cwd: cwd(), isNew: false });
    expect(argv.slice(0, 4)).toEqual(["--mode", "rpc", "--session-id", planned.backendSessionId]);
  });

  it("user session flags → no injection, not continuable; subcommands/info → no sync", () => {
    for (const args of [["--session", "x"], ["--session-id", "x"], ["-c"], ["--continue"], ["-r"], ["--resume"], ["--fork", "a"], ["--no-session"], ["--session-dir", "/d"], ["hello", "-c"]]) {
      expect(inspectPiArgs({ args, userArgs: args }), JSON.stringify(args)).toMatchObject({ sync: true, inject: false, continuable: false, reason: "user_session_flag" });
    }
    for (const args of [["install", "x"], ["auth", "status"], ["--help"], ["-h"], ["-v"], ["--version"], ["--export", "f.html"], ["--list-models"]]) {
      expect(inspectPiArgs({ args, userArgs: args }).sync, JSON.stringify(args)).toBe(false);
    }
    for (const args of [[], ["fix it"], ["-nc", "hi"], ["-p", "do"], ["--model", "list"], ["--name", "-c"]]) {
      expect(inspectPiArgs({ args, userArgs: args }), JSON.stringify(args)).toMatchObject({ sync: true, inject: true, continuable: true });
    }
    expect(adapter().prepareArgs(["-c"], ctx(["-c"]))).toEqual({ args: ["-c"], backendSessionId: null, continuable: false });
  });

  it("tails the lazily-created `<ts>_<key>.jsonl` live and filters to user/assistant text", async () => {
    const a = adapter();
    const c = ctx();
    a.prepareArgs([], c);
    c.backendSessionId = KEY;
    const src = a.transcriptSource(c);
    expect(src.mode).toBe("live");
    expect(await src.next()).toEqual([]); // not written until the first message
    expect(await a.finalize(c)).toEqual({ continuable: false, reason: "no_transcript" });
    const file = join(piDefaultSessionDir(cwd(), agentDir()), `2026-11-09T13-43-25-000Z_${KEY}.jsonl`);
    writeJsonl(file, [
      { type: "session", version: 3, id: KEY, cwd: cwd() },
      { type: "model_change", id: "m" },
      { type: "message", message: { role: "system", content: "sys" } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "hello" }, { type: "toolCall", id: "t" }] } },
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ls output" }] } },
      { type: "custom_message", content: "ext" },
    ]);
    expect(await src.next()).toEqual([{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }]);
    appendFileSync(file, "{broken\n" + JSON.stringify({ type: "message", message: { role: "assistant", content: "bye" } }) + "\n");
    expect(await src.next()).toEqual([{ role: "assistant", text: "bye" }]);
    expect(await a.finalize(c)).toEqual({ continuable: true, reason: null });
    expect(piDiskEntryToMessage({ type: "message", message: null })).toBeNull();
  });

  it("finds sessions under a settings.json sessionDir", async () => {
    const a = adapter();
    const c = ctx();
    a.prepareArgs([], c);
    c.backendSessionId = KEY;
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(join(agentDir(), "settings.json"), JSON.stringify({ sessionDir: join(tmp, "custom") }));
    writeJsonl(join(tmp, "custom", `x_${KEY}.jsonl`), [{ type: "message", message: { role: "user", content: "q" } }]);
    expect(await a.transcriptSource(c).next()).toEqual([{ role: "user", text: "q" }]);
  });
});

// ─── Kiro ────────────────────────────────────────────────────────────────────

describe("kiro ownership + adapter", () => {
  const KSID = "540019be-35ec-4740-8880-a6c83f172646";
  const home = () => join(tmp, "home");
  const store = () => join(home(), ".kiro", "sessions", "cli");
  const ownPath = () => join(tmp, "chorus", "kiro-session-owners.json");
  const mapPath = () => join(tmp, "chorus", "kiro-sessions.json");
  const cwd = () => join(tmp, "work");
  const writeMeta = (id, o = {}) => {
    mkdirSync(store(), { recursive: true });
    writeFileSync(join(store(), `${id}.json`), JSON.stringify({ session_id: id, cwd: cwd(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...o }));
  };
  const adapter = () => normalizeAdapter(createKiroAdapter({ mapDeps: { path: mapPath() }, ownershipDeps: { path: ownPath() } }));
  const ctx = (args = []) => {
    const c = ctxFor({ cwd: cwd(), env: { HOME: home() } });
    c.inspection = inspectKiroArgs({ args, userArgs: args });
    return c;
  };

  it("verifier accepts same-agent same-anchor entries and rejects everything else", () => {
    writeMeta(KSID);
    const dir = store();
    const base = { agentUuid: AGENT_UUID, anchor: SESSION_ID, sessionKey: KEY, sessionId: KSID, cwd: cwd(), dir };
    expect(verifyKiroSessionOwnership(base, { path: ownPath() })).toBe(false); // no record
    expect(recordKiroSessionOwnership({ sessionId: KSID, agentUuid: AGENT_UUID, anchor: SESSION_ID, cwd: cwd() }, { path: ownPath() })).toBe(true);
    expect(readKiroSessionOwnership(KSID, { path: ownPath() })).toMatchObject({ agentUuid: AGENT_UUID, anchor: SESSION_ID, sessionKey: KEY });
    expect(verifyKiroSessionOwnership(base, { path: ownPath() })).toBe(true);
    expect(verifyKiroSessionOwnership({ ...base, agentUuid: OTHER_AGENT, sessionKey: backendSessionKey(SESSION_ID, OTHER_AGENT) }, { path: ownPath() })).toBe(false);
    expect(verifyKiroSessionOwnership({ ...base, anchor: "other-anchor", sessionKey: backendSessionKey("other-anchor", AGENT_UUID) }, { path: ownPath() })).toBe(false);
    expect(verifyKiroSessionOwnership({ ...base, sessionKey: "tampered" }, { path: ownPath() })).toBe(false);
    expect(verifyKiroSessionOwnership({ ...base, cwd: join(tmp, "elsewhere") }, { path: ownPath() })).toBe(false);
    expect(verifyKiroSessionOwnership({ ...base, dir: join(tmp, "nostore") }, { path: ownPath() })).toBe(false); // session vanished
    expect(verifyKiroSessionOwnership({ ...base, sessionId: "unknown" }, { path: ownPath() })).toBe(false);
    expect(recordKiroSessionOwnership({ sessionId: KSID }, { path: ownPath() })).toBe(false);
    writeFileSync(ownPath(), "[corrupt");
    expect(verifyKiroSessionOwnership(base, { path: ownPath() })).toBe(false);
  });

  it("discovers the root session created in the launch cwd, writes map + ownership, reconstructs on exit", async () => {
    const a = adapter();
    const c = ctx();
    expect(a.prepareArgs(["--agent", "chorus"], c)).toEqual({ args: ["--agent", "chorus"], backendSessionId: null, continuable: true });
    expect(await a.discoverSessionId(c)).toBeNull(); // missing store
    writeMeta("old", { created_at: new Date(c.launchedAt - 60_000).toISOString() });
    writeMeta("child", { parent_session_id: KSID });
    writeMeta("elsewhere", { cwd: join(tmp, "x") });
    writeFileSync(join(store(), "partial.json"), "{");
    expect(await a.discoverSessionId(c)).toBeNull();
    writeMeta(KSID);
    writeFileSync(join(store(), `${KSID}.jsonl`), [
      { version: 1, kind: "Prompt", data: { content: [{ kind: "text", data: "hi kiro" }] } },
      { version: 1, kind: "AssistantMessage", data: { content: [{ kind: "thinking", data: "…" }, { kind: "text", data: "hello" }, { kind: "toolUse", data: {} }] } },
      { version: 1, kind: "ToolResults", data: { content: [{ kind: "text", data: "tool out" }] } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n{bad\n");
    expect(await a.discoverSessionId(c)).toBe(KSID);
    expect(JSON.parse(readFileSync(mapPath(), "utf8"))).toEqual({ [KEY]: KSID });
    expect(readKiroSessionOwnership(KSID, { path: ownPath() })).toMatchObject({ agentUuid: AGENT_UUID, anchor: SESSION_ID });
    c.backendSessionId = KSID;
    const src = a.transcriptSource(c);
    expect(src.mode).toBe("on_exit");
    expect(await src.next()).toEqual([{ role: "user", text: "hi kiro" }, { role: "assistant", text: "hello" }]);
    expect(await src.next()).toEqual([]); // once
    expect(await a.finalize(c)).toEqual({ continuable: true, reason: null });

    // The daemon (production construction) now resumes it: real verifier, real map entry.
    const spawn = vi.fn(() => {
      const child = new EventEmitter();
      child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
      child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
      child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
      setTimeout(() => child.emit("close", 0), 1);
      return child;
    });
    const record = vi.fn((rec) => recordKiroSessionOwnership(rec, { path: ownPath() }));
    const spawner = new KiroSpawner({
      kiroPath: "/fake/kiro-cli", spawnImpl: spawn, creds: { agentUuid: AGENT_UUID }, env: { HOME: home() }, platform: "linux", logger: QUIET,
      getSessionIdFn: (k) => kiroSessionMap.get(k, { path: mapPath() }),
      verifySessionOwnershipFn: (o) => verifyKiroSessionOwnership(o, { path: ownPath() }),
      recordSessionOwnershipFn: record, reconstructTranscript: null,
    });
    const res = await spawner.wake({ prompt: "go", sessionId: SESSION_ID, cwd: cwd() });
    expect(res).toMatchObject({ isNew: false, backendSessionId: KSID });
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(["--resume-id", KSID]));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ sessionId: KSID, agentUuid: AGENT_UUID, anchor: SESSION_ID, sessionKey: KEY }));

    // Another agent with a forged map entry under its own key is refused.
    const foreignKey = backendSessionKey(SESSION_ID, OTHER_AGENT);
    kiroSessionMap.set(foreignKey, KSID, { path: mapPath() });
    const spawn2 = vi.fn(spawn.getMockImplementation());
    const foreign = new KiroSpawner({
      kiroPath: "/fake/kiro-cli", spawnImpl: spawn2, creds: { agentUuid: OTHER_AGENT }, env: { HOME: home() }, platform: "linux", logger: QUIET,
      getSessionIdFn: (k) => kiroSessionMap.get(k, { path: mapPath() }),
      verifySessionOwnershipFn: (o) => verifyKiroSessionOwnership(o, { path: ownPath() }), reconstructTranscript: null,
    });
    expect(await foreign.wake({ prompt: "go", sessionId: SESSION_ID, cwd: cwd() })).toMatchObject({ isNew: true });
    expect(spawn2.mock.calls[0][1]).not.toContain("--resume-id");
  });

  it("inspect: resume / headless flags are not continuable; subcommands and info flags are not synced", async () => {
    for (const args of [["--resume"], ["-r"], ["chat", "--resume-id", "x"], ["--resume-picker"]]) {
      expect(inspectKiroArgs({ args }), JSON.stringify(args)).toMatchObject({ sync: true, continuable: false, reason: "user_session_flag" });
    }
    expect(inspectKiroArgs({ args: ["chat", "--no-interactive", "hi"] })).toMatchObject({ continuable: false, reason: "headless_not_persisted" });
    for (const args of [["login"], ["mcp", "list"], ["--help"], ["-V"], ["chat", "--list-sessions"], ["doctor"]]) {
      expect(inspectKiroArgs({ args }).sync, JSON.stringify(args)).toBe(false);
    }
    for (const args of [[], ["chat"], ["chat", "--agent", "doctor"], ["--trust-all-tools"]]) {
      expect(inspectKiroArgs({ args }), JSON.stringify(args)).toMatchObject({ sync: true, continuable: true });
    }
    const a = adapter();
    const c = ctx(["--resume"]);
    writeMeta(KSID);
    expect(await a.discoverSessionId(c)).toBeNull();
    expect(await a.finalize(c)).toMatchObject({ continuable: false });
    expect(existsSync(mapPath())).toBe(false);
  });

  it("scanKiroSessions fails soft on an unreadable store", () => {
    expect(scanKiroSessions({ dir: join(tmp, "none"), cwd: cwd(), launchedAt: 0 })).toEqual([]);
    expect(scanKiroSessions({ dir: "x", cwd: cwd(), launchedAt: 0, readdir: () => ["a.json"], read: () => { throw new Error("EACCES"); } })).toEqual([]);
  });

  it("spawner-select wires a real (record-backed) verifier + recorder into KiroSpawner; opts still override", () => {
    const s = selectSpawner("kiro", { logger: QUIET, creds: { agentUuid: AGENT_UUID } });
    expect(typeof s.recordSessionOwnershipFn).toBe("function");
    // No record for a random id → refused (the real verifier, not the always-false default, decides).
    expect(s.verifySessionOwnershipFn({ agentUuid: AGENT_UUID, anchor: SESSION_ID, sessionId: "no-such-session", dir: store(), cwd: cwd() })).toBe(false);
    expect(s.verifySessionOwnershipFn.toString()).toMatch(/verifyKiroSessionOwnership/);
    const custom = () => true;
    expect(selectSpawner("kiro", { logger: QUIET, verifySessionOwnershipFn: custom }).verifySessionOwnershipFn).toBe(custom);
  });
});

// ─── Registry ────────────────────────────────────────────────────────────────

describe("adapter registry (all resumable backends)", () => {
  it.each([["pi", "pi"], ["codex", "codex"], ["trae", "trae"], ["kiro", "kiro"], ["claude-code", "claude-code"], ["dsh", "dsh"]])("%s → %s", (type, id) => {
    expect(getSessionSyncAdapter(type).id).toBe(id);
  });
  it("transcript modes per verified behavior", () => {
    const c = ctxFor({});
    c.inspection = { inject: true };
    c.backendSessionId = KEY;
    expect(getSessionSyncAdapter("pi").transcriptSource(c).mode).toBe("live");
  });
});

// ─── Core review fixes ───────────────────────────────────────────────────────

describe("core review fixes", () => {
  it("`--idea --no-sync` is a missing --idea value, never an idea named --no-sync", () => {
    expect(parseRunArgs(["--idea", "--no-sync"]).error).toMatch(/--idea needs a value/);
    expect(parseRunArgs(["--idea", "--"]).error).toMatch(/--idea needs a value/);
    expect(parseRunArgs(["--idea=--no-sync"]).error).toMatch(/--idea needs a value/);
    expect(parseRunArgs(["--no-sync", "--idea", "x"])).toMatchObject({ noSync: true, idea: "x" });
  });

  it("flush + finalize + release share ONE exit budget (hanging transcript AND release)", async () => {
    // Like a real fetch: never settles on its own, rejects when the request is aborted.
    const hang = (body, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    const server = fakeServer({ transcript: hang, release: hang });
    const adapter = normalizeAdapter({
      id: "fake",
      prepareArgs: (args) => ({ args, backendSessionId: "b", continuable: true }),
      transcriptSource: () => ({ mode: "on_exit", next: async () => [{ role: "assistant", text: "x" }] }),
      finalize: () => new Promise(() => {}),
    });
    const sync = new CliSessionSync({
      agent: { url: "https://c.example", apiKey: SECRET, agentUuid: AGENT_UUID }, agentType: "fake", cwd: "/w", childEnv: {},
      fetchImpl: server.fetchImpl, logger: memLogger(), adapter, stderr: { write() {} }, pollIntervalMs: 1000, heartbeatIntervalMs: 60_000,
      flushBudgetMs: 400, requestTimeoutMs: 5_000,
    });
    expect((await sync.register(["x"])).active).toBe(true);
    const started = Date.now();
    const res = await sync.finish();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(400 + 150);
    expect(res).toEqual({ released: false, continuable: false });
    expect(server.of("release")).toHaveLength(1);
  });
});
