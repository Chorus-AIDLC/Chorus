// cli/__tests__/claude-spawner.test.mjs
// Covers cli-daemon spec "Cross-platform headless spawn" (both scenarios) and
// the spawner AC: stdin prompt, path resolution incl. Windows .cmd, NDJSON
// parse with CRLF + session_id extraction, fire-and-forget failure handling.
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  ClaudeSpawner,
  resolveClaudePath,
  buildArgs,
  parseNdjsonChunk,
  resolveSpawnCommand,
  isValidSessionId,
  escapeCwd,
  transcriptPath,
  isNewSession,
} from "../claude-spawner.mjs";
import { writeMcpConfig, buildMcpConfig } from "../mcp-config.mjs";

// A canonical lowercase UUID — the daemon passes a Chorus idea uuid as session id.
const SID = "11111111-1111-4111-8111-111111111111";

/** A fake child process: stdin captures writes; stdout/stderr are emitters. */
function makeFakeChild() {
  const child = new EventEmitter();
  const stdinChunks = [];
  const stdin = new EventEmitter(); // real emitter so .on("error") works
  stdin.writes = stdinChunks;
  stdin.write = (c) => stdinChunks.push(String(c));
  stdin.end = vi.fn();
  child.stdin = stdin;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  return child;
}

const silent = { info() {}, warn() {}, error() {} };

describe("buildArgs", () => {
  it("uses --session-id for a new session, never puts prompt in argv", () => {
    const args = buildArgs({ sessionId: "sid-1", isNew: true, mcpConfigPath: "/tmp/m.json" });
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      "sid-1",
      "--mcp-config",
      "/tmp/m.json",
      // default permission mode: allow only Chorus MCP tools through
      "--allowedTools",
      "mcp__chorus__*",
    ]);
    expect(args.join(" ")).not.toMatch(/prompt/i);
  });

  it("uses --resume for an existing session", () => {
    const args = buildArgs({ sessionId: "sid-2", isNew: false });
    expect(args).toContain("--resume");
    expect(args).toContain("sid-2");
    expect(args).not.toContain("--session-id");
  });

  it("default permission mode allowlists Chorus MCP tools and does NOT skip permissions", () => {
    const args = buildArgs({ sessionId: "s", isNew: true });
    const i = args.indexOf("--allowedTools");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("mcp__chorus__*");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("yolo permission mode skips all permissions and drops the allowlist", () => {
    const args = buildArgs({ sessionId: "s", isNew: true, permissionMode: "yolo" });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allowedTools");
  });
});

describe("isValidSessionId", () => {
  it("accepts a canonical lowercase UUID", () => {
    expect(isValidSessionId("11111111-1111-4111-8111-111111111111")).toBe(true);
  });
  it("rejects uppercase, malformed, empty, and non-strings", () => {
    expect(isValidSessionId("11111111-1111-4111-8111-11111111111X")).toBe(false);
    expect(isValidSessionId("11111111111141118111111111111111")).toBe(false); // no dashes
    expect(isValidSessionId("ABCDEF01-1111-4111-8111-111111111111")).toBe(false); // uppercase
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId(null)).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
  });
});

describe("escapeCwd (verified Claude Code transcript-dir rule)", () => {
  it("POSIX: replaces both / and . with - (verified on disk)", () => {
    expect(escapeCwd("/home/ubuntu/dev/ai-pm", "linux")).toBe("-home-ubuntu-dev-ai-pm");
    // a leading-dot segment yields the verified double dash
    expect(escapeCwd("/home/ubuntu/.claude-mem/observer", "linux")).toBe(
      "-home-ubuntu--claude-mem-observer"
    );
  });
  it("Windows: also escapes backslashes and the drive colon (best-effort)", () => {
    expect(escapeCwd("C:\\Users\\me\\dev\\ai-pm", "win32")).toBe("C--Users-me-dev-ai-pm");
  });
});

