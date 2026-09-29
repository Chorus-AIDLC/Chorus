// cli/__tests__/claude-spawner.test.mjs
// Covers cli-daemon spec "Cross-platform headless spawn" (both scenarios) and
// the spawner AC: stdin prompt, path resolution incl. Windows .cmd, NDJSON
// parse with CRLF + session_id extraction, fire-and-forget failure handling.
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
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
  SESSION_CONFLICT_FAILURE,
  CONTROL_FRAME_TYPES,
  CHORUS_TOOL_DENY_MESSAGE,
  UNSUPPORTED_CONTROL_ERROR,
  ClaudeControlChannel,
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

/** The prompt carried by the single stream-json user frame written to stdin. */
function stdinPrompt(child) {
  expect(child.stdin.writes).toHaveLength(1);
  const line = child.stdin.writes[0];
  expect(line.endsWith("\n")).toBe(true);
  const frame = JSON.parse(line);
  expect(frame).toEqual({ type: "user", message: { role: "user", content: expect.any(String) }, parent_tool_use_id: null });
  return frame.message.content;
}

describe("buildArgs", () => {
  it("uses --session-id for a new session, never puts prompt in argv", () => {
    const args = buildArgs({ sessionId: "sid-1", isNew: true, mcpConfigPath: "/tmp/m.json" });
    expect(args).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      "sid-1",
      "--mcp-config",
      "/tmp/m.json",
      "--disallowedTools",
      "AskUserQuestion",
      // default permission mode: allow only Chorus MCP tools through and route
      // every other permission prompt to the spawner over the control protocol
      "--allowedTools",
      "mcp__chorus__*",
      "--permission-prompt-tool",
      "stdio",
    ]);
    // the only "prompt" in argv is the permission-prompt-tool flag name
    expect(args.filter((a) => /prompt/i.test(a))).toEqual(["--permission-prompt-tool"]);
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
    expect(args).not.toContain("--permission-prompt-tool");
  });

  it("yolo resume: full argv, AskUserQuestion still disallowed", () => {
    expect(buildArgs({ sessionId: "sid-3", isNew: false, mcpConfigPath: "/m.json", permissionMode: "yolo" })).toEqual([
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--resume", "sid-3",
      "--mcp-config", "/m.json",
      "--disallowedTools", "AskUserQuestion",
      "--dangerously-skip-permissions",
    ]);
  });

  it("chorus resume without mcp config: full argv", () => {
    expect(buildArgs({ sessionId: "sid-4", isNew: false })).toEqual([
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--resume", "sid-4",
      "--disallowedTools", "AskUserQuestion",
      "--allowedTools", "mcp__chorus__*", "--permission-prompt-tool", "stdio",
    ]);
  });

  it("wake() appends operator cliConfig.args after every fixed flag (both modes)", async () => {
    for (const permissionMode of ["chorus", "yolo"]) {
      const child = makeFakeChild();
      const spawnImpl = vi.fn(() => child);
      const spawner = new ClaudeSpawner({
        claudePath: "/usr/bin/claude", spawnImpl, logger: silent, permissionMode,
        cliConfig: { args: ["--model", "haiku"] },
      });
      const p = spawner.wake({ prompt: "x", sessionId: SID, isNew: true, mcpConfigPath: "/m.json" });
      child.emit("close", 0);
      await p;
      const argv = spawnImpl.mock.calls[0][1];
      expect(argv).toEqual([
        ...buildArgs({ sessionId: SID, isNew: true, mcpConfigPath: "/m.json", permissionMode }),
        "--model", "haiku",
      ]);
    }
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
  it("POSIX: preserves established ASCII path fixtures byte-for-byte", () => {
    expect(escapeCwd("/home/ubuntu/dev/ai-pm", "linux")).toBe("-home-ubuntu-dev-ai-pm");
    // a leading-dot segment yields the verified double dash
    expect(escapeCwd("/home/ubuntu/.claude-mem/observer", "linux")).toBe(
      "-home-ubuntu--claude-mem-observer"
    );
  });

  it("normalizes spaces, underscores, CJK, and astral Unicode like Claude Code 2.1.251", () => {
    expect(escapeCwd("/home/u/my project", "linux")).toBe("-home-u-my-project");
    expect(escapeCwd("/home/u/proj_name", "linux")).toBe("-home-u-proj-name");
    expect(escapeCwd("/home/ubuntu/dev/养育", "linux")).toBe("-home-ubuntu-dev---");
    // Claude's non-unicode regex replaces each UTF-16 surrogate code unit.
    expect(escapeCwd("/home/u/😀", "linux")).toBe("-home-u---");
  });

  it("Windows: preserves the established separator and drive-colon fixture", () => {
    expect(escapeCwd("C:\\Users\\me\\dev\\ai-pm", "win32")).toBe("C--Users-me-dev-ai-pm");
  });

  it("keeps escaped keys through 200 characters and truncates keys over the boundary", () => {
    expect(escapeCwd("a".repeat(200), "linux")).toBe("a".repeat(200));
    expect(escapeCwd("a".repeat(201), "linux")).toBe(`${"a".repeat(200)}-rkvsv5`);
  });

  it("hashes the original cwd after truncating the escaped key", () => {
    // Both inputs escape to the same 201-character value. Distinct suffixes prove
    // Claude hashes the original slash/underscore code unit, not the escaped key.
    const escapedPrefix = `-${"a".repeat(199)}`;
    expect(escapeCwd(`/${"a".repeat(200)}`, "linux")).toBe(`${escapedPrefix}-b6ymvl`);
    expect(escapeCwd(`_${"a".repeat(200)}`, "linux")).toBe(`${escapedPrefix}-awnd41`);
  });

  it("uses original UTF-16 code units for a long cwd hash", () => {
    const cwd = `/tmp/😀/${"x".repeat(195)}`;
    expect(escapeCwd(cwd, "linux")).toBe(`-tmp----${"x".repeat(192)}-ty71zh`);
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

  it.each([
    ["/home/ubuntu/dev/养育", "-home-ubuntu-dev---"],
    ["/home/ubuntu/dev/my project", "-home-ubuntu-dev-my-project"],
  ])("finds an existing transcript for cwd %s", (cwd, escapedCwd) => {
    const expected = `/home/u/.claude/projects/${escapedCwd}/${SID}.jsonl`;
    const deps = { env: {}, platform: "linux", home: "/home/u", exists: (p) => p === expected };
    expect(transcriptPath(SID, cwd, deps)).toBe(expected);
    expect(isNewSession(SID, cwd, deps)).toBe(false);
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

    // Emit a stream-json line carrying a session_id, the turn's result, then close.
    child.stdout.emit("data", `{"type":"system","session_id":"${SID}"}\n`);
    child.stdout.emit("data", `{"type":"result","subtype":"success","session_id":"${SID}"}\n`);
    child.emit("close", 0);

    const result = await p;
    expect(result).toEqual({ sessionId: SID, backendSessionId: SID, exitCode: 0, isNew: true });

    // argv: no prompt; spawned without shell
    const [path, args, opts] = spawnImpl.mock.calls[0];
    expect(path).toBe("/usr/bin/claude");
    expect(args).toContain("--session-id");
    expect(args.join(" ")).not.toContain("X".repeat(50_000));
    expect(opts.shell).toBe(false);
    // prompt arrived via stdin as one stream-json user frame
    expect(stdinPrompt(child)).toBe(longPrompt);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
  });

  it("exports CHORUS_AGENT_PROFILE=<agentUuid> into the woken child env (identity, uuid preferred, never argv)", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child);
    const spawner = new ClaudeSpawner({
      claudePath: "/usr/bin/claude",
      spawnImpl,
      logger: silent,
      creds: {
        url: "https://chorus.test",
        apiKey: "cho_secret",
        agentUuid: "daee0667-8487-4810-9cc0-8e4a0b2174c9",
        agentName: "Admin Claude",
      },
    });

    const p = spawner.wake({ prompt: "hi", sessionId: SID, isNew: true, mcpConfigPath: "/tmp/m.json" });
    child.stdout.emit("data", `{"type":"system","session_id":"${SID}"}\n`);
    child.emit("close", 0);
    await p;

    const [, args, opts] = spawnImpl.mock.calls[0];
    expect(opts.env.CHORUS_AGENT_PROFILE).toBe("daee0667-8487-4810-9cc0-8e4a0b2174c9"); // uuid, not name
    expect(opts.env.CHORUS_URL).toBe("https://chorus.test");
    expect(args.join(" ")).not.toContain("daee0667"); // identity never on argv
    expect(args.join(" ")).not.toContain("cho_secret");
  });

  it("omits CHORUS_AGENT_PROFILE when creds carry no identity", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child);
    const spawner = new ClaudeSpawner({
      claudePath: "/usr/bin/claude",
      spawnImpl,
      logger: silent,
      creds: { url: "https://chorus.test", apiKey: "cho_secret" },
    });
    const p = spawner.wake({ prompt: "hi", sessionId: SID, isNew: true, mcpConfigPath: "/tmp/m.json" });
    child.stdout.emit("data", `{"type":"system","session_id":"${SID}"}\n`);
    child.emit("close", 0);
    await p;
    expect(spawnImpl.mock.calls[0][2].env.CHORUS_AGENT_PROFILE).toBeUndefined();
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

  it("reports backendSessionId = the --resume anchor (not a fork-diverged stream session_id)", async () => {
    // A fork-on-resume claude can emit a DIFFERENT session_id on the stream than the
    // anchor the daemon resumed with. The resumable value the UI copies must be the
    // anchor (`SID`) — the id the transcript file and `--resume` are keyed on — NOT
    // the observed stream id. `sessionId` still reflects the observed stream value.
    const forked = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const child = makeFakeChild();
    const spawner = new ClaudeSpawner({ claudePath: "/c", spawnImpl: () => child, logger: silent });

    const p = spawner.wake({ prompt: "go", sessionId: SID, isNew: false });
    child.stdout.emit("data", `{"type":"system","session_id":"${forked}"}\n`);
    child.emit("close", 0);
    const result = await p;

    expect(result.backendSessionId).toBe(SID); // the resume anchor, verbatim
    expect(result.sessionId).toBe(forked); // observed stream id, unchanged behavior
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
    // Uniform return shape: the pre-spawn refusal carries backendSessionId (null — no
    // turn ran, nothing to resume), matching the codex-spawner shape convention.
    expect(result.backendSessionId).toBeNull();
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

  it("classifies a split Session ID already-in-use stderr signature on non-zero exit", async () => {
    const child = makeFakeChild();
    const spawner = new ClaudeSpawner({
      claudePath: "/c",
      spawnImpl: () => child,
      logger: silent,
    });
    const p = spawner.wake({ prompt: "x", sessionId: SID, isNew: true });
    child.stderr.emit("data", `Error: Session ID ${SID} is already `);
    child.stderr.emit("data", "in use by another process\n");
    child.emit("close", 1);

    expect(await p).toEqual({
      sessionId: SID,
      backendSessionId: SID,
      exitCode: 1,
      isNew: true,
      failureClassification: SESSION_CONFLICT_FAILURE,
    });
  });

  it("leaves unrelated stderr and zero exits unclassified", async () => {
    for (const { stderr, code } of [
      { stderr: "authentication failed", code: 1 },
      { stderr: `Session ID ${SID} is already in use`, code: 0 },
    ]) {
      const child = makeFakeChild();
      const spawner = new ClaudeSpawner({
        claudePath: "/c",
        spawnImpl: () => child,
        logger: silent,
      });
      const p = spawner.wake({ prompt: "x", sessionId: SID, isNew: true });
      child.stderr.emit("data", stderr);
      child.emit("close", code);
      const result = await p;
      expect(result).not.toHaveProperty("failureClassification");
      expect(result).toMatchObject({
        sessionId: SID,
        backendSessionId: SID,
        exitCode: code,
        isNew: true,
      });
    }
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
  const creds = { url: "https://chorus.test", apiKey: "cho_secret" };

  async function spawnAndGetOpts(permissionMode) {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child);
    const spawner = new ClaudeSpawner({
      claudePath: "/usr/bin/claude",
      spawnImpl,
      logger: silent,
      platform: "linux",
      creds,
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
    expect(opts.env.CHORUS_URL).toBe("https://chorus.test");
    expect(opts.env.CHORUS_API_KEY).toBe("cho_secret");
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

  it("overwrites stale inherited Chorus credentials with the daemon pair", async () => {
    const previousUrl = process.env.CHORUS_URL;
    const previousKey = process.env.CHORUS_API_KEY;
    process.env.CHORUS_URL = "https://stale.test";
    process.env.CHORUS_API_KEY = "cho_stale";
    try {
      const opts = await spawnAndGetOpts();
      expect(opts.env.CHORUS_URL).toBe("https://chorus.test");
      expect(opts.env.CHORUS_API_KEY).toBe("cho_secret");
    } finally {
      if (previousUrl === undefined) delete process.env.CHORUS_URL;
      else process.env.CHORUS_URL = previousUrl;
      if (previousKey === undefined) delete process.env.CHORUS_API_KEY;
      else process.env.CHORUS_API_KEY = previousKey;
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
    child.stdout.emit("data", `{"type":"result","subtype":"success","session_id":"${SID}"}\n`);
    child.emit("close", 0);
    const result = await p;

    const opts = spawnImpl.mock.calls[0][2];
    expect(opts.detached).toBe(true); // POSIX → group leader
    expect(opts.stdio).toEqual(["pipe", "pipe", "pipe"]); // IO unchanged
    expect(opts.shell).toBe(false);
    // No IO regression:
    expect(stdinPrompt(child)).toBe("PROMPT"); // prompt over stdin
    expect(child.stdin.end).toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith({ type: "system", session_id: SID }); // NDJSON parsed
    expect(result).toEqual({ sessionId: SID, backendSessionId: SID, exitCode: 0, isNew: true });
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
    expect(stdinPrompt(child)).toBe("hi");
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

// ── stream-json transport (switch-claude-daemon-to-stream-json D2/D3/D5) ──────────

/** Emit frames on the fake child's stdout as NDJSON lines. */
function emitFrames(child, frames) {
  for (const f of frames) child.stdout.emit("data", `${JSON.stringify(f)}\n`);
}

/** Parsed stdin frames written by the spawner. */
function stdinFrames(child) {
  return child.stdin.writes.map((l) => JSON.parse(l));
}

function recordingLogger() {
  const log = { info: [], warn: [], error: [] };
  return {
    log,
    logger: { info: (m) => log.info.push(m), warn: (m) => log.warn.push(m), error: (m) => log.error.push(m) },
  };
}

function startWake({ permissionMode = "chorus", logger = silent, prompt = "PROMPT" } = {}) {
  const child = makeFakeChild();
  const onMessage = vi.fn();
  const spawner = new ClaudeSpawner({ claudePath: "/usr/bin/claude", spawnImpl: () => child, logger, permissionMode, platform: "linux" });
  const promise = spawner.wake({ prompt, sessionId: SID, isNew: true, onMessage });
  return { child, onMessage, promise };
}

describe("ClaudeSpawner stream-json turn completion", () => {
  it("writes one user frame and keeps stdin open until the first result (success)", async () => {
    const { child, promise } = startWake();
    expect(stdinPrompt(child)).toBe("PROMPT");
    emitFrames(child, [
      { type: "system", subtype: "init", session_id: SID },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, session_id: SID },
    ]);
    expect(child.stdin.end).not.toHaveBeenCalled();
    emitFrames(child, [{ type: "result", subtype: "success", session_id: SID }]);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    // a second result never closes stdin twice
    emitFrames(child, [{ type: "result", subtype: "success", session_id: SID }]);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    child.emit("close", 0);
    expect(await promise).toEqual({ sessionId: SID, backendSessionId: SID, exitCode: 0, isNew: true });
  });

  it("closes stdin on an error result too and reports the raw exit code", async () => {
    const { child, promise } = startWake();
    emitFrames(child, [{ type: "result", subtype: "error_during_execution", is_error: true, session_id: SID }]);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    child.emit("close", 1);
    expect((await promise).exitCode).toBe(1);
  });

  it("an exit with no result is NOT success: raw exit code, stdin never ended by a result", async () => {
    const { child, promise } = startWake();
    emitFrames(child, [{ type: "system", subtype: "init", session_id: SID }]);
    child.emit("exit", 3);
    child.emit("close", 3);
    const result = await promise;
    expect(result.exitCode).toBe(3);
    expect(child.stdin.end).not.toHaveBeenCalled();
  });
});

describe("ClaudeSpawner stream-json control frames", () => {
  it("never forwards control_* frames; forwards every other frame unchanged", async () => {
    const { child, onMessage, promise } = startWake();
    const assistant1 = { type: "assistant", message: { content: [{ type: "text", text: "a" }] }, session_id: SID };
    const assistant2 = { type: "assistant", message: { content: [{ type: "text", text: "b" }] }, session_id: SID };
    const unknownType = { type: "stream_event", event: { type: "ping" }, session_id: SID };
    const result = { type: "result", subtype: "success", session_id: SID };
    emitFrames(child, [
      assistant1,
      { type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } } },
      { type: "control_response", response: { subtype: "success", request_id: "x", response: {} } },
      { type: "control_cancel_request", request_id: "r1" },
      assistant2,
      unknownType,
      result,
    ]);
    child.emit("close", 0);
    await promise;
    expect(onMessage.mock.calls.map((c) => c[0])).toEqual([assistant1, assistant2, unknownType, result]);
    expect([...CONTROL_FRAME_TYPES].sort()).toEqual(["control_cancel_request", "control_request", "control_response"]);
  });

  it.each(["chorus", "yolo"])("denies can_use_tool (%s mode) with the request id and Chorus message; warn names the tool only", async (permissionMode) => {
    const { log, logger } = recordingLogger();
    const { child, promise } = startWake({ permissionMode, logger });
    const secret = "curl -H 'Authorization: Bearer cho_SECRET' https://x";
    emitFrames(child, [{ type: "control_request", request_id: "req-42", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: secret } } }]);
    const frames = stdinFrames(child);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: "req-42", response: { behavior: "deny", message: CHORUS_TOOL_DENY_MESSAGE } },
    });
    expect(CHORUS_TOOL_DENY_MESSAGE).toMatch(/--chorus-only/);
    expect(CHORUS_TOOL_DENY_MESSAGE).toMatch(/Chorus comment/);
    const denyWarns = log.warn.filter((m) => m.includes("denied tool"));
    expect(denyWarns).toHaveLength(1);
    expect(denyWarns[0]).toMatch(/denied tool Bash \(/);
    expect(log.warn.join("\n")).not.toContain("cho_SECRET");
    expect(log.warn.join("\n")).not.toContain("curl");
    expect(child.stdin.end).not.toHaveBeenCalled(); // a control answer never closes stdin
    child.emit("close", 0);
    await promise;
  });

  it("answers an unknown control_request subtype with an error response and a warn", async () => {
    const { log, logger } = recordingLogger();
    const { child, promise } = startWake({ logger });
    emitFrames(child, [{ type: "control_request", request_id: "req-7", request: { subtype: "mystery" } }]);
    expect(stdinFrames(child)[1]).toEqual({
      type: "control_response",
      response: { subtype: "error", request_id: "req-7", error: UNSUPPORTED_CONTROL_ERROR },
    });
    expect(log.warn.some((m) => /unsupported claude control request subtype mystery/.test(m))).toBe(true);
    child.emit("close", 0);
    await promise;
  });

  it("control_response / control_cancel_request are consumed without any stdin write", async () => {
    const { child, promise } = startWake();
    emitFrames(child, [
      { type: "control_response", response: { subtype: "success", request_id: "nope", response: {} } },
      { type: "control_cancel_request", request_id: "nope" },
    ]);
    expect(child.stdin.writes).toHaveLength(1); // only the prompt
    child.emit("close", 0);
    await promise;
  });

  it("a control request after the child exited does not throw and is logged", async () => {
    const { log, logger } = recordingLogger();
    const { child, promise } = startWake({ logger });
    child.emit("exit", 0);
    expect(() =>
      emitFrames(child, [{ type: "control_request", request_id: "late", request: { subtype: "can_use_tool", tool_name: "Write", input: {} } }])
    ).not.toThrow();
    expect(child.stdin.writes).toHaveLength(1); // nothing written to a dead child
    expect(log.warn.some((m) => /stdin is closed; dropped/.test(m))).toBe(true);
    child.emit("close", 0);
    expect((await promise).exitCode).toBe(0);
  });

  it("a synchronously throwing stdin write (destroyed stream) is logged, never thrown", async () => {
    const { log, logger } = recordingLogger();
    const { child, promise } = startWake({ logger });
    child.stdin.write = () => {
      throw Object.assign(new Error("Cannot call write after a stream was destroyed"), { code: "ERR_STREAM_DESTROYED" });
    };
    expect(() =>
      emitFrames(child, [{ type: "control_request", request_id: "r", request: { subtype: "can_use_tool", tool_name: "Edit", input: {} } }])
    ).not.toThrow();
    expect(log.warn.some((m) => /failed writing permission deny for Edit/.test(m))).toBe(true);
    child.emit("close", 1);
    expect((await promise).exitCode).toBe(1);
  });

  it("after an async stdin error (EPIPE) no further writes are attempted", () => {
    const { log, logger } = recordingLogger();
    const stdin = new EventEmitter();
    stdin.write = vi.fn();
    stdin.end = vi.fn();
    const channel = new ClaudeControlChannel({ stdin, logger, permissionMode: "chorus" });
    channel.markStdinUnusable();
    expect(channel.write({ type: "x" }, "probe")).toBe(false);
    expect(stdin.write).not.toHaveBeenCalled();
    channel.closeStdin();
    expect(stdin.end).not.toHaveBeenCalled();
    expect(log.warn.some((m) => /dropped probe/.test(m))).toBe(true);
  });
});

describe("ClaudeSpawner replays pinned stream-json fixtures", () => {
  const dir = pathJoin(dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-stream-json");
  const load = (name) => JSON.parse(readFileSync(pathJoin(dir, name), "utf8"));
  const fixtures = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();

  it("every fixture declares its provenance (three live 2.1.283 captures + one synthetic)", () => {
    expect(fixtures).toEqual([
      "can-use-tool-2.1.283.json",
      "interrupted-turn-2.1.283.json",
      "normal-turn-2.1.283.json",
      "unknown-control-request-synthetic.json",
    ]);
    for (const name of fixtures) {
      const fx = load(name);
      if (name.includes("synthetic")) expect(fx.provenance).toBe("synthetic");
      else {
        expect(fx.provenance).toBe("live-capture");
        expect(fx.cliVersion).toBe("2.1.283");
      }
      // no secrets or home paths leaked into a fixture
      const raw = readFileSync(pathJoin(dir, name), "utf8");
      expect(raw).not.toMatch(/cho_[A-Za-z0-9]/);
      expect(raw).not.toMatch(/\/home\/|\/Users\//);
    }
  });

  /**
   * Replay a fixture's stdout frames through a fake child and return what the
   * spawner forwarded, wrote and resolved with.
   */
  async function replay(fx, permissionMode = "chorus") {
    const recordedPrompt = fx.transcript.find((t) => t.direction === "stdin" && t.frame.type === "user")?.frame.message.content ?? "synthetic prompt";
    const { log, logger } = recordingLogger();
    const { child, onMessage, promise } = startWake({ permissionMode, logger, prompt: recordedPrompt });
    const stdout = fx.transcript.filter((t) => t.direction === "stdout").map((t) => t.frame);
    const endCalledBeforeResult = [];
    for (const frame of stdout) {
      if (frame.type === "result") endCalledBeforeResult.push(child.stdin.end.mock.calls.length);
      emitFrames(child, [frame]);
    }
    child.emit("exit", fx.exitCode);
    child.emit("close", fx.exitCode);
    const result = await promise;
    return { child, stdout, forwarded: onMessage.mock.calls.map((c) => c[0]), result, log, recordedPrompt, endCalledBeforeResult };
  }

  it("normal turn: one user frame, all frames forwarded, stdin closed at the result, exit 0", async () => {
    const fx = load("normal-turn-2.1.283.json");
    const { child, stdout, forwarded, result, recordedPrompt, endCalledBeforeResult } = await replay(fx);
    expect(stdinFrames(child)).toEqual(fx.transcript.filter((t) => t.direction === "stdin").map((t) => t.frame));
    expect(stdinPrompt(child)).toBe(recordedPrompt);
    expect(forwarded).toEqual(stdout);
    expect(endCalledBeforeResult).toEqual([0]);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
  });

  it("interrupted turn: interrupt ack is consumed, error result closes stdin, raw exit 1", async () => {
    const fx = load("interrupted-turn-2.1.283.json");
    const { child, stdout, forwarded, result, endCalledBeforeResult } = await replay(fx);
    expect(stdout.some((f) => f.type === "control_response" && f.response.request_id === "chorus-interrupt-1")).toBe(true);
    expect(forwarded).toEqual(stdout.filter((f) => !CONTROL_FRAME_TYPES.has(f.type)));
    expect(forwarded.at(-1)).toMatchObject({ type: "result", subtype: "error_during_execution" });
    // the protocol interrupt write itself belongs to the stop hook; here only the prompt is written
    expect(child.stdin.writes).toHaveLength(1);
    expect(endCalledBeforeResult).toEqual([0]);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(1);
  });

  it("can_use_tool: the recorded request id is denied with the Chorus message; request not forwarded", async () => {
    const fx = load("can-use-tool-2.1.283.json");
    const recordedRequest = fx.transcript.find((t) => t.frame.type === "control_request").frame;
    const recordedAnswer = fx.transcript.find((t) => t.direction === "stdin" && t.frame.type === "control_response").frame;
    const { child, stdout, forwarded, result, log } = await replay(fx);
    const written = stdinFrames(child);
    expect(written).toHaveLength(2);
    // same wire shape the live CLI accepted, with the daemon's own message
    expect(written[1]).toEqual({
      ...recordedAnswer,
      response: { ...recordedAnswer.response, response: { behavior: "deny", message: CHORUS_TOOL_DENY_MESSAGE } },
    });
    expect(written[1].response.request_id).toBe(recordedRequest.request_id);
    expect(forwarded).toEqual(stdout.filter((f) => !CONTROL_FRAME_TYPES.has(f.type)));
    // the live deny surfaced to the model as an error tool_result and in permission_denials
    expect(forwarded.some((f) => f.type === "user" && f.message.content.some((b) => b.type === "tool_result" && b.is_error))).toBe(true);
    expect(forwarded.at(-1).permission_denials).toEqual([expect.objectContaining({ tool_name: "Bash" })]);
    expect(log.warn.filter((m) => m.includes("denied tool"))).toEqual([expect.stringMatching(/denied tool Bash \(--chorus-only permission mode\)/)]);
    expect(log.warn.join("\n")).not.toContain(recordedRequest.request.input.command);
    expect(result.exitCode).toBe(0);
  });

  it("synthetic unknown control request: error response, neither control frame forwarded", async () => {
    const fx = load("unknown-control-request-synthetic.json");
    const { child, stdout, forwarded, result, log } = await replay(fx);
    expect(stdinFrames(child)[1]).toEqual({
      type: "control_response",
      response: { subtype: "error", request_id: "synthetic-req-1", error: UNSUPPORTED_CONTROL_ERROR },
    });
    expect(forwarded).toEqual(stdout.filter((f) => !CONTROL_FRAME_TYPES.has(f.type)));
    expect(forwarded.map((f) => f.type)).toEqual(["system", "assistant", "result"]);
    expect(log.warn.some((m) => /unsupported claude control request subtype elicitation/.test(m))).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});
