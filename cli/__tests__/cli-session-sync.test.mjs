// cli/__tests__/cli-session-sync.test.mjs
// `chorus agents run` session sync (OpenSpec change cli-agent-session-sync): the sync
// core (cli/cli-session-sync.mjs), the Claude adapter (cli/cli-session-sync/claude.mjs),
// the adapter registry/contract, the JSONL tailer, and the launcher integration
// (--no-sync / --idea, register→spawn→heartbeat→flush→release, signals, failure
// posture, secret rule). Network is a fake in-memory server; the child is a fake
// EventEmitter; transcripts are real files in a temp CLAUDE_CONFIG_DIR.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { parseRunArgs, runAgentLaunch } from "../agent-launcher.mjs";
import {
  CliSessionSync,
  NO_DAEMON_WARNING,
  createSyncLogger,
  redactSecrets,
  syncLogPath,
} from "../cli-session-sync.mjs";
import { inspectClaudeArgs, claudeDiskEntryToMessage, createClaudeAdapter } from "../cli-session-sync/claude.mjs";
import { getSessionSyncAdapter, normalizeAdapter } from "../cli-session-sync/index.mjs";
import { createJsonlTail } from "../cli-session-sync/jsonl-tail.mjs";
import { backendSessionKey } from "../backend-session-identity.mjs";
import { ClaudeSpawner, transcriptPath } from "../claude-spawner.mjs";

const SECRET = "cho_SUPERSECRET_sync_key_never_print";
const AGENT_UUID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SESSION_UUID = "99999999-8888-4777-8666-555555555555";
const TURN_UUID = "12121212-3434-4565-8787-909090909090";
const IDEA = "0f0f0f0f-1e1e-4d2d-8c3c-4b4b4b4b4b4b";
const USER_SID = "deadbeef-0000-4000-8000-000000000001";

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "chorus-cli-sync-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** In-memory fake of the CLI session routes + transcript ingest. */
function fakeServer(overrides = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ path, body, auth: init.headers.Authorization });
    const route = path === "/api/daemon-sessions/cli" ? "register"
      : path.endsWith("/heartbeat") ? "heartbeat"
      : path.endsWith("/release") ? "release"
      : path === "/api/daemon/transcript" ? "transcript" : "unknown";
    const custom = overrides[route];
    if (custom) return custom(body, calls);
    const data = {
      register: { sessionUuid: SESSION_UUID, sessionId: SESSION_ID, turnUuid: TURN_UUID, leaseHolder: "holder-1", leaseTtlSec: 60, heartbeatIntervalSec: 15, leaseExpiresAt: "x", originBound: true, continuable: body.continuable ?? true },
      heartbeat: { leaseTtlSec: 60, heartbeatIntervalSec: 15, leaseExpiresAt: "x", originBound: true },
      release: { released: true, continuable: body.continuable, originBound: true, deliveredTurnUuids: [] },
      transcript: { appended: body.messages?.length ?? 0 },
    }[route];
    return json(data ? 200 : 404, data ? { success: true, data } : { success: false, error: { message: "nope" } });
  });
  const of = (route) => calls.filter((c) => (route === "register" ? c.path === "/api/daemon-sessions/cli"
    : route === "transcript" ? c.path === "/api/daemon/transcript" : c.path.endsWith(`/${route}`)));
  return { fetchImpl, calls, of };
}
function json(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function cap() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (s) => out.push(String(s)) },
    stderr: { write: (s) => err.push(String(s)) },
    out: () => out.join(""),
    err: () => err.join(""),
    errLines: () => err.join("").split("\n").filter(Boolean),
  };
}

/** Fake process for signal handlers. */
function fakeProcess() {
  const p = new EventEmitter();
  return p;
}

/**
 * Fake foreground spawn. `script(child, argv, options)` drives it; default: close(code)
 * on the next tick.
 */