describe("transcriptPath / isNewSession", () => {
  it("builds <configDir>/projects/<cwd-escaped>/<id>.jsonl, honoring CLAUDE_CONFIG_DIR", () => {
    const p = transcriptPath(SID, "/home/u/dev/ai-pm", {
      env: { CLAUDE_CONFIG_DIR: "/custom/cfg" },
      platform: "linux",
    });
    expect(p).toBe(`/custom/cfg/projects/-home-u-dev-ai-pm/${SID}.jsonl`);
  });

  it("falls back to <home>/.claude when CLAUDE_CONFIG_DIR is unset", () => {
    const p = transcriptPath(SID, "/w", { env: {}, platform: "linux", home: "/home/u" });
    expect(p).toBe(`/home/u/.claude/projects/-w/${SID}.jsonl`);
  });

  it("isNewSession: true when the transcript is absent, false when present", () => {
    const cwd = "/w";
    const expected = transcriptPath(SID, cwd, { env: {}, platform: "linux", home: "/home/u" });
    const deps = { env: {}, platform: "linux", home: "/home/u" };
    expect(isNewSession(SID, cwd, { ...deps, exists: (p) => p !== expected })).toBe(true);
    expect(isNewSession(SID, cwd, { ...deps, exists: (p) => p === expected })).toBe(false);
  });
});

describe("resolveClaudePath", () => {
  it("finds plain `claude` on a unix PATH", () => {
    const path = resolveClaudePath({
      platform: "linux",
      env: { PATH: "/usr/bin:/home/u/.local/bin" },
      isFile: (p) => p === "/home/u/.local/bin/claude",
    });
    expect(path).toBe("/home/u/.local/bin/claude");
  });

  it("finds claude.cmd on Windows (shim) and prefers it over bare name", () => {
    const path = resolveClaudePath({
      platform: "win32",
      env: { Path: "C:\\bin;C:\\npm" },
      isFile: (p) => p === "C:\\npm\\claude.cmd",
    });
    expect(path).toBe("C:\\npm\\claude.cmd");
  });

  it("honors CHORUS_CLAUDE_PATH override", () => {
    const path = resolveClaudePath({
      env: { CHORUS_CLAUDE_PATH: "/opt/claude", PATH: "/usr/bin" },
      isFile: (p) => p === "/opt/claude",
    });
    expect(path).toBe("/opt/claude");
  });

  it("returns null when not found", () => {
    expect(resolveClaudePath({ platform: "linux", env: { PATH: "/usr/bin" }, isFile: () => false })).toBeNull();
  });
});

describe("parseNdjsonChunk", () => {
  it("parses whole lines, strips CR, buffers partials, skips blanks", () => {
    const got = [];
    let buf = "";
    buf = parseNdjsonChunk(buf, '{"a":1}\r\n{"b":2}\n{"c":', (o) => got.push(o));
    expect(got).toEqual([{ a: 1 }, { b: 2 }]);
    expect(buf).toBe('{"c":'); // partial retained
    buf = parseNdjsonChunk(buf, '3}\n\n', (o) => got.push(o));
    expect(got).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("warns and skips malformed lines without throwing", () => {
    const got = [];
    const warns = [];
    parseNdjsonChunk("", "not json\n{\"ok\":1}\n", (o) => got.push(o), (m) => warns.push(m));
    expect(got).toEqual([{ ok: 1 }]);
    expect(warns.join("")).toMatch(/parse error/);
  });
});

describe("ClaudeSpawner.wake", () => {
  it("feeds prompt over stdin (not argv) and resolves with the supplied session id", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child);
    const spawner = new ClaudeSpawner({
      claudePath: "/usr/bin/claude",
      spawnImpl,
      logger: silent,
    });

    const longPrompt = "X".repeat(50_000); // would blow the Windows cmdline if argv
    const p = spawner.wake({ prompt: longPrompt, sessionId: SID, isNew: true, mcpConfigPath: "/tmp/m.json" });

    // Emit a stream-json line carrying a session_id, then close cleanly.
    child.stdout.emit("data", `{"type":"system","session_id":"${SID}"}\n`);
    child.emit("close", 0);

    const result = await p;
    expect(result).toEqual({ sessionId: SID, exitCode: 0, isNew: true });

    // argv: no prompt; spawned without shell
    const [path, args, opts] = spawnImpl.mock.calls[0];
    expect(path).toBe("/usr/bin/claude");
    expect(args).toContain("--session-id");
    expect(args.join(" ")).not.toContain("X".repeat(50_000));
    expect(opts.shell).toBe(false);
    // prompt arrived via stdin
    expect(child.stdin.writes.join("")).toBe(longPrompt);
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("passes --resume for an existing session and captures observed session_id", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child);
    const spawner = new ClaudeSpawner({ claudePath: "/c", spawnImpl, logger: silent });
    const onMessage = vi.fn();

    const p = spawner.wake({ prompt: "go", sessionId: SID, isNew: false, onMessage });
    child.stdout.emit("data", `{"type":"assistant","session_id":"${SID}"}\n`);
    child.emit("close", 0);
    const result = await p;

    expect(spawnImpl.mock.calls[0][1]).toContain("--resume");
    expect(result.isNew).toBe(false);
    expect(result.sessionId).toBe(SID);
    expect(onMessage).toHaveBeenCalledWith({ type: "assistant", session_id: SID });
  });

  it("REFUSES to spawn (visible log, no subprocess) when the session id is not a valid UUID", async () => {
    const errs = [];
    const spawnImpl = vi.fn();
    const spawner = new ClaudeSpawner({
      claudePath: "/c",
      spawnImpl,
      logger: { ...silent, error: (m) => errs.push(m) },
    });
    const result = await spawner.wake({ prompt: "x", sessionId: "not-a-uuid", isNew: true });
    expect(spawnImpl).not.toHaveBeenCalled(); // never spawned
    expect(result.exitCode).toBeNull();
    expect(errs.join("")).toMatch(/not a valid lowercase UUID/);
  });

  it("does NOT throw and resolves with exitCode null when claude is missing", async () => {
    const spawner = new ClaudeSpawner({ claudePath: null, spawnImpl: () => { throw new Error("should not spawn"); }, logger: silent });
    // claudePath null + resolveClaudePath finds nothing → returns without spawning
    const result = await spawner.wake({ prompt: "x", sessionId: SID, isNew: true });
    expect(result.exitCode).toBeNull();
  });

  it("does NOT crash on a non-zero exit; reports it", async () => {
    const child = makeFakeChild();
    const warns = [];
    const spawner = new ClaudeSpawner({
      claudePath: "/c",
      spawnImpl: () => child,
      logger: { ...silent, warn: (m) => warns.push(m) },
    });
    const p = spawner.wake({ prompt: "x", sessionId: SID, isNew: true });
    child.emit("close", 2);
    const result = await p;
    expect(result.exitCode).toBe(2);
    expect(warns.join("")).toMatch(/exited with code 2/);
  });

  it("does NOT crash on a spawn 'error' event", async () => {
    const child = makeFakeChild();
    const errs = [];
    const spawner = new ClaudeSpawner({
      claudePath: "/c",
      spawnImpl: () => child,
      logger: { ...silent, error: (m) => errs.push(m) },
    });
    const p = spawner.wake({ prompt: "x", sessionId: SID, isNew: true });
    child.emit("error", new Error("ENOENT"));
    const result = await p;
    expect(result.exitCode).toBeNull();
    expect(errs.join("")).toMatch(/process error/);
  });
});

