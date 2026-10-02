// cli/__tests__/pi-spawner.test.mjs
// Covers the daemon-pi-rpc + pi-daemon-backend specs (OpenSpec change
// switch-pi-daemon-to-rpc): `pi --mode rpc --session-id <anchor>` per wake,
// get_state → one prompt → stdin held open until agent_settled, the handled-without-run
// idle check, rejected prompts, protocol-frame filtering, extension-dialog cancel,
// the protocol stop hook, continuity (isNew + lost-history notice), the version gate,
// cross-platform exec resolution and never-throw-into-the-wake-path failure handling.
//
// Recorded frames live in fixtures/pi-rpc/*.json (provenance: live pi 0.85.1 capture
// or labelled synthetic). A fixture's `writes` are what the CAPTURE client sent; the
// replay below drives the real spawner and asserts ITS writes.
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PiSpawner,
  PiRpcChannel,
  buildPiArgs,
  parsePiVersion,
  resolvePiPath,
  resolveSpawnCommand,
  MIN_PI_VERSION,
  PI_CONTINUITY_NOTICE,
} from "../pi-spawner.mjs";
import { getProcessStopHook } from "../process-stop-hooks.mjs";

const ANCHOR = "11111111-1111-4111-8111-111111111111";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pi-rpc");
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
const QUIET = { info() {}, warn() {}, error() {} };

/** A fake child process: stdin captures writes; stdout/stderr are emitters. */
function makeFakeChild() {
  const child = new EventEmitter();
  const stdinChunks = [];
  const stdin = new EventEmitter();
  stdin.writes = stdinChunks;
  stdin.writableEnded = false;
  stdin.write = (c) => stdinChunks.push(String(c));
  stdin.end = vi.fn(() => {
    stdin.writableEnded = true;
  });
  /** Parsed JSONL commands written so far. */
  stdin.commands = () => stdinChunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  child.stdin = stdin;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.pid = 4242;
  /** Emit one stdout frame as a JSONL line. */
  child.frame = (obj) => child.stdout.emit("data", JSON.stringify(obj) + "\n");
  return child;
}

const stateResponse = (id, data) => ({ id, type: "response", command: "get_state", success: true, data });
const promptOk = { id: "chorus-prompt-1", type: "response", command: "prompt", success: true };

/** Build a spawner whose spawnImpl returns our fake child; `spawned` resolves on spawn. */
function makeSpawner({ child, piPath = "/usr/bin/pi", creds, logger = QUIET, versionOut = "0.85.1\n", ...rest } = {}) {
  const calls = {};
  let markSpawned;
  const spawned = new Promise((r) => { markSpawned = r; });
  const spawnImpl = vi.fn((command, argv, opts) => {
    calls.command = command;
    calls.argv = argv;
    calls.opts = opts;
    markSpawned();
    return child;
  });
  const versionProbeFn = vi.fn(async () => versionOut);
  const spawner = new PiSpawner({
    piPath, spawnImpl, creds, platform: "linux", logger, versionProbeFn,
    env: {}, readdirImpl: () => [], ...rest,
  });
  return { spawner, spawnImpl, calls, spawned, versionProbeFn };
}

describe("buildPiArgs — RPC mode with the client-owned session-id anchor", () => {
  it("builds `--mode rpc --session-id <anchor>` with no -p, json mode or --no-session", () => {
    const args = buildPiArgs({ sessionId: ANCHOR });
    expect(args).toEqual(["--mode", "rpc", "--session-id", ANCHOR]);
    expect(args).not.toContain("-p");
    expect(args).not.toContain("json");
    expect(args).not.toContain("--no-session");
  });

  it("emits NO permission / sandbox flag (pi has no permission system)", () => {
    expect(buildPiArgs({ sessionId: ANCHOR }).join(" ")).not.toMatch(/permission|sandbox|approval/i);
  });
});

describe("resolvePiPath", () => {
  const isFile = (set) => (p) => set.has(p);

  it("honors CHORUS_PI_PATH override when it is a file", () => {
    const env = { CHORUS_PI_PATH: "/opt/pi", PATH: "/usr/bin" };
    expect(resolvePiPath({ env, platform: "linux", isFile: isFile(new Set(["/opt/pi"])) })).toBe("/opt/pi");
  });

  it("ignores CHORUS_PI_PATH when it is not a file (falls back to PATH walk)", () => {
    const env = { CHORUS_PI_PATH: "/opt/missing", PATH: "/a:/b" };
    expect(resolvePiPath({ env, platform: "linux", isFile: isFile(new Set(["/b/pi"])) })).toBe("/b/pi");
  });

  it("walks PATH for `pi` on POSIX", () => {
    const env = { PATH: "/a:/b" };
    expect(resolvePiPath({ env, platform: "linux", isFile: isFile(new Set(["/b/pi"])) })).toBe("/b/pi");
  });

  it("prefers pi.cmd / pi.exe on Windows", () => {
    const env = { Path: "C:\\bin" };
    const got = resolvePiPath({ env, platform: "win32", isFile: isFile(new Set(["C:\\bin\\pi.cmd"])) });
    expect(got).toBe("C:\\bin\\pi.cmd");
  });

  it("returns null when nothing resolves", () => {
    expect(resolvePiPath({ env: { PATH: "/x" }, platform: "linux", isFile: () => false })).toBeNull();
  });
});