function makeSpawn(script) {
  const calls = [];
  const spawnImpl = vi.fn((command, argv, options) => {
    const child = new EventEmitter();
    child.kill = vi.fn();
    calls.push({ command, argv, options, child });
    if (script) script(child, argv, options);
    else setTimeout(() => child.emit("close", 0, null), 0);
    return child;
  });
  return { spawnImpl, calls };
}

function memLogger() {
  const lines = [];
  const push = (level) => (m) => lines.push(`[${level}] ${redactSecrets(m, SECRET)}`);
  return { path: join(tmp, "sync.log"), lines, info: push("info"), warn: push("warn"), error: push("error") };
}

function launchOpts({ agentType = "claude-code", server = fakeServer(), spawn = makeSpawn(), sync = {}, env = {} } = {}) {
  const io = cap();
  const processRef = fakeProcess();
  const logger = memLogger();
  return {
    io, server, spawn, processRef, logger,
    o: {
      stdout: io.stdout,
      stderr: io.stderr,
      env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: join(tmp, "claude"), ...env },
      platform: "linux",
      loginPath: "/home/u/.chorus/daemon.json",
      readJson: () => ({ agents: [{ agentUuid: AGENT_UUID, agentName: "work", agentType, url: "https://chorus.example.com", apiKey: SECRET }] }),
      spawnImpl: spawn.spawnImpl,
      isFile: () => true,
      cwd: join(tmp, "work"),
      sessionSync: { fetchImpl: server.fetchImpl, logger, processRef, host: "host-1", pollIntervalMs: 10, flushBudgetMs: 500, ...sync },
    },
  };
}

const KEY = backendSessionKey(SESSION_ID, AGENT_UUID);

function claudeTranscriptFile(key, cwd) {
  return transcriptPath(key, cwd, { env: { CLAUDE_CONFIG_DIR: join(tmp, "claude") }, platform: "linux" });
}

function writeLines(file, entries) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

// ─── parseRunArgs ────────────────────────────────────────────────────────────

describe("parseRunArgs — sync flags", () => {
  it("parses --no-sync and --idea / --idea= before `--`", () => {
    expect(parseRunArgs(["--name", "w", "--no-sync"]).noSync).toBe(true);
    expect(parseRunArgs(["--idea", IDEA]).idea).toBe(IDEA);
    expect(parseRunArgs([`--idea=${IDEA}`]).idea).toBe(IDEA);
    expect(parseRunArgs([]).noSync).toBe(false);
  });

  it("never parses sync flags after `--` (passthrough stays verbatim)", () => {
    const p = parseRunArgs(["--name", "w", "--", "--no-sync", "--idea", IDEA]);
    expect(p.noSync).toBe(false);
    expect(p.idea).toBeUndefined();
    expect(p.passthrough).toEqual(["--no-sync", "--idea", IDEA]);
  });

  it("errors when --idea has no value", () => {
    expect(parseRunArgs(["--idea"]).error).toMatch(/--idea needs a value/);
    expect(parseRunArgs(["--idea="]).error).toMatch(/--idea needs a value/);
  });
});

// ─── --no-sync regression ────────────────────────────────────────────────────

describe("--no-sync is the historical launch", () => {
  it("makes zero Chorus calls, registers no signal handlers, and spawns identically", async () => {
    const a = launchOpts();
    const b = launchOpts();
    b.o.sessionSync = false;
    const argv = ["--name", "work", "--", "--model", "opus", "hello"];
    expect(await runAgentLaunch(["--no-sync", ...argv.slice(0, 2), ...argv.slice(2)], a.o)).toBe(0);
    expect(await runAgentLaunch(argv, b.o)).toBe(0);
    expect(a.server.fetchImpl).not.toHaveBeenCalled();
    expect(a.processRef.eventNames()).toEqual([]);
    const strip = ({ command, argv: av, options }) => ({ command, argv: av, options: { ...options, cwd: "X" } });
    expect(strip(a.spawn.calls[0])).toEqual(strip(b.spawn.calls[0]));
    expect(a.spawn.calls[0].argv).toEqual(["--model", "opus", "hello"]);
    expect(a.spawn.calls[0].options.stdio).toBe("inherit");
    expect(a.spawn.calls[0].options.shell).toBe(false);
    expect(a.io.err()).toBe("");
  });

  it("forwards exit codes and signal deaths unchanged", async () => {
    const code3 = launchOpts({ spawn: makeSpawn((c) => setTimeout(() => c.emit("close", 3, null), 0)) });
    expect(await runAgentLaunch(["--no-sync"], code3.o)).toBe(3);
    const sigint = launchOpts({ spawn: makeSpawn((c) => setTimeout(() => c.emit("close", null, "SIGINT"), 0)) });
    expect(await runAgentLaunch(["--no-sync"], sigint.o)).toBe(130);
    expect(code3.server.fetchImpl).not.toHaveBeenCalled();
    expect(sigint.server.fetchImpl).not.toHaveBeenCalled();
  });
});