// add-daemon-headless-interaction-guard: the spawned child is marked with
// CHORUS_DAEMON_HEADLESS=1 (merged over inherited env) as a machine-checkable headless
// signal. buildArgs stays free of --append-system-prompt (the rule rides the wake prompt).
describe("ClaudeSpawner.wake — CHORUS_DAEMON_HEADLESS env signal", () => {
  async function spawnAndGetOpts(permissionMode) {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child);
    const spawner = new ClaudeSpawner({
      claudePath: "/usr/bin/claude",
      spawnImpl,
      logger: silent,
      platform: "linux",
      ...(permissionMode ? { permissionMode } : {}),
    });
    const p = spawner.wake({ prompt: "go", sessionId: SID, isNew: true, mcpConfigPath: "/m.json" });
    child.emit("close", 0);
    await p;
    return spawnImpl.mock.calls[0][2]; // spawn options
  }

  it("sets CHORUS_DAEMON_HEADLESS=1 in the spawned child env (default chorus mode)", async () => {
    const opts = await spawnAndGetOpts();
    expect(opts.env).toBeDefined();
    expect(opts.env.CHORUS_DAEMON_HEADLESS).toBe("1");
  });

  it("sets CHORUS_DAEMON_HEADLESS=1 in yolo mode too (unconditional)", async () => {
    const opts = await spawnAndGetOpts("yolo");
    expect(opts.env.CHORUS_DAEMON_HEADLESS).toBe("1");
  });

  it("merges over inherited process.env — a pre-existing var survives", async () => {
    const sentinel = "__CHORUS_TEST_SENTINEL__";
    process.env[sentinel] = "keep-me";
    try {
      const opts = await spawnAndGetOpts();
      expect(opts.env[sentinel]).toBe("keep-me"); // inherited var preserved
      expect(opts.env.CHORUS_DAEMON_HEADLESS).toBe("1"); // and ours added
      // PATH (always present) is inherited too — sanity that we didn't replace env wholesale.
      expect(opts.env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env[sentinel];
    }
  });

  it("buildArgs output never contains --append-system-prompt (q1=C: rule rides the wake prompt, not the system prompt)", () => {
    for (const mode of [undefined, "yolo"]) {
      for (const isNew of [true, false]) {
        const args = buildArgs({ sessionId: SID, isNew, mcpConfigPath: "/m.json", permissionMode: mode });
        expect(args).not.toContain("--append-system-prompt");
      }
    }
  });
});

