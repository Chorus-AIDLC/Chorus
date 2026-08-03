// cli/__tests__/codex-spawner.test.mjs
// Covers daemon-codex-backend spec: headless `codex exec --json` wake (prompt on
// stdin), buildArgs for new vs resume + sandbox flag, thread-id capture from the
// `thread.started` event + persistence, daemon-key-via-env, cross-platform exec
// resolution, and never-throw-into-the-wake-path failure handling.
//
// Verified against codex-cli 0.142.3: a real `codex exec --json` first line is
// `{"type":"thread.started","thread_id":"<uuid>"}` and the prompt is read from
// stdin ("Reading prompt from stdin...").
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  CodexSpawner,
  buildCodexArgs,
  sandboxFlags,
  resolveCodexPath,
  extractThreadId,
  hasChorusMcpServer,
} from "../codex-spawner.mjs";

const ANCHOR = "11111111-1111-4111-8111-111111111111";
const TID = "019f091a-844e-7b43-8c31-6b04ffa38149";

/** A fake child process: stdin captures writes; stdout/stderr are emitters. */
function makeFakeChild() {
  const child = new EventEmitter();
  const stdinChunks = [];
  const stdin = new EventEmitter();
  stdin.writes = stdinChunks;
  stdin.write = (c) => stdinChunks.push(String(c));
  stdin.end = vi.fn();
  child.stdin = stdin;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.pid = 4242;
  return child;
}

describe("sandboxFlags — permission mode mapping (subcommand-aware)", () => {
  it("yolo → --dangerously-bypass-approvals-and-sandbox (valid on both exec and resume)", () => {
    expect(sandboxFlags("yolo")).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    expect(sandboxFlags("yolo", { resume: true })).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
  });
  it("chorus on NEW (exec) → --sandbox read-only", () => {
    expect(sandboxFlags("chorus")).toEqual(["--sandbox", "read-only"]);
  });
  it("chorus on RESUME → -c sandbox_mode=read-only (codex exec resume has NO --sandbox flag)", () => {
    // Verified against codex 0.142.3: `codex exec resume --sandbox` errors (exit 2);
    // the read-only posture must go through the `-c` config override there.
    expect(sandboxFlags("chorus", { resume: true })).toEqual(["-c", 'sandbox_mode="read-only"']);
  });
  it("defaults unknown/undefined to the restricted read-only posture (per subcommand)", () => {
    expect(sandboxFlags(undefined)).toEqual(["--sandbox", "read-only"]);
    expect(sandboxFlags(undefined, { resume: true })).toEqual(["-c", 'sandbox_mode="read-only"']);
  });
});

describe("buildCodexArgs — new vs resume", () => {
  it("new run: exec --json + sandbox + skip-git-repo-check, no resume, no prompt in argv", () => {
    const args = buildCodexArgs({ isNew: true, permissionMode: "yolo" });
    expect(args).toEqual(["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"]);
    expect(args).not.toContain("resume");
  });

  it("resume run (yolo): exec resume <thread_id> --json + bypass flag", () => {
    const args = buildCodexArgs({ isNew: false, threadId: TID, permissionMode: "yolo" });
    expect(args).toEqual([
      "exec",
      "resume",
      TID,
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
    ]);
  });

  it("resume run (chorus): exec resume <thread_id> --json -c sandbox_mode=read-only (NO --sandbox)", () => {
    const args = buildCodexArgs({ isNew: false, threadId: TID, permissionMode: "chorus" });
    expect(args).toEqual([
      "exec",
      "resume",
      TID,
      "--json",
      "-c",
      'sandbox_mode="read-only"',
      "--skip-git-repo-check",
    ]);
    // the bug this regression-guards: `--sandbox` is rejected by `codex exec resume`.
    expect(args).not.toContain("--sandbox");
  });

  it("chorus mode keeps read-only on new (--sandbox) and resume (-c sandbox_mode)", () => {
    expect(buildCodexArgs({ isNew: true, permissionMode: "chorus" })).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
    ]);
    expect(buildCodexArgs({ isNew: false, threadId: TID, permissionMode: "chorus" })).toContain('sandbox_mode="read-only"');
  });

  it("never contains the prompt (prompt is stdin-only)", () => {
    const args = buildCodexArgs({ isNew: true, permissionMode: "yolo" });
    expect(args.join(" ")).not.toContain("PROMPT");
  });
});