// ─── Synced Claude launch ────────────────────────────────────────────────────

describe("synced Claude launch", () => {
  it("registers before spawn, injects backendSessionKey, heartbeats, and releases continuable", async () => {
    let registeredBeforeSpawn = false;
    const t = launchOpts({
      sync: { heartbeatIntervalMs: 5 },
      spawn: makeSpawn((child, argv, options) => {
        registeredBeforeSpawn = t.server.of("register").length === 1;
        // Claude creates its transcript under the injected id.
        writeLines(claudeTranscriptFile(argv[1], options.cwd), [{ type: "user", message: { role: "user", content: "hi" } }]);
        setTimeout(() => child.emit("close", 7, null), 40);
      }),
    });
    expect(await runAgentLaunch(["--name", "work", "--idea", IDEA, "--", "--model", "opus"], t.o)).toBe(7);
    expect(registeredBeforeSpawn).toBe(true);

    const [reg] = t.server.of("register");
    expect(reg.body).toEqual({ agentType: "claude-code", host: "host-1", cwd: join(tmp, "work"), continuable: true, ideaUuid: IDEA });
    expect(reg.auth).toBe(`Bearer ${SECRET}`);

    // Shared helper, exactly — not a reimplementation.
    expect(t.spawn.calls[0].argv).toEqual(["--session-id", KEY, "--model", "opus"]);

    const hbs = t.server.of("heartbeat");
    expect(hbs.length).toBeGreaterThanOrEqual(2);
    expect(hbs[0].path).toBe(`/api/daemon-sessions/cli/${SESSION_UUID}/heartbeat`);
    expect(hbs[0].body).toEqual({ leaseHolder: "holder-1", backendSessionId: KEY });
    expect(hbs.at(-1).body).toEqual({ leaseHolder: "holder-1" });

    const rel = t.server.of("release");
    expect(rel).toHaveLength(1);
    expect(rel[0].body).toMatchObject({ leaseHolder: "holder-1", continuable: true });
    expect(t.server.calls.at(-1).path).toMatch(/\/release$/);
    expect(t.io.err()).toBe("");
  });

  it("the daemon ClaudeSpawner resumes the SAME id the CLI injected", async () => {
    const t = launchOpts();
    await runAgentLaunch(["--name", "work"], t.o);
    const injected = t.spawn.calls[0].argv[1];

    const child = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    const daemonSpawn = vi.fn(() => child);
    const spawner = new ClaudeSpawner({
      claudePath: "/usr/bin/claude", spawnImpl: daemonSpawn, env: {}, platform: "linux",
      logger: { info() {}, warn() {}, error() {} }, creds: { agentUuid: AGENT_UUID, apiKey: SECRET, url: "https://x" },
    });
    const pending = spawner.wake({ prompt: "continue", sessionId: SESSION_ID, isNew: false, mcpConfigPath: "/m.json", cwd: join(tmp, "work") });
    child.emit("close", 0);
    const result = await pending;
    const argv = daemonSpawn.mock.calls[0][1];
    expect(argv[argv.indexOf("--resume") + 1]).toBe(injected);
    expect(result.backendSessionId).toBe(injected);
  });

  it("live-tails the Claude JSONL with the daemon's tool/thinking/synthetic filter and uploads to the CLI turn", async () => {
    const t = launchOpts({
      spawn: makeSpawn((child, argv, options) => {
        const file = claudeTranscriptFile(argv[1], options.cwd);
        writeLines(file, [
          { type: "queue-operation", operation: "enqueue", content: "x" },
          { type: "user", message: { role: "user", content: "fix the bug" }, origin: { kind: "human" } },
          { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret plan" }] } },
        ]);
        setTimeout(() => {
          // A half-written line followed by its completion later.
          appendFileSync(file, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }, { type: "text", text: "Looking" }] } }).slice(0, 30));
        }, 15);
        setTimeout(() => {
          const full = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }, { type: "text", text: "Looking" }] } });
          appendFileSync(file, full.slice(30) + "\n");
          writeLines(file, [
            { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }] }, toolUseResult: {} },
            { type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: …" }] } },
            { type: "user", promptSource: "system", origin: { kind: "task-notification" }, message: { role: "user", content: "<task-notification>x</task-notification>" } },
            { type: "user", message: { role: "user", content: "<local-command-stdout>ok</local-command-stdout>" } },
            { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent" }] } },
            { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fixed it." }] } },
          ]);
        }, 35);
        setTimeout(() => child.emit("close", 0, null), 60);
      }),
    });
    expect(await runAgentLaunch(["--name", "work"], t.o)).toBe(0);
    const uploads = t.server.of("transcript");
    expect(uploads.length).toBeGreaterThanOrEqual(2); // live, not only at exit
    for (const u of uploads) expect(u.body.turnUuid).toBe(TURN_UUID);
    expect(uploads.flatMap((u) => u.body.messages)).toEqual([
      { role: "user", text: "fix the bug" },
      { role: "assistant", text: "Looking" },
      { role: "assistant", text: "Fixed it." },
    ]);
    // Transcript uploads all land before the release.
    const order = t.server.calls.map((c) => c.path);
    expect(order.lastIndexOf("/api/daemon/transcript")).toBeLessThan(order.findIndex((p) => p.endsWith("/release")));
  });

  it("a user session/resume flag: nothing injected, registered + released continuable:false, one warning", async () => {
    const t = launchOpts();
    expect(await runAgentLaunch(["--name", "work", "--", "--resume", USER_SID, "--model", "x"], t.o)).toBe(0);
    expect(t.spawn.calls[0].argv).toEqual(["--resume", USER_SID, "--model", "x"]);
    expect(t.server.of("register")[0].body.continuable).toBe(false);
    expect(t.server.of("release")[0].body.continuable).toBe(false);
    expect(t.io.errLines()).toHaveLength(1);
    expect(t.io.err()).toMatch(/own session\/resume flag/);
  });

  it("a Claude subcommand / --version is not a conversation: zero Chorus calls", async () => {
    for (const tail of [["mcp", "list"], ["--version"], ["-v"]]) {
      const t = launchOpts();
      expect(await runAgentLaunch(["--name", "work", "--", ...tail], t.o)).toBe(0);
      expect(t.server.fetchImpl).not.toHaveBeenCalled();
      expect(t.spawn.calls[0].argv).toEqual(tail);
    }
  });

  it("releases continuable:false when Claude never wrote a transcript", async () => {
    const t = launchOpts();
    await runAgentLaunch(["--name", "work"], t.o);
    expect(t.server.of("release")[0].body.continuable).toBe(false);
    expect(t.server.of("release")[0].body.reason).toMatch(/no_transcript/);
  });
});