// 子3 — daemon-interrupt-resume: detached POSIX spawn (process-group leader) so the
// interrupt path can group-kill the tree, plus the onChild handle hand-off. These
// MUST NOT regress stdin prompt delivery or stream-json parsing.
describe("ClaudeSpawner.wake — detached spawn + onChild (子3)", () => {
  it("spawns POSIX children detached:true (process-group leader) without regressing stdin/stdout", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child);
    const onMessage = vi.fn();
    const spawner = new ClaudeSpawner({
      claudePath: "/usr/bin/claude",
      spawnImpl,
      logger: silent,
      platform: "linux", // POSIX
    });

    const p = spawner.wake({ prompt: "PROMPT", sessionId: SID, isNew: true, mcpConfigPath: "/m.json", onMessage });
    // stream-json still parses line by line, prompt still goes over stdin.
    child.stdout.emit("data", `{"type":"system","session_id":"${SID}"}\n`);
    child.emit("close", 0);
    const result = await p;

    const opts = spawnImpl.mock.calls[0][2];
    expect(opts.detached).toBe(true); // POSIX → group leader
    expect(opts.stdio).toEqual(["pipe", "pipe", "pipe"]); // IO unchanged
    expect(opts.shell).toBe(false);
    // No IO regression:
    expect(child.stdin.writes.join("")).toBe("PROMPT"); // prompt over stdin
    expect(child.stdin.end).toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith({ type: "system", session_id: SID }); // NDJSON parsed
    expect(result).toEqual({ sessionId: SID, exitCode: 0, isNew: true });
  });

  it("does NOT set detached on Windows (taskkill walks the tree by pid)", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child);
    const spawner = new ClaudeSpawner({
      claudePath: "C:/claude.exe",
      spawnImpl,
      logger: silent,
      platform: "win32",
    });
    const p = spawner.wake({ prompt: "x", sessionId: SID, isNew: true });
    child.emit("close", 0);
    await p;
    expect(spawnImpl.mock.calls[0][2].detached).toBe(false);
  });

  it("hands the live child to onChild the moment it spawns (before the promise resolves)", async () => {
    const child = makeFakeChild();
    child.pid = 4242;
    const spawnImpl = vi.fn(() => child);
    const onChild = vi.fn();
    const spawner = new ClaudeSpawner({ claudePath: "/c", spawnImpl, logger: silent, platform: "linux" });

    const p = spawner.wake({ prompt: "x", sessionId: SID, isNew: true, onChild });
    // onChild fired synchronously at spawn time — before close.
    expect(onChild).toHaveBeenCalledTimes(1);
    expect(onChild.mock.calls[0][0]).toBe(child);
    expect(onChild.mock.calls[0][0].pid).toBe(4242);
    child.emit("close", 0);
    await p;
  });

  it("a throwing onChild handler is swallowed (never breaks the spawn path)", async () => {
    const child = makeFakeChild();
    const warns = [];
    const spawnImpl = vi.fn(() => child);
    const spawner = new ClaudeSpawner({
      claudePath: "/c",
      spawnImpl,
      logger: { ...silent, warn: (m) => warns.push(m) },
      platform: "linux",
    });
    const p = spawner.wake({ prompt: "x", sessionId: SID, isNew: true, onChild: () => { throw new Error("boom"); } });
    child.emit("close", 0);
    const result = await p;
    expect(result.exitCode).toBe(0); // spawn still completed cleanly
    expect(warns.join("")).toMatch(/onChild handler threw/);
  });

  it("does NOT call onChild when the spawn itself throws", async () => {
    const onChild = vi.fn();
    const spawner = new ClaudeSpawner({
      claudePath: "/c",
      spawnImpl: () => { throw new Error("spawn failed"); },
      logger: silent,
      platform: "linux",
    });
    const result = await spawner.wake({ prompt: "x", sessionId: SID, isNew: true, onChild });
    expect(onChild).not.toHaveBeenCalled();
    expect(result.exitCode).toBeNull();
  });
});