describe("resolveSpawnCommand", () => {
  it("runs a Windows .cmd shim through cmd.exe /d /s /c", () => {
    const { command, argv } = resolveSpawnCommand("C:\\bin\\pi.cmd", ["--mode", "rpc"], "win32", {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    });
    expect(command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(argv).toEqual(["/d", "/s", "/c", "C:\\bin\\pi.cmd", "--mode", "rpc"]);
  });

  it("spawns a real POSIX binary directly", () => {
    const { command, argv } = resolveSpawnCommand("/usr/bin/pi", ["--mode", "rpc"], "linux");
    expect(command).toBe("/usr/bin/pi");
    expect(argv).toEqual(["--mode", "rpc"]);
  });
});


describe("parsePiVersion", () => {
  it("reads the first x.y.z", () => {
    expect(parsePiVersion("0.85.1\n")).toEqual([0, 85, 1]);
    expect(parsePiVersion("pi v1.2.3-beta")).toEqual([1, 2, 3]);
    expect(parsePiVersion("unknown")).toBeNull();
    expect(parsePiVersion(undefined)).toBeNull();
  });
});

describe("PiSpawner.wake — spawn orchestration", () => {
  const creds = { url: "https://chorus.test", apiKey: "cho_secret" };

  it("new wake: spawns `pi --mode rpc`, Chorus pair in env (never argv), get_state before the prompt", async () => {
    const child = makeFakeChild();
    const { spawner, calls, spawned } = makeSpawner({ child, creds });
    const onChild = vi.fn();
    const previousProfile = process.env.CHORUS_AGENT_PROFILE;
    delete process.env.CHORUS_AGENT_PROFILE;
    let result;
    try {
      const p = spawner.wake({ prompt: "do the thing", sessionId: ANCHOR, isNew: true, onChild });
      await spawned;
      // Only get_state goes out before its response arrives.
      expect(child.stdin.commands()).toEqual([{ id: "chorus-state-1", type: "get_state" }]);
      child.frame(stateResponse("chorus-state-1", { messageCount: 0, sessionFile: `/s/x_${ANCHOR}.jsonl` }));
      child.emit("close", 0);
      result = await p;
    } finally {
      if (previousProfile === undefined) delete process.env.CHORUS_AGENT_PROFILE;
      else process.env.CHORUS_AGENT_PROFILE = previousProfile;
    }

    expect(calls.argv).toEqual(["--mode", "rpc", "--session-id", ANCHOR]);
    expect(calls.argv.join(" ")).not.toContain("do the thing");
    expect(child.stdin.commands()[1]).toEqual({ id: "chorus-prompt-1", type: "prompt", message: "do the thing" });
    expect(calls.opts.env.CHORUS_URL).toBe("https://chorus.test");
    expect(calls.opts.env.CHORUS_API_KEY).toBe("cho_secret");
    expect(calls.opts.env.CHORUS_DAEMON_HEADLESS).toBe("1");
    expect(calls.opts.env.CHORUS_AGENT_PROFILE).toBeUndefined();
    expect(calls.argv.join(" ")).not.toContain("cho_secret");
    expect(calls.opts.detached).toBe(true);
    expect(calls.opts.shell).toBe(false);
    expect(onChild).toHaveBeenCalledTimes(1);
    expect(onChild).toHaveBeenCalledWith(child);
    expect(result).toMatchObject({ exitCode: 0, sessionId: ANCHOR, backendSessionId: ANCHOR, isNew: true });
  });

  it("appends operator args after the transport flags", async () => {
    const child = makeFakeChild();
    const { spawner, calls, spawned } = makeSpawner({ child, cliConfig: { args: ["--model", "m1"] } });
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR });
    await spawned;
    child.emit("close", 0);
    await p;
    expect(calls.argv).toEqual(["--mode", "rpc", "--session-id", ANCHOR, "--model", "m1"]);
  });

  it("declares the shared transcript probe is NOT authoritative for pi", () => {
    const { spawner } = makeSpawner({ child: makeFakeChild() });
    expect(spawner.sessionDecision).toEqual({ probeIsAuthoritative: false });
  });

  it("passes cwd through verbatim (including non-ASCII / spaces)", async () => {
    const child = makeFakeChild();
    const { spawner, calls, spawned } = makeSpawner({ child });
    const cwd = "/workspaces/项目 alpha";
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR, cwd });
    await spawned;
    child.emit("close", 0);
    await p;
    expect(calls.opts.cwd).toBe(cwd);
  });

  it("exports the agent identity as CHORUS_AGENT_PROFILE (uuid) when creds carry it", async () => {
    const child = makeFakeChild();
    const { spawner, calls, spawned } = makeSpawner({
      child,
      creds: { url: "https://chorus.test", apiKey: "cho_secret", agentUuid: "u-pi", agentName: "Pi" },
    });
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true });
    await spawned;
    child.emit("close", 0);
    await p;
    expect(calls.opts.env.CHORUS_AGENT_PROFILE).toBe("u-pi");
    expect(calls.argv.join(" ")).not.toContain("u-pi");
  });

  it("overwrites stale inherited Chorus connection values", async () => {
    const child = makeFakeChild();
    const { spawner, calls, spawned } = makeSpawner({ child, creds });
    const previousUrl = process.env.CHORUS_URL;
    const previousKey = process.env.CHORUS_API_KEY;
    process.env.CHORUS_URL = "https://stale.test";
    process.env.CHORUS_API_KEY = "cho_stale";
    try {
      const p = spawner.wake({ prompt: "x", sessionId: ANCHOR });
      await spawned;
      child.emit("close", 0);
      await p;
      expect(calls.opts.env.CHORUS_URL).toBe("https://chorus.test");
      expect(calls.opts.env.CHORUS_API_KEY).toBe("cho_secret");
    } finally {
      if (previousUrl === undefined) delete process.env.CHORUS_URL;
      else process.env.CHORUS_URL = previousUrl;
      if (previousKey === undefined) delete process.env.CHORUS_API_KEY;
      else process.env.CHORUS_API_KEY = previousKey;
    }
  });

  it("reassembles JSONL frames split across stdout chunks", async () => {
    const child = makeFakeChild();
    const { spawner, spawned } = makeSpawner({ child });
    const onMessage = vi.fn();
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR, onMessage });
    await spawned;
    const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [] } }) + "\r\n";
    child.stdout.emit("data", line.slice(0, 10));
    child.stdout.emit("data", line.slice(10));
    child.emit("close", 0);
    await p;
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0]).toMatchObject({ type: "message_end" });
  });

  it("keeps U+2028 / U+2029 inside a JSON string (LF-only framing)", async () => {
    const child = makeFakeChild();
    const { spawner, spawned } = makeSpawner({ child });
    const onMessage = vi.fn();
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR, onMessage });
    await spawned;
    const text = "a\u2028b\u2029c";
    child.frame({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    child.emit("close", 0);
    await p;
    expect(onMessage.mock.calls[0][0].message.content[0].text).toBe(text);
  });

  it("never throws and returns exitCode:null when the pi executable is unresolved", async () => {
    const child = makeFakeChild();
    const { spawner, spawnImpl, versionProbeFn } = makeSpawner({ child, piPath: null });
    spawner.resolvePiPathFn = () => null;
    const result = await spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(versionProbeFn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sessionId: ANCHOR, backendSessionId: null, exitCode: null });
  });

  it("resolves pi lazily via resolvePiPathFn when no piPath was supplied", async () => {
    const child = makeFakeChild();
    const { spawner, calls, spawned } = makeSpawner({ child, piPath: null });
    spawner.resolvePiPathFn = () => "/found/pi";
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR });
    await spawned;
    child.emit("close", 0);
    await p;
    expect(calls.command).toBe("/found/pi");
  });

  it("runs a Windows pi.cmd through cmd.exe without a shell and without detaching", async () => {
    const child = makeFakeChild();
    const { spawner, calls, spawned, versionProbeFn } = makeSpawner({
      child, piPath: "C:\\bin\\pi.cmd", platform: "win32", env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    });
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR });
    await spawned;
    child.emit("close", 0);
    await p;
    expect(calls.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(calls.argv).toEqual(["/d", "/s", "/c", "C:\\bin\\pi.cmd", "--mode", "rpc", "--session-id", ANCHOR]);
    expect(calls.opts).toMatchObject({ shell: false, detached: false, windowsHide: true });
    expect(versionProbeFn.mock.calls[0][0].argv).toEqual(["/d", "/s", "/c", "C:\\bin\\pi.cmd", "--version"]);
  });

  it("never throws when spawn itself throws (returns exitCode:null)", async () => {
    const spawner = new PiSpawner({
      piPath: "/usr/bin/pi",
      spawnImpl: () => {
        throw new Error("EACCES");
      },
      versionProbeFn: async () => "0.85.1",
      platform: "linux",
      logger: QUIET,
    });
    const result = await spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true });
    expect(result.exitCode).toBeNull();
  });

  it("tolerates a thrown onChild without escaping the wake path", async () => {
    const child = makeFakeChild();
    const { spawner, spawned } = makeSpawner({ child });
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true, onChild: () => { throw new Error("boom"); } });
    await spawned;
    child.emit("close", 0);
    expect((await p).exitCode).toBe(0);
  });

  it("an early non-zero exit keeps the raw exit code (no synthetic success)", async () => {
    const child = makeFakeChild();
    const warn = vi.fn();
    const { spawner, spawned } = makeSpawner({ child, logger: { info() {}, warn, error() {} } });
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR });
    await spawned;
    child.emit("close", 1);
    expect((await p).exitCode).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exited with code 1"));
  });

  it("a process error settles with exitCode:null and never throws", async () => {
    const child = makeFakeChild();
    const { spawner, spawned } = makeSpawner({ child });
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR });
    await spawned;
    child.emit("error", new Error("ENOENT"));
    expect(await p).toMatchObject({ exitCode: null, backendSessionId: ANCHOR });
  });
});