// ─── Failure posture ─────────────────────────────────────────────────────────

describe("failure posture", () => {
  it("404 on registration = server too old: one warning, unsynced launch, exit code forwarded", async () => {
    const server = fakeServer({ register: () => json(404, "<html>not found</html>") });
    const t = launchOpts({ server, spawn: makeSpawn((c) => setTimeout(() => c.emit("close", 5, null), 0)) });
    expect(await runAgentLaunch(["--name", "work", "--", "--model", "opus"], t.o)).toBe(5);
    expect(t.io.errLines()).toEqual(["warning: Chorus session sync unavailable (the Chorus server is too old for terminal session sync); launching unsynced"]);
    expect(t.spawn.calls[0].argv).toEqual(["--model", "opus"]);
    expect(server.calls.map((c) => c.path)).toEqual(["/api/daemon-sessions/cli"]);
    expect(t.processRef.eventNames()).toEqual([]);
  });

  it("network failure on registration: one warning, still launches", async () => {
    const server = fakeServer({ register: () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); } });
    const t = launchOpts({ server });
    expect(await runAgentLaunch(["--name", "work"], t.o)).toBe(0);
    expect(t.io.errLines()).toEqual(["warning: Chorus session sync unavailable (could not reach Chorus); launching unsynced"]);
    expect(t.spawn.calls).toHaveLength(1);
    expect(t.logger.lines.join("\n")).toMatch(/ECONNREFUSED/);
  });

  it("invalid --idea (400): one warning, still launches", async () => {
    const server = fakeServer({ register: () => json(400, { success: false, error: { message: "bad idea" } }) });
    const t = launchOpts({ server });
    expect(await runAgentLaunch(["--name", "work", "--idea", "nope"], t.o)).toBe(0);
    expect(t.io.errLines()).toHaveLength(1);
    expect(t.io.err()).toMatch(/--idea/);
  });

  it("no daemon serving the cwd: exactly the single no-daemon warning", async () => {
    const server = fakeServer({ register: () => json(200, { success: true, data: { sessionUuid: SESSION_UUID, sessionId: SESSION_ID, turnUuid: TURN_UUID, leaseHolder: "h", heartbeatIntervalSec: 15, originBound: false, continuable: true } }) });
    const t = launchOpts({ server });
    expect(await runAgentLaunch(["--name", "work"], t.o)).toBe(0);
    expect(t.io.err()).toBe(NO_DAEMON_WARNING);
    expect(t.io.errLines()).toHaveLength(1);
    expect(t.spawn.calls[0].argv[0]).toBe("--session-id");
  });

  it("flush is bounded: a hanging transcript endpoint delays exit by ≤ budget, prints one exit warning, still releases", async () => {
    const server = fakeServer({ transcript: () => new Promise(() => {}) });
    const t = launchOpts({
      server,
      sync: { flushBudgetMs: 150, requestTimeoutMs: 5000 },
      spawn: makeSpawn((child, argv, options) => {
        writeLines(claudeTranscriptFile(argv[1], options.cwd), [{ type: "user", message: { role: "user", content: "hello" } }]);
        setTimeout(() => child.emit("close", 0, null), 30);
      }),
    });
    const started = Date.now();
    let closedAt = 0;
    t.spawn.spawnImpl.mockName("spawn");
    const pending = runAgentLaunch(["--name", "work"], t.o);
    const code = await pending;
    closedAt = Date.now();
    expect(code).toBe(0);
    expect(closedAt - started).toBeLessThan(1500);
    expect(server.of("release")).toHaveLength(1);
    expect(t.io.errLines()).toHaveLength(1);
    expect(t.io.err()).toMatch(/could not upload the full transcript/);
  });

  it("a lost lease (409 heartbeat) stops heartbeats without touching the TTY", async () => {
    const server = fakeServer({ heartbeat: () => json(409, { success: false, error: { message: "stale" } }) });
    const t = launchOpts({ server, sync: { heartbeatIntervalMs: 5 }, spawn: makeSpawn((c) => setTimeout(() => c.emit("close", 0, null), 60)) });
    expect(await runAgentLaunch(["--name", "work"], t.o)).toBe(0);
    expect(server.of("heartbeat")).toHaveLength(1);
    expect(t.io.err()).toBe("");
    expect(t.logger.lines.join("\n")).toMatch(/lease lost/);
  });

  it("the API key never appears on stdout, stderr, or in the sync log", async () => {
    const server = fakeServer({ register: () => { throw new Error(`boom ${SECRET}`); } });
    const t = launchOpts({ server });
    await runAgentLaunch(["--name", "work"], t.o);
    const ok = launchOpts();
    await runAgentLaunch(["--name", "work"], ok.o);
    for (const x of [t, ok]) {
      expect(x.io.out() + x.io.err()).not.toContain(SECRET);
      expect(x.logger.lines.join("\n")).not.toContain(SECRET);
    }
  });
});

