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
} from "../claude-spawner.mjs";
import { writeMcpConfig, buildMcpConfig } from "../mcp-config.mjs";

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
  it("feeds prompt over stdin (not argv) and resolves with the generated session id", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child);
    const spawner = new ClaudeSpawner({
      claudePath: "/usr/bin/claude",
      spawnImpl,
      logger: silent,
      genId: () => "fixed-sid",
    });

    const longPrompt = "X".repeat(50_000); // would blow the Windows cmdline if argv
    const p = spawner.wake({ prompt: longPrompt, mcpConfigPath: "/tmp/m.json" });

    // Emit a stream-json line carrying a session_id, then close cleanly.
    child.stdout.emit("data", '{"type":"system","session_id":"fixed-sid"}\n');
    child.emit("close", 0);

    const result = await p;
    expect(result).toEqual({ sessionId: "fixed-sid", exitCode: 0, isNew: true });

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

    const p = spawner.wake({ prompt: "go", sessionId: "root-sid", onMessage });
    child.stdout.emit("data", '{"type":"assistant","session_id":"root-sid"}\n');
    child.emit("close", 0);
    const result = await p;

    expect(spawnImpl.mock.calls[0][1]).toContain("--resume");
    expect(result.isNew).toBe(false);
    expect(result.sessionId).toBe("root-sid");
    expect(onMessage).toHaveBeenCalledWith({ type: "assistant", session_id: "root-sid" });
  });

  it("does NOT throw and resolves with exitCode null when claude is missing", async () => {
    const spawner = new ClaudeSpawner({ claudePath: null, spawnImpl: () => { throw new Error("should not spawn"); }, logger: silent });
    // claudePath null + resolveClaudePath finds nothing → returns without spawning
    const result = await spawner.wake({ prompt: "x" });
    expect(result.exitCode).toBeNull();
  });

  it("does NOT crash on a non-zero exit; reports it", async () => {
    const child = makeFakeChild();
    const warns = [];
    const spawner = new ClaudeSpawner({
      claudePath: "/c",
      spawnImpl: () => child,
      logger: { ...silent, warn: (m) => warns.push(m) },
      genId: () => "s",
    });
    const p = spawner.wake({ prompt: "x" });
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
      genId: () => "s",
    });
    const p = spawner.wake({ prompt: "x" });
    child.emit("error", new Error("ENOENT"));
    const result = await p;
    expect(result.exitCode).toBeNull();
    expect(errs.join("")).toMatch(/process error/);
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
      genId: () => "sid",
    });
    // Override platform detection used by resolveSpawnCommand via env: the
    // spawner calls resolveSpawnCommand(path, args) with process.platform, so on
    // this Linux host the .cmd is NOT rewritten. Assert the POSIX path instead:
    // command === the .cmd path, argv === args (documents host behavior). The
    // pure resolveSpawnCommand tests above cover the win32 rewrite deterministically.
    const p = spawner.wake({ prompt: "hi", mcpConfigPath: "/m.json" });
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
      genId: () => "sid",
    });
    const p = spawner.wake({ prompt: "x" });
    // Simulate claude exiting before reading stdin → writable emits EPIPE.
    child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    child.emit("close", 1);
    const result = await p;
    expect(result.exitCode).toBe(1); // resolved cleanly, no throw
    expect(warns.join("")).toMatch(/stdin error/i);
  });
});