describe("PiSpawner.wake — RPC completion", () => {
  async function startWake(opts = {}) {
    const child = makeFakeChild();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { spawner, spawned } = makeSpawner({ child, logger, ...opts.spawnerOpts });
    const onMessage = vi.fn();
    const p = spawner.wake({ prompt: "go", sessionId: ANCHOR, isNew: opts.isNew ?? true, onMessage });
    await spawned;
    return { child, logger, onMessage, p };
  }

  it("keeps stdin open through prompt success and agent_end(willRetry), closes after agent_settled", async () => {
    const { child, p } = await startWake();
    child.frame(stateResponse("chorus-state-1", { messageCount: 0 }));
    child.frame(promptOk);
    child.frame({ type: "agent_start" });
    child.frame(stateResponse("chorus-state-2", { isStreaming: true }));
    child.frame({ type: "agent_end", messages: [], willRetry: true });
    expect(child.stdin.end).not.toHaveBeenCalled();
    child.frame({ type: "agent_start" });
    child.frame({ type: "agent_end", messages: [], willRetry: false });
    expect(child.stdin.end).not.toHaveBeenCalled();
    child.frame({ type: "agent_settled" });
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    child.emit("close", 0);
    expect((await p).exitCode).toBe(0);
    // exactly one prompt, and the idle check after it
    const cmds = child.stdin.commands();
    expect(cmds.filter((c) => c.type === "prompt")).toHaveLength(1);
    expect(cmds.map((c) => c.id)).toEqual(["chorus-state-1", "chorus-prompt-1", "chorus-state-2"]);
  });

  it("idle check isStreaming:false with no agent_start closes stdin (handled without a run)", async () => {
    const { child, logger, p } = await startWake();
    child.frame(stateResponse("chorus-state-1", { messageCount: 0 }));
    child.frame(promptOk);
    child.frame(stateResponse("chorus-state-2", { isStreaming: false }));
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("without an agent run"));
    child.emit("close", 0);
    expect((await p).exitCode).toBe(0);
  });

  it("skips the idle check when the run already settled before the prompt response was read", async () => {
    const { child, logger, p } = await startWake();
    child.frame(stateResponse("chorus-state-1", { messageCount: 0 }));
    child.frame({ type: "agent_start" });
    child.frame({ type: "agent_settled" });
    child.frame(promptOk);
    expect(child.stdin.commands().map((c) => c.id)).toEqual(["chorus-state-1", "chorus-prompt-1"]);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("dropped"));
    child.emit("close", 0);
    expect((await p).exitCode).toBe(0);
  });

  it("idle check isStreaming:false after agent_start leaves completion to agent_settled", async () => {
    const { child, p } = await startWake();
    child.frame(stateResponse("chorus-state-1", { messageCount: 0 }));
    child.frame(promptOk);
    child.frame({ type: "agent_start" });
    child.frame(stateResponse("chorus-state-2", { isStreaming: false }));
    expect(child.stdin.end).not.toHaveBeenCalled();
    child.frame({ type: "agent_settled" });
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    child.emit("close", 0);
    await p;
  });

  it("a failed idle check is logged and ignored", async () => {
    const { child, logger, p } = await startWake();
    child.frame(stateResponse("chorus-state-1", { messageCount: 0 }));
    child.frame(promptOk);
    child.frame({ id: "chorus-state-2", type: "response", command: "get_state", success: false, error: "busy" });
    expect(child.stdin.end).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("idle check failed"));
    child.frame({ type: "agent_settled" });
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    child.emit("close", 0);
    await p;
  });

  it("a rejected prompt is logged, closes stdin and settles non-zero although pi exits 0", async () => {
    const { child, logger, p } = await startWake();
    child.frame(stateResponse("chorus-state-1", { messageCount: 0 }));
    child.frame({ id: "chorus-prompt-1", type: "response", command: "prompt", success: false, error: "No API key" });
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("No API key"));
    child.emit("close", 0);
    expect((await p).exitCode).toBe(1);
  });

  it("a failed initial get_state still sends the prompt (continuity unknown, isNew = caller's value)", async () => {
    const { child, logger, p } = await startWake({ isNew: false });
    child.frame({ id: "chorus-state-1", type: "response", command: "get_state", success: false, error: "x" });
    expect(child.stdin.commands()[1]).toMatchObject({ type: "prompt" });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("continuity unknown"));
    child.emit("close", 0);
    expect((await p).isNew).toBe(false);
  });

  it("response and extension_ui_request frames are consumed; everything else is forwarded; extension_error warns", async () => {
    const { child, logger, onMessage, p } = await startWake();
    child.frame(stateResponse("chorus-state-1", { messageCount: 0 }));
    child.frame({ type: "extension_ui_request", id: "n1", method: "notify", message: "hi" });
    child.frame(promptOk);
    const assistant = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } };
    child.frame(assistant);
    child.frame({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: {}, isError: false });
    child.frame({ type: "extension_error", extensionPath: "/e.ts", event: "tool_call", error: "kaput" });
    child.frame({ type: "some_future_event" });
    child.emit("close", 0);
    await p;
    const types = onMessage.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(["message_end", "tool_execution_end", "extension_error", "some_future_event"]);
    expect(onMessage.mock.calls[0][0]).toEqual(assistant);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("kaput"));
  });

  it.each(["select", "confirm", "input", "editor"])("cancels a blocking %s dialog immediately, logging only the method", async (method) => {
    const { child, logger, p } = await startWake();
    child.frame({ type: "extension_ui_request", id: "d1", method, title: "SECRET-TITLE", message: "SECRET-MSG", options: ["a"] });
    expect(child.stdin.commands()).toContainEqual({ type: "extension_ui_response", id: "d1", cancelled: true });
    const logged = logger.warn.mock.calls.map((c) => c[0]).join("\n");
    expect(logged).toContain(`cancelled pi extension ${method} dialog`);
    expect(logged).not.toContain("SECRET");
    child.emit("close", 0);
    await p;
  });

  it.each(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"])("sends no reply for fire-and-forget %s", async (method) => {
    const { child, p } = await startWake();
    child.frame({ type: "extension_ui_request", id: "f1", method });
    expect(child.stdin.commands().some((c) => c.type === "extension_ui_response")).toBe(false);
    child.emit("close", 0);
    await p;
  });

  it("a write after stdin is gone is logged and never throws", async () => {
    const { child, logger, p } = await startWake();
    child.stdin.write = () => { throw new Error("EPIPE"); };
    child.frame(stateResponse("chorus-state-1", { messageCount: 0 }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("EPIPE"));
    child.stdin.emit("error", new Error("EPIPE async"));
    child.emit("close", 0);
    // The prompt was never delivered → not a success.
    expect((await p).exitCode).toBe(1);
  });
});