// ─── Signals ─────────────────────────────────────────────────────────────────

describe("signals", () => {
  it("SIGTERM is forwarded to the child; release happens; 128+15 is returned", async () => {
    const t = launchOpts({ spawn: makeSpawn((child) => { child.kill = vi.fn((sig) => setTimeout(() => child.emit("close", null, sig), 5)); }) });
    const pending = runAgentLaunch(["--name", "work"], t.o);
    await vi.waitFor(() => expect(t.spawn.calls).toHaveLength(1));
    t.processRef.emit("SIGTERM");
    expect(await pending).toBe(143);
    expect(t.spawn.calls[0].child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(t.server.of("release")).toHaveLength(1);
    expect(t.processRef.eventNames()).toEqual([]); // handlers removed
  });

  it("a child that ignores the signal: lease is released after the grace window anyway", async () => {
    const t = launchOpts({ sync: { signalGraceMs: 30 }, spawn: makeSpawn(() => {}) });
    const pending = runAgentLaunch(["--name", "work"], t.o);
    await vi.waitFor(() => expect(t.spawn.calls).toHaveLength(1));
    t.processRef.emit("SIGHUP");
    expect(await pending).toBe(129);
    expect(t.server.of("release")).toHaveLength(1);
    expect(t.server.of("release")[0].body.reason).toMatch(/signal:SIGHUP/);
  });

  it("the first SIGINT is not forwarded (the TTY already delivered it); a second one is", async () => {
    let child;
    const t = launchOpts({ spawn: makeSpawn((c) => { child = c; }) });
    const pending = runAgentLaunch(["--name", "work"], t.o);
    await vi.waitFor(() => expect(t.spawn.calls).toHaveLength(1));
    t.processRef.emit("SIGINT");
    expect(child.kill).not.toHaveBeenCalled();
    t.processRef.emit("SIGINT");
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    child.emit("close", null, "SIGINT");
    expect(await pending).toBe(130);
    expect(t.server.of("release")).toHaveLength(1);
  });
});

// ─── Claude arg planning ─────────────────────────────────────────────────────

describe("inspectClaudeArgs", () => {
  const verdict = (args, userArgs = args) => inspectClaudeArgs({ args, userArgs });

  it("plain conversation launches inject and stay continuable", () => {
    for (const args of [[], ["--model", "opus"], ["-p", "do it"], ["--name", "x", "prompt"], ["--", "-r"]]) {
      expect(verdict(args)).toMatchObject({ sync: true, inject: true, continuable: true });
    }
  });

  it.each([
    [["--resume"]], [["-r"]], [["--resume", USER_SID]], [[`--resume=${USER_SID}`]], [["-c"]], [["--continue"]],
    [["-pc", "x"]], [["--session-id", USER_SID]], [[`--session-id=${USER_SID}`]], [["--fork-session", "-r", USER_SID]],
    [["--from-pr", "12"]], [["--bg"]], [["--background"]], [["-w"]], [["--worktree", "feat"]],
  ])("identity/cwd flag %j → no inject, not continuable", (args) => {
    expect(verdict(args)).toMatchObject({ sync: true, inject: false, continuable: false, reason: "user_session_flag" });
  });

  it("captures an explicit user session id for read-only tailing", () => {
    expect(verdict(["--session-id", USER_SID])).toMatchObject({ userSessionId: USER_SID, userResume: false });
    expect(verdict(["-r", USER_SID])).toMatchObject({ userSessionId: USER_SID, userResume: true });
    expect(verdict(["-c"]).userSessionId).toBeNull();
  });

  it("subcommands and info flags are not conversations", () => {
    expect(verdict(["mcp", "list"]).sync).toBe(false);
    expect(verdict(["--model", "x", "doctor"], ["doctor"]).sync).toBe(false);
    expect(verdict(["--help"]).sync).toBe(false);
    expect(verdict(["-h"]).sync).toBe(false);
    expect(verdict(["--version"]).sync).toBe(false);
  });

  it("prepareArgs prepends --session-id <backendSessionKey(sessionId, agentUuid)>", () => {
    const adapter = normalizeAdapter(createClaudeAdapter());
    const inspection = adapter.inspectArgs({ args: ["--model", "x"], userArgs: [] });
    const ctx = { sessionId: SESSION_ID, agentUuid: AGENT_UUID, inspection, logger: memLogger() };
    expect(adapter.prepareArgs(["--model", "x"], ctx)).toEqual({ args: ["--session-id", KEY, "--model", "x"], backendSessionId: KEY, continuable: true });
  });
});

describe("claudeDiskEntryToMessage", () => {
  it("keeps human/assistant text and drops plumbing", () => {
    expect(claudeDiskEntryToMessage({ type: "user", message: { role: "user", content: "hi" } })).toEqual({ role: "user", text: "hi" });
    expect(claudeDiskEntryToMessage({ type: "user", isMeta: true, message: { role: "user", content: "skill" } })).toBeNull();
    expect(claudeDiskEntryToMessage({ type: "user", isCompactSummary: true, message: { role: "user", content: "s" } })).toBeNull();
    expect(claudeDiskEntryToMessage({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "a<system-reminder>x</system-reminder>" }] } })).toEqual({ role: "assistant", text: "a" });
    expect(claudeDiskEntryToMessage({ type: "attachment" })).toBeNull();
    expect(claudeDiskEntryToMessage({ type: "user", message: { role: "user", content: "<bash-stdout>x</bash-stdout>" } })).toBeNull();
  });

  it("renders slash-command invocation records readably and drops /exit (Claude Code 2.1.289 disk shape)", () => {
    const cmd = (name, args) => ({ type: "user", message: { role: "user", content: `<command-name>${name}</command-name>\n            <command-message>${name.slice(1)}</command-message>\n            <command-args>${args}</command-args>` } });
    expect(claudeDiskEntryToMessage(cmd("/exit", ""))).toBeNull();
    expect(claudeDiskEntryToMessage(cmd("/quit", ""))).toBeNull();
    expect(claudeDiskEntryToMessage(cmd("/model", "haiku"))).toEqual({ role: "user", text: "/model haiku" });
    expect(claudeDiskEntryToMessage(cmd("/chorus:develop", ""))).toEqual({ role: "user", text: "/chorus:develop" });
    expect(claudeDiskEntryToMessage({ type: "user", message: { role: "user", content: "see <command-name>/x</command-name> inline" } })).toEqual({ role: "user", text: "see <command-name>/x</command-name> inline" });
  });
});