describe("extractThreadId — capture from the thread.started event", () => {
  it("reads thread_id from a thread.started event", () => {
    expect(extractThreadId({ type: "thread.started", thread_id: TID })).toBe(TID);
  });
  it("falls back to session_meta.payload.id (on-disk rollout shape)", () => {
    expect(extractThreadId({ type: "session_meta", payload: { id: TID } })).toBe(TID);
  });
  it("returns null for unrelated events", () => {
    expect(extractThreadId({ type: "turn.completed" })).toBeNull();
    expect(extractThreadId({ type: "item.completed", item: {} })).toBeNull();
    expect(extractThreadId({ type: "thread.started", thread_id: "  " })).toBeNull();
    expect(extractThreadId({ type: "session_meta", payload: { id: "" } })).toBeNull();
    expect(extractThreadId(null)).toBeNull();
  });
});

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
});

describe("CodexSpawner.wake — spawn orchestration", () => {
  const creds = { url: "https://chorus.test", apiKey: "cho_secret" };

  /** Build a spawner whose spawnImpl returns our fake child + records the call. */
  function makeSpawner({
    child,
    permissionMode = "yolo",
    getThreadId,
    setThreadId,
    getUsageSnapshot,
    setUsageSnapshot,
    codexPath = "/usr/bin/codex",
  } = {}) {
    const calls = {};
    const spawnImpl = vi.fn((command, argv, opts) => {
      calls.command = command;
      calls.argv = argv;
      calls.opts = opts;
      return child;
    });
    const spawner = new CodexSpawner({
      codexPath,
      spawnImpl,
      permissionMode,
      creds,
      platform: "linux",
      logger: { info() {}, warn() {}, error() {} },
      getThreadIdFn: getThreadId ?? (() => null),
      setThreadIdFn: setThreadId ?? (() => {}),
      getUsageSnapshotFn: getUsageSnapshot ?? (() => null),
      setUsageSnapshotFn: setUsageSnapshot ?? (() => {}),
      hasChorusMcpServerFn: () => true,
    });
    return { spawner, spawnImpl, calls };
  }

  it("new wake: spawns codex with the resolved Chorus pair in env, never argv", async () => {
    const child = makeFakeChild();
    const { spawner, calls } = makeSpawner({ child });
    const onChild = vi.fn();
    const p = spawner.wake({ prompt: "do the thing", sessionId: ANCHOR, isNew: true, onChild });
    // stream a thread.started then exit 0
    child.stdout.emit("data", JSON.stringify({ type: "thread.started", thread_id: TID }) + "\n");
    child.emit("close", 0);
    const result = await p;

    expect(calls.argv.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(calls.argv).not.toContain("resume");
    // prompt only on stdin, never argv
    expect(child.stdin.writes.join("")).toBe("do the thing");
    expect(calls.argv.join(" ")).not.toContain("do the thing");
    // daemon connection pair exported via env, headless flag set, key absent from argv
    expect(calls.opts.env.CHORUS_URL).toBe("https://chorus.test");
    expect(calls.opts.env.CHORUS_API_KEY).toBe("cho_secret");
    expect(calls.opts.env.CHORUS_DAEMON_HEADLESS).toBe("1");
    expect(calls.argv.join(" ")).not.toContain("cho_secret");
    // detached process group on POSIX (for interrupt parity)
    expect(calls.opts.detached).toBe(true);
    // onChild fired exactly once with the live child
    expect(onChild).toHaveBeenCalledTimes(1);
    expect(onChild).toHaveBeenCalledWith(child);
    // returns the captured thread id as the session id
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe(ANCHOR);
    expect(result.backendSessionId).toBe(TID);
  });

  it("overwrites stale inherited Chorus connection values", async () => {
    const child = makeFakeChild();
    const { spawner, calls } = makeSpawner({ child });
    const previousUrl = process.env.CHORUS_URL;
    const previousKey = process.env.CHORUS_API_KEY;
    process.env.CHORUS_URL = "https://stale.test";
    process.env.CHORUS_API_KEY = "cho_stale";
    try {
      const p = spawner.wake({ prompt: "x", sessionId: ANCHOR });
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

  it("logs a missing Chorus MCP entry once and still completes later wakes", async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    const children = [first, second];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const spawner = new CodexSpawner({
      codexPath: "/usr/bin/codex",
      platform: "linux",
      creds: { url: "https://chorus.test", apiKey: "cho_secret" },
      logger,
      hasChorusMcpServerFn: () => false,
      getThreadIdFn: () => null,
      setThreadIdFn: () => {},
      getUsageSnapshotFn: () => null,
      setUsageSnapshotFn: () => {},
      spawnImpl: () => children.shift(),
    });

    const wake1 = spawner.wake({ prompt: "first", sessionId: "first" });
    first.emit("close", 0);
    await wake1;
    const wake2 = spawner.wake({ prompt: "second", sessionId: "second" });
    second.emit("close", 0);
    await wake2;

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain("no [mcp_servers.chorus] entry");
  });

  it("persists anchor→thread_id immediately when a new run emits thread.started", async () => {
    const child = makeFakeChild();
    const setThreadId = vi.fn();
    const { spawner } = makeSpawner({ child, setThreadId });
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true });
    child.stdout.emit("data", JSON.stringify({ type: "thread.started", thread_id: TID }) + "\n");
    expect(setThreadId).toHaveBeenCalledWith(ANCHOR, TID);
    child.emit("close", 0);
    await p;
    expect(setThreadId).toHaveBeenCalledTimes(1);
  });

  it("retains the mapping when a new run establishes a thread then exits non-zero", async () => {
    const child = makeFakeChild();
    const setThreadId = vi.fn();
    const { spawner } = makeSpawner({ child, setThreadId });
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true });
    child.stdout.emit("data", JSON.stringify({ type: "thread.started", thread_id: TID }) + "\n");
    child.emit("close", 1);
    await p;
    expect(setThreadId).toHaveBeenCalledTimes(1);
    expect(setThreadId).toHaveBeenCalledWith(ANCHOR, TID);
  });

  it("persists exactly once when duplicate compatible identifier events arrive", async () => {
    const child = makeFakeChild();
    const setThreadId = vi.fn();
    const { spawner } = makeSpawner({ child, setThreadId });
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR });
    child.stdout.emit("data", JSON.stringify({ type: "thread.started", thread_id: TID }) + "\n");
    child.stdout.emit("data", JSON.stringify({ type: "session_meta", payload: { id: TID } }) + "\n");
    child.stdout.emit("data", JSON.stringify({ type: "thread.started", thread_id: TID }) + "\n");
    child.emit("close", 0);
    await p;
    expect(setThreadId).toHaveBeenCalledTimes(1);
    expect(setThreadId).toHaveBeenCalledWith(ANCHOR, TID);
  });

  it("persists a compatible session_meta identifier before child close", async () => {
    const child = makeFakeChild();
    const setThreadId = vi.fn();
    const { spawner } = makeSpawner({ child, setThreadId });
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR });
    child.stdout.emit("data", JSON.stringify({ type: "session_meta", payload: { id: TID } }) + "\n");
    expect(setThreadId).toHaveBeenCalledWith(ANCHOR, TID);
    child.emit("close", 0);
    await p;
  });

  it("does not persist when a new process fails before emitting a valid thread id", async () => {
    const child = makeFakeChild();
    const setThreadId = vi.fn();
    const { spawner } = makeSpawner({ child, setThreadId });
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR });
    child.stdout.emit("data", JSON.stringify({ type: "thread.started", thread_id: " " }) + "\n");
    child.stdout.emit("data", JSON.stringify({ type: "turn.failed", thread_id: ANCHOR }) + "\n");
    child.emit("close", 1);
    await p;
    expect(setThreadId).not.toHaveBeenCalled();
  });

  it("resume wake: a known anchor produces `exec resume <thread_id>` (ignores passed isNew)", async () => {
    const child = makeFakeChild();
    const { spawner, calls } = makeSpawner({ child, getThreadId: () => TID });
    // pass isNew:true but the map has a thread id → spawner must resume
    const p = spawner.wake({ prompt: "again", sessionId: ANCHOR, isNew: true });
    child.emit("close", 0);
    await p;
    expect(calls.argv.slice(0, 3)).toEqual(["exec", "resume", TID]);
  });

  it("forwards each parsed event to onMessage", async () => {
    const child = makeFakeChild();
    const { spawner } = makeSpawner({ child });
    const onMessage = vi.fn();
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true, onMessage });
    child.stdout.emit("data", JSON.stringify({ type: "thread.started", thread_id: TID }) + "\n");
    child.stdout.emit("data", JSON.stringify({ type: "turn.completed" }) + "\n");
    child.emit("close", 0);
    await p;
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("normalizes a resumed cumulative usage snapshot against the persisted baseline", async () => {
    const child = makeFakeChild();
    const baseline = {
      input_tokens: 13566,
      cached_input_tokens: 0,
      cache_write_input_tokens: 13564,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    };
    const setUsageSnapshot = vi.fn();
    const { spawner } = makeSpawner({
      child,
      getThreadId: () => TID,
      getUsageSnapshot: () => baseline,
      setUsageSnapshot,
    });
    const onMessage = vi.fn();
    const cumulative = {
      input_tokens: 31551,
      cached_input_tokens: 13564,
      cache_write_input_tokens: 17983,
      output_tokens: 10,
      reasoning_output_tokens: 0,
    };
    const p = spawner.wake({ prompt: "again", sessionId: ANCHOR, onMessage });
    child.stdout.emit("data", JSON.stringify({ type: "turn.completed", usage: cumulative }) + "\n");
    child.emit("close", 0);
    await p;

    expect(onMessage).toHaveBeenCalledWith({
      type: "turn.completed",
      usage: {
        input_tokens: 2,
        cached_input_tokens: 13564,
        cache_write_input_tokens: 4419,
        output_tokens: 5,
        reasoning_output_tokens: 0,
      },
    });
    expect(setUsageSnapshot).toHaveBeenCalledWith(ANCHOR, TID, cumulative);
  });

  it("seeds a missing baseline for an existing thread without publishing historical totals", async () => {
    const child = makeFakeChild();
    const setUsageSnapshot = vi.fn();
    const { spawner } = makeSpawner({
      child,
      getThreadId: () => TID,
      getUsageSnapshot: () => null,
      setUsageSnapshot,
    });
    const onMessage = vi.fn();
    const cumulative = { input_tokens: 500000, output_tokens: 4000 };
    const p = spawner.wake({ prompt: "upgrade turn", sessionId: ANCHOR, onMessage });
    child.stdout.emit("data", JSON.stringify({ type: "turn.completed", usage: cumulative }) + "\n");
    child.emit("close", 0);
    await p;

    expect(onMessage).toHaveBeenCalledWith({ type: "turn.completed", usage: null });
    expect(setUsageSnapshot).toHaveBeenCalledWith(ANCHOR, TID, cumulative);
  });

  it("never throws and returns exitCode:null when the codex executable is unresolved", async () => {
    const child = makeFakeChild();
    const { spawner, spawnImpl } = makeSpawner({ child, codexPath: null });
    // codexPath null AND resolver finds nothing → no spawn, no throw
    spawner.resolveCodexPathFn = () => null;
    const result = await spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result.exitCode).toBeNull();
  });

  it("never throws when spawn itself throws (returns exitCode:null)", async () => {
    const spawner = new CodexSpawner({
      codexPath: "/usr/bin/codex",
      spawnImpl: () => {
        throw new Error("EACCES");
      },
      permissionMode: "yolo",
      creds,
      platform: "linux",
      logger: { info() {}, warn() {}, error() {} },
      getThreadIdFn: () => null,
      setThreadIdFn: () => {},
    });
    const result = await spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true });
    expect(result.exitCode).toBeNull();
  });

  it("tolerates a thrown onChild without escaping the wake path", async () => {
    const child = makeFakeChild();
    const { spawner } = makeSpawner({ child });
    const p = spawner.wake({
      prompt: "x",
      sessionId: ANCHOR,
      isNew: true,
      onChild: () => {
        throw new Error("boom");
      },
    });
    child.emit("close", 0);
    const result = await p;
    expect(result.exitCode).toBe(0);
  });
});