describe("PiSpawner.wake — continuity", () => {
  async function wakeWithState(data, { readdirImpl = () => [], isNew = true } = {}) {
    const child = makeFakeChild();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { spawner, spawned } = makeSpawner({ child, logger, readdirImpl });
    const onMessage = vi.fn();
    const p = spawner.wake({ prompt: "go", sessionId: ANCHOR, isNew, onMessage });
    await spawned;
    child.frame(stateResponse("chorus-state-1", data));
    const writesAfterState = child.stdin.commands();
    child.emit("close", 0);
    return { result: await p, logger, onMessage, writesAfterState };
  }

  it("messageCount > 0 reports isNew:false and no notice", async () => {
    const readdirImpl = vi.fn(() => []);
    const { result, onMessage } = await wakeWithState({ messageCount: 3, sessionFile: `/s/a_${ANCHOR}.jsonl` }, { readdirImpl, isNew: true });
    expect(result.isNew).toBe(false);
    expect(onMessage).not.toHaveBeenCalled();
    expect(readdirImpl).not.toHaveBeenCalled();
  });

  it("a first wake (no sibling file) reports isNew:true without a notice", async () => {
    const own = `2026-09-29T06-00-00-000Z_${ANCHOR}.jsonl`;
    const { result, onMessage, logger } = await wakeWithState(
      { messageCount: 0, sessionFile: `/s/${own}` }, { readdirImpl: () => [own, "other_22222222-2222-4222-8222-222222222222.jsonl"], isNew: false },
    );
    expect(result.isNew).toBe(true);
    expect(onMessage).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("could not be restored"));
  });

  it("a new session next to an older file for the same anchor warns and forwards one notice before the prompt", async () => {
    const own = `2026-09-29T06-00-00-000Z_${ANCHOR}.jsonl`;
    const old = `2026-09-20T01-00-00-000Z_${ANCHOR}.jsonl`;
    const readdirImpl = vi.fn(() => [old, own]);
    const { result, onMessage, logger, writesAfterState } = await wakeWithState({ messageCount: 0, sessionFile: `/s/dir/${own}` }, { readdirImpl });
    expect(readdirImpl).toHaveBeenCalledWith("/s/dir");
    expect(result.isNew).toBe(true);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0]).toEqual({
      type: "message_end", message: { role: "assistant", content: [{ type: "text", text: PI_CONTINUITY_NOTICE }] },
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(ANCHOR));
    // the prompt still goes out
    expect(writesAfterState.map((c) => c.type)).toEqual(["get_state", "prompt"]);
  });

  it("a session-dir listing error is logged and non-fatal", async () => {
    const readdirImpl = () => { const e = new Error("nope"); e.code = "EACCES"; throw e; };
    const { result, onMessage, logger, writesAfterState } = await wakeWithState({ messageCount: 0, sessionFile: `/s/x_${ANCHOR}.jsonl` }, { readdirImpl });
    expect(result.isNew).toBe(true);
    expect(onMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
    expect(writesAfterState.map((c) => c.type)).toEqual(["get_state", "prompt"]);
  });

  it("the extracted assistant text of the notice is what the transcript shows", async () => {
    const { extractTranscriptText } = await import("../upload-hooks.mjs");
    const own = `b_${ANCHOR}.jsonl`;
    const { onMessage } = await wakeWithState({ messageCount: 0, sessionFile: `/s/${own}` }, { readdirImpl: () => [`a_${ANCHOR}.jsonl`, own] });
    expect(extractTranscriptText(onMessage.mock.calls[0][0])).toEqual({ role: "assistant", text: PI_CONTINUITY_NOTICE });
  });
});