// ─── Adapter contract / registry ─────────────────────────────────────────────

describe("adapter registry", () => {
  it("claude + claude-code map to the Claude adapter; others fall back to registration-only", () => {
    expect(getSessionSyncAdapter("claude-code").id).toBe("claude-code");
    expect(getSessionSyncAdapter("claude").id).toBe("claude-code");
    const fallback = getSessionSyncAdapter("opencode");
    expect(fallback.inspectArgs({ args: [], userArgs: [] })).toMatchObject({ sync: true, inject: false, continuable: false });
    expect(fallback.prepareArgs(["a"], {})).toEqual({ args: ["a"], backendSessionId: null, continuable: false });
    expect(fallback.transcriptSource({})).toBeNull();
  });

  it("a non-resumable backend registers + releases not continuable and passes argv through", async () => {
    const t = launchOpts({ agentType: "opencode" });
    expect(await runAgentLaunch(["--name", "work", "--", "run", "x"], t.o)).toBe(0);
    expect(t.spawn.calls[0].argv).toEqual(["run", "x"]);
    expect(t.server.of("register")[0].body).toMatchObject({ agentType: "opencode", continuable: false });
    expect(t.server.of("release")[0].body.continuable).toBe(false);
    expect(t.io.err()).toBe("");
  });

  it("the core drives discoverSessionId and on_exit sources for plug-in adapters", async () => {
    const next = vi.fn(async () => [{ role: "assistant", text: "done" }]);
    const discover = vi.fn(async () => "thread-42");
    const adapter = normalizeAdapter({
      id: "fake",
      prepareArgs: (args) => ({ args, backendSessionId: null, continuable: true }),
      discoverSessionId: discover,
      transcriptSource: () => ({ mode: "on_exit", next }),
    });
    const server = fakeServer();
    const sync = new CliSessionSync({
      agent: { url: "https://c.example", apiKey: SECRET, agentUuid: AGENT_UUID }, agentType: "fake", cwd: "/w", childEnv: {},
      fetchImpl: server.fetchImpl, logger: memLogger(), adapter, stderr: cap().stderr, pollIntervalMs: 5, heartbeatIntervalMs: 1000,
    });
    expect((await sync.register(["x"])).active).toBe(true);
    sync.started();
    await vi.waitFor(() => expect(discover).toHaveBeenCalled());
    await vi.waitFor(() => expect(server.of("heartbeat").some((h) => h.body.backendSessionId === "thread-42")).toBe(true));
    expect(next).not.toHaveBeenCalled(); // on_exit: read only at finish
    await sync.finish();
    expect(next).toHaveBeenCalledTimes(1);
    expect(server.of("transcript")[0].body).toEqual({ turnUuid: TURN_UUID, messages: [{ role: "assistant", text: "done" }] });
    expect(server.of("release")[0].body.continuable).toBe(true);
    // finish is idempotent
    await sync.finish();
    expect(server.of("release")).toHaveLength(1);
  });
});