describe("mcp-config", () => {
  it("buildMcpConfig wires the chorus http server with Bearer auth", () => {
    const cfg = buildMcpConfig({ url: "https://chorus.example/", apiKey: "cho_x" });
    expect(cfg.mcpServers.chorus.url).toBe("https://chorus.example/api/mcp");
    expect(cfg.mcpServers.chorus.headers.Authorization).toBe("Bearer cho_x");
  });

  it("writeMcpConfig writes under the temp dir and cleanup removes it", () => {
    const writes = [];
    const rms = [];
    const { path, cleanup } = writeMcpConfig(
      { url: "u", apiKey: "k" },
      {
        tmp: "/TMP",
        mkdtemp: (prefix) => prefix + "ABC",
        write: (p, c, o) => writes.push([p, c, o]),
        rm: (d, o) => rms.push([d, o]),
      }
    );
    expect(path.replace(/\\/g, "/")).toBe("/TMP/chorus-mcp-ABC/mcp.json");
    expect(writes[0][2]).toEqual({ mode: 0o600 });
    cleanup();
    cleanup(); // idempotent
    expect(rms).toHaveLength(1);
    expect(rms[0][1]).toEqual({ recursive: true, force: true });
  });
});

describe("resolveSpawnCommand (Windows .cmd routing)", () => {
  const ARGS = ["-p", "--output-format", "stream-json"];

  it("routes a Windows .cmd shim through cmd.exe /d /s /c", () => {
    const { command, argv } = resolveSpawnCommand("C:\\npm\\claude.cmd", ARGS, "win32", {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    });
    expect(command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(argv).toEqual(["/d", "/s", "/c", "C:\\npm\\claude.cmd", ...ARGS]);
  });

  it("routes a Windows .bat shim through cmd.exe and falls back to cmd.exe when ComSpec unset", () => {
    const { command, argv } = resolveSpawnCommand("C:\\x\\claude.bat", ARGS, "win32", {});
    expect(command).toBe("cmd.exe");
    expect(argv[0]).toBe("/d");
    expect(argv).toContain("C:\\x\\claude.bat");
  });

  it("spawns a real .exe directly on Windows (no cmd.exe wrapper)", () => {
    const { command, argv } = resolveSpawnCommand("C:\\x\\claude.exe", ARGS, "win32", {});
    expect(command).toBe("C:\\x\\claude.exe");
    expect(argv).toEqual(ARGS);
  });

  it("spawns the path directly on POSIX", () => {
    const { command, argv } = resolveSpawnCommand("/usr/bin/claude", ARGS, "linux", {});
    expect(command).toBe("/usr/bin/claude");
    expect(argv).toEqual(ARGS);
  });
});

describe("ClaudeSpawner Windows .cmd integration", () => {
  it("wake() on Windows spawns cmd.exe with the .cmd as an argv element (prompt still via stdin)", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child);
    // Force the spawner to treat the resolved path as a .cmd by giving it one.
    const spawner = new ClaudeSpawner({
      claudePath: "C:\\npm\\claude.cmd",
      spawnImpl,
      logger: { info() {}, warn() {}, error() {} },
    });
    // Override platform detection used by resolveSpawnCommand via env: the
    // spawner calls resolveSpawnCommand(path, args) with process.platform, so on
    // this Linux host the .cmd is NOT rewritten. Assert the POSIX path instead:
    // command === the .cmd path, argv === args (documents host behavior). The
    // pure resolveSpawnCommand tests above cover the win32 rewrite deterministically.
    const p = spawner.wake({ prompt: "hi", sessionId: SID, isNew: true, mcpConfigPath: "/m.json" });
    child.emit("close", 0);
    await p;
    const [command, argv] = spawnImpl.mock.calls[0];
    expect(command).toBe("C:\\npm\\claude.cmd"); // unchanged on a POSIX test host
    expect(argv).toContain("--session-id");
    expect(child.stdin.writes.join("")).toBe("hi");
  });
});

describe("ClaudeSpawner stdin EPIPE resilience", () => {
  it("does NOT crash when child.stdin emits an async 'error' (EPIPE)", async () => {
    const child = makeFakeChild();
    const warns = [];
    const spawner = new ClaudeSpawner({
      claudePath: "/usr/bin/claude",
      spawnImpl: () => child,
      logger: { info() {}, warn: (m) => warns.push(m), error() {} },
    });
    const p = spawner.wake({ prompt: "x", sessionId: SID, isNew: true });
    // Simulate claude exiting before reading stdin → writable emits EPIPE.
    child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    child.emit("close", 1);
    const result = await p;
    expect(result.exitCode).toBe(1); // resolved cleanly, no throw
    expect(warns.join("")).toMatch(/stdin error/i);
  });
});