describe("PiSpawner — version gate", () => {
  it("refuses pi older than the minimum with a visible upgrade hint and no RPC spawn", async () => {
    const child = makeFakeChild();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { spawner, spawnImpl } = makeSpawner({ child, logger, versionOut: "0.80.3\n" });
    const result = await spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ exitCode: null, backendSessionId: null });
    const msg = logger.error.mock.calls[0][0];
    expect(msg).toContain("0.80.3");
    expect(msg).toContain(MIN_PI_VERSION);
    expect(msg).toContain("npm install -g @earendil-works/pi-coding-agent");
  });

  it("probes once per resolved path across wakes", async () => {
    const { spawner, versionProbeFn, spawnImpl } = makeSpawner({ child: makeFakeChild() });
    spawnImpl.mockImplementation(() => {
      const c = makeFakeChild();
      queueMicrotask(() => c.emit("close", 0));
      return c;
    });
    await spawner.wake({ prompt: "x", sessionId: ANCHOR });
    await spawner.wake({ prompt: "y", sessionId: ANCHOR });
    expect(versionProbeFn).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["unparseable output", async () => "weird"],
    ["a failed probe", async () => { throw new Error("ENOENT"); }],
  ])("%s warns and proceeds", async (_label, probe) => {
    const child = makeFakeChild();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { spawner, spawned } = makeSpawner({ child, logger, versionProbeFn: probe });
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR });
    await spawned;
    child.emit("close", 0);
    expect((await p).exitCode).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(MIN_PI_VERSION));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("accepts the minimum and newer versions", async () => {
    for (const v of ["0.85.0", "0.85.1", "1.0.0"]) {
      const child = makeFakeChild();
      const { spawner, spawned } = makeSpawner({ child, versionOut: v });
      const p = spawner.wake({ prompt: "x", sessionId: ANCHOR });
      await spawned;
      child.emit("close", 0);
      expect((await p).exitCode).toBe(0);
    }
  });
});