// ─── JSONL tail / logger ─────────────────────────────────────────────────────

describe("createJsonlTail", () => {
  it("handles a missing file, partial lines, multi-byte splits, and truncation", () => {
    const file = join(tmp, "t.jsonl");
    const tail = createJsonlTail({ path: file });
    expect(tail.readNew()).toEqual([]);
    const line = JSON.stringify({ t: "héllo 世界" });
    const bytes = Buffer.from(line + "\n");
    writeFileSync(file, bytes.subarray(0, 12));
    expect(tail.readNew()).toEqual([]);
    appendFileSync(file, bytes.subarray(12));
    expect(tail.readNew()).toEqual([{ t: "héllo 世界" }]);
    appendFileSync(file, "not json\n" + JSON.stringify({ n: 2 }) + "\n");
    expect(tail.readNew()).toEqual([{ n: 2 }]);
    writeFileSync(file, JSON.stringify({ n: 3 }) + "\n");
    expect(tail.readNew()).toEqual([{ n: 3 }]);
  });

  it("startAt:end skips existing history", () => {
    const file = join(tmp, "h.jsonl");
    writeFileSync(file, JSON.stringify({ old: true }) + "\n");
    const tail = createJsonlTail({ path: file, startAt: "end" });
    appendFileSync(file, JSON.stringify({ fresh: true }) + "\n");
    expect(tail.readNew()).toEqual([{ fresh: true }]);
  });
});

describe("sync logger", () => {
  it("writes redacted lines to <home>/.chorus/logs/cli-session-sync.log", () => {
    const logger = createSyncLogger({ home: tmp, apiKey: SECRET });
    logger.warn(`failed with ${SECRET} and cho_otherToken123`);
    const path = syncLogPath(tmp);
    expect(path).toBe(join(tmp, ".chorus", "logs", "cli-session-sync.log"));
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text).toMatch(/\[warn\]/);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("cho_otherToken123");
  });

  it("never throws when the log cannot be written", () => {
    const logger = createSyncLogger({ home: tmp, appendFile: () => { throw new Error("EACCES"); } });
    expect(() => logger.error("x")).not.toThrow();
  });
});