describe("PiSpawner — protocol stop hook", () => {
  async function startRunning({ running = true } = {}) {
    const child = makeFakeChild();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { spawner, spawned } = makeSpawner({ child, logger });
    const p = spawner.wake({ prompt: "go", sessionId: ANCHOR });
    await spawned;
    if (running) {
      child.frame(stateResponse("chorus-state-1", { messageCount: 0 }));
      child.frame(promptOk);
      child.frame({ type: "agent_start" });
    }
    return { child, logger, p, hook: getProcessStopHook(child) };
  }

  it("registers a stop hook for the child and unregisters it on settle", async () => {
    const { child, p, hook } = await startRunning();
    expect(typeof hook).toBe("function");
    child.emit("close", 0);
    await p;
    expect(getProcessStopHook(child)).toBeUndefined();
  });

  it("sends one abort, waits for agent_settled, awaits beforeClose, then closes stdin", async () => {
    const { child, p, hook } = await startRunning();
    const order = [];
    child.stdin.end.mockImplementation(() => { order.push("end"); child.stdin.writableEnded = true; });
    const beforeClose = vi.fn(async () => { order.push("beforeClose"); });
    const stop = hook({ deadline: Date.now() + 5000, protocolDeadline: Date.now() + 5000, reason: "interrupt", beforeClose });
    const again = hook({ deadline: Date.now() + 5000, protocolDeadline: Date.now() + 5000, reason: "interrupt", beforeClose });
    expect(again).toBe(stop);
    expect(child.stdin.commands().filter((c) => c.type === "abort")).toEqual([{ id: "chorus-abort-1", type: "abort" }]);
    await Promise.resolve();
    expect(child.stdin.end).not.toHaveBeenCalled();
    child.frame({ type: "agent_settled" }); // stop owns the close — not closed yet
    await stop;
    expect(order).toEqual(["beforeClose", "end"]);
    expect(beforeClose).toHaveBeenCalledTimes(1);
    child.emit("close", 0);
    // pi exits 0 on EOF; a cancelled run must not read as a clean finish (→ `ended` turn).
    expect((await p).exitCode).toBe(130);
  });

  it("the abort response also ends the wait", async () => {
    const { child, p, hook } = await startRunning();
    const stop = hook({ deadline: Date.now() + 5000, protocolDeadline: Date.now() + 5000 });
    child.frame({ id: "chorus-abort-1", type: "response", command: "abort", success: true });
    await stop;
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    child.emit("close", 0);
    await p;
  });

  it("an unresponsive child is released at the killer's protocol deadline (no other timer)", async () => {
    vi.useFakeTimers();
    try {
      const { child, p, hook } = await startRunning();
      const now = Date.now();
      const stop = hook({ deadline: now + 3000, protocolDeadline: now + 2000 });
      let done = false;
      stop.then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(1999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      expect(child.stdin.end).toHaveBeenCalledTimes(1);
      child.emit("close", 0);
      await p;
    } finally {
      vi.useRealTimers();
    }
  });

  it("child exit ends the wait", async () => {
    const { child, p, hook } = await startRunning();
    const stop = hook({ deadline: Date.now() + 5000, protocolDeadline: Date.now() + 5000 });
    child.emit("exit", 0);
    await stop;
    child.emit("close", 0);
    await p;
  });

  it("stop before the prompt never writes the prompt or an abort, but still awaits beforeClose", async () => {
    const { child, p, hook } = await startRunning({ running: false });
    const beforeClose = vi.fn(async () => {});
    const stop = hook({ deadline: Date.now() + 5000, protocolDeadline: Date.now() + 5000, beforeClose });
    // get_state answered after the stop latched: the prompt must not go out.
    child.frame(stateResponse("chorus-state-1", { messageCount: 0 }));
    await stop;
    const types = child.stdin.commands().map((c) => c.type);
    expect(types).toEqual(["get_state"]);
    expect(beforeClose).toHaveBeenCalledTimes(1);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    child.emit("close", 0);
    expect((await p).exitCode).toBe(130);
  });

  it("stop from inside onChild (cancel before spawn) sends no prompt and reports a cancel, not a failure", async () => {
    const child = makeFakeChild();
    const { spawner } = makeSpawner({ child });
    let stop;
    const p = spawner.wake({
      prompt: "go", sessionId: ANCHOR,
      onChild: (c) => { stop = getProcessStopHook(c)({ deadline: Date.now() + 5000, protocolDeadline: Date.now() + 5000 }); },
    });
    await vi.waitFor(() => expect(stop).toBeDefined());
    child.frame(stateResponse("chorus-state-1", { messageCount: 0 }));
    await stop;
    expect(child.stdin.commands().some((c) => c.type === "prompt")).toBe(false);
    child.emit("close", 0);
    expect((await p).exitCode).toBe(130);
  });

  it("stop after agent_settled skips the abort but still awaits beforeClose", async () => {
    const { child, p, hook } = await startRunning();
    child.frame({ type: "agent_settled" });
    const beforeClose = vi.fn(async () => {});
    await hook({ deadline: Date.now() + 5000, protocolDeadline: Date.now() + 5000, beforeClose });
    expect(child.stdin.commands().some((c) => c.type === "abort")).toBe(false);
    expect(beforeClose).toHaveBeenCalledTimes(1);
    child.emit("close", 0);
    // The run finished before the stop: still a clean exit.
    expect((await p).exitCode).toBe(0);
  });

  it("a non-zero raw exit wins over the cancel mapping", async () => {
    const { child, p, hook } = await startRunning();
    const stop = hook({ deadline: Date.now() + 5000, protocolDeadline: Date.now() + 5000 });
    child.emit("exit", 2);
    await stop;
    child.emit("close", 2);
    expect((await p).exitCode).toBe(2);
  });

  it("a failing beforeClose is logged and stdin still closes", async () => {
    const { child, logger, p, hook } = await startRunning();
    child.frame({ type: "agent_settled" });
    await hook({ deadline: Date.now() + 5000, protocolDeadline: Date.now() + 5000, beforeClose: async () => { throw new Error("capture failed"); } });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("capture failed"));
    expect(child.stdin.end).toHaveBeenCalled();
    child.emit("close", 0);
    await p;
  });
});

describe("PiSpawner — recorded fixtures (pi 0.85.1)", () => {
  it("every fixture declares provenance and pi version", () => {
    const names = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));
    expect(names.sort()).toEqual([
      "abort-running-tool.json", "extension-confirm-dialog.json", "handled-without-run.json",
      "new-session-turn.json", "rejected-prompt.json", "resumed-session-turn.json",
    ]);
    for (const n of names) {
      const f = JSON.parse(readFileSync(join(FIXTURES, n), "utf8"));
      expect(["live", "synthetic"]).toContain(f.provenance);
      expect(f.piVersion).toBe("0.85.1");
      expect(Array.isArray(f.frames)).toBe(true);
    }
  });

  /** Replay a fixture's stdout frames through the real spawner. */
  async function replay(name, { stop = false } = {}) {
    const fx = fixture(name);
    const child = makeFakeChild();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { spawner, spawned } = makeSpawner({ child, logger });
    const onMessage = vi.fn();
    const p = spawner.wake({ prompt: "fixture prompt", sessionId: ANCHOR, isNew: false, onMessage });
    await spawned;
    let stopPromise;
    let endedAfter = null;
    for (const frame of fx.frames) {
      if (stop && frame.type === "tool_execution_update" && !stopPromise) {
        stopPromise = getProcessStopHook(child)({ deadline: Date.now() + 5000, protocolDeadline: Date.now() + 5000 });
      }
      child.frame(frame);
      if (endedAfter === null && child.stdin.end.mock.calls.length) endedAfter = frame.type + (frame.id ? `:${frame.id}` : "");
    }
    if (stopPromise) {
      await stopPromise;
      if (endedAfter === null && child.stdin.end.mock.calls.length) endedAfter = "stop";
    }
    child.emit("close", fx.exitCode);
    const result = await p;
    const forwarded = onMessage.mock.calls.map((c) => c[0].type);
    return { fx, child, logger, result, forwarded, endedAfter, cmds: child.stdin.commands() };
  }

  it("new-session turn: isNew from get_state, stdin closed on agent_settled, protocol frames not forwarded", async () => {
    const { result, forwarded, endedAfter, cmds } = await replay("new-session-turn");
    expect(result).toMatchObject({ exitCode: 0, isNew: true });
    expect(endedAfter).toBe("agent_settled");
    expect(forwarded).not.toContain("response");
    expect(forwarded).not.toContain("extension_ui_request");
    expect(forwarded.at(-1)).toBe("agent_settled");
    expect(cmds.map((c) => c.id)).toEqual(["chorus-state-1", "chorus-prompt-1", "chorus-state-2"]);
  });

  it("resumed turn: messageCount > 0 → isNew:false; assistant text reaches the transcript", async () => {
    const { extractTranscriptText } = await import("../upload-hooks.mjs");
    const fx = fixture("resumed-session-turn");
    const { result, endedAfter } = await replay("resumed-session-turn");
    expect(result).toMatchObject({ exitCode: 0, isNew: false });
    expect(endedAfter).toBe("agent_settled");
    const texts = fx.frames.map(extractTranscriptText).filter(Boolean);
    expect(texts).toEqual([{ role: "assistant", text: "PONG1" }]);
  });

  it("abort during a running tool: one abort, stop closes stdin after agent_settled", async () => {
    const { result, cmds, endedAfter } = await replay("abort-running-tool", { stop: true });
    expect(cmds.filter((c) => c.type === "abort")).toEqual([{ id: "chorus-abort-1", type: "abort" }]);
    expect(endedAfter).toBe("stop");
    expect(result.exitCode).toBe(130);
  });

  it("handled without a run: the idle check closes stdin", async () => {
    const { result, endedAfter, forwarded } = await replay("handled-without-run");
    expect(endedAfter).toBe("response:chorus-state-2");
    expect(forwarded).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("extension confirm dialog: cancelled with the request id; run completes", async () => {
    const fx = fixture("extension-confirm-dialog");
    const dialog = fx.frames.find((f) => f.method === "confirm");
    const { cmds, endedAfter, result } = await replay("extension-confirm-dialog");
    expect(cmds).toContainEqual({ type: "extension_ui_response", id: dialog.id, cancelled: true });
    expect(endedAfter).toBe("agent_settled");
    expect(result.exitCode).toBe(0);
  });

  it("rejected prompt (synthetic): stdin closed, settles non-zero", async () => {
    const { result, endedAfter } = await replay("rejected-prompt");
    expect(endedAfter).toBe("response:chorus-prompt-1");
    expect(result.exitCode).toBe(1);
  });
});

describe("PiRpcChannel", () => {
  it("is exported for reuse and starts with get_state only", () => {
    const stdin = { writes: [], write(c) { this.writes.push(c); }, end() {} };
    const ch = new PiRpcChannel({ stdin, logger: QUIET, prompt: "p", anchor: ANCHOR, isNew: true });
    ch.start();
    expect(stdin.writes).toEqual([`${JSON.stringify({ id: "chorus-state-1", type: "get_state" })}\n`]);
  });
});
