// cli/__tests__/codex-backend-integration.test.mjs
// Integration checkpoint for add-daemon-codex-backend (task 4): proves the Codex
// backend works through the REAL daemon wiring (tasks 1–3 together) and that the
// claude-code default does not regress.
//
//   1. Interrupt parity — the real CodexSpawner spawns a detached process group,
//      so the EXISTING killProcessTree (no new killer) group-signals its tree.
//   2. Default backend unchanged — buildDaemon with no agentType injects a
//      ClaudeSpawner.
//   3. Codex backend end-to-end — buildDaemon with agentType:"codex" injects a
//      CodexSpawner; driving its wake() through a fake spawn yields the expected
//      `codex exec --json` (new) and `codex exec resume <id>` (known anchor) argv,
//      prompt on stdin, daemon key in the child env (never argv).
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { buildDaemon } from "../daemon.mjs";
import { ClaudeSpawner } from "../claude-spawner.mjs";
import { CodexSpawner } from "../codex-spawner.mjs";
import { killProcessTree } from "../process-killer.mjs";

const CREDS = { url: "https://chorus.test", apiKey: "cho_daemonkey" };
const ANCHOR = "11111111-1111-4111-8111-111111111111";
const TID = "019f091a-844e-7b43-8c31-6b04ffa38149";
const silent = { info() {}, warn() {}, error() {} };

function makeFakeChild(pid = 9100) {
  const child = new EventEmitter();
  const stdin = new EventEmitter();
  stdin.writes = [];
  stdin.write = (c) => stdin.writes.push(String(c));
  stdin.end = vi.fn();
  child.stdin = stdin;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.pid = pid;
  return child;
}

describe("interrupt parity — CodexSpawner detached group is reaped by the existing killProcessTree", () => {
  it("CodexSpawner spawns detached on POSIX (process-group leader)", async () => {
    const child = makeFakeChild();
    let spawnOpts;
    const spawner = new CodexSpawner({
      codexPath: "/usr/bin/codex",
      platform: "linux",
      permissionMode: "yolo",
      creds: CREDS,
      logger: silent,
      getThreadIdFn: () => null,
      setThreadIdFn: () => {},
      spawnImpl: (_c, _a, opts) => {
        spawnOpts = opts;
        return child;
      },
    });
    const p = spawner.wake({ prompt: "x", sessionId: ANCHOR, isNew: true });
    child.emit("close", 0);
    await p;
    expect(spawnOpts.detached).toBe(true);
  });

  it("killProcessTree group-signals the Codex child's pid (negative pid) — same killer, no new code", async () => {
    const child = makeFakeChild(4321);
    const killImpl = vi.fn();
    const res = await killProcessTree(child, {
      platform: "linux",
      logger: silent,
      killImpl,
      sigintTimeoutMs: 20,
      waitForExit: vi.fn(async () => true),
    });
    expect(killImpl).toHaveBeenCalledWith(-4321, "SIGINT");
    expect(res).toMatchObject({ signaled: true, killed: true });
  });
});

describe("buildDaemon spawner selection (end-to-end wiring)", () => {
  it("default (no agentType) injects a ClaudeSpawner — claude-code unchanged", () => {
    const daemon = buildDaemon(CREDS, { logger: silent, permissionMode: "yolo" });
    expect(daemon.spawner).toBeInstanceOf(ClaudeSpawner);
  });

  it("agentType 'codex' injects a CodexSpawner carrying creds + permissionMode", () => {
    const daemon = buildDaemon(CREDS, { logger: silent, permissionMode: "yolo", agentType: "codex" });
    expect(daemon.spawner).toBeInstanceOf(CodexSpawner);
    expect(daemon.spawner.permissionMode).toBe("yolo");
    expect(daemon.spawner.creds).toEqual(CREDS);
  });
});

describe("codex backend end-to-end argv (via the daemon-selected spawner)", () => {
  /** Build a daemon, grab its CodexSpawner, and drive wake() with a fake spawn. */
  function codexSpawnerWithFakeSpawn({ getThreadId } = {}) {
    const daemon = buildDaemon(CREDS, { logger: silent, permissionMode: "yolo", agentType: "codex" });
    const spawner = daemon.spawner;
    // Inject test seams onto the real selected spawner.
    spawner.codexPath = "/usr/bin/codex";
    spawner.platform = "linux";
    spawner.getThreadIdFn = getThreadId ?? (() => null);
    spawner.setThreadIdFn = vi.fn();
    const calls = {};
    spawner.spawnImpl = (command, argv, opts) => {
      calls.command = command;
      calls.argv = argv;
      calls.opts = opts;
      return makeFakeChild();
    };
    return { spawner, calls };
  }

  it("NEW anchor → `codex exec --json …`, prompt on stdin, daemon key in env not argv", async () => {
    const { spawner, calls } = codexSpawnerWithFakeSpawn({ getThreadId: () => null });
    const child = makeFakeChild();
    spawner.spawnImpl = (command, argv, opts) => {
      calls.command = command;
      calls.argv = argv;
      calls.opts = opts;
      return child;
    };
    const p = spawner.wake({ prompt: "wake up codex", sessionId: ANCHOR, isNew: true });
    child.stdout.emit("data", JSON.stringify({ type: "thread.started", thread_id: TID }) + "\n");
    child.emit("close", 0);
    await p;

    expect(calls.command).toBe("/usr/bin/codex");
    expect(calls.argv.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(calls.argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(calls.argv).not.toContain("resume");
    expect(child.stdin.writes.join("")).toBe("wake up codex");
    expect(calls.argv.join(" ")).not.toContain("wake up codex");
    expect(calls.opts.env.CHORUS_API_KEY).toBe("cho_daemonkey");
    expect(calls.opts.env.CHORUS_DAEMON_HEADLESS).toBe("1");
    expect(calls.argv.join(" ")).not.toContain("cho_daemonkey");
  });

  it("KNOWN anchor (map hit) → `codex exec resume <thread_id> --json`", async () => {
    const { spawner, calls } = codexSpawnerWithFakeSpawn({ getThreadId: () => TID });
    const child = makeFakeChild();
    spawner.spawnImpl = (command, argv, opts) => {
      calls.argv = argv;
      calls.opts = opts;
      return child;
    };
    const p = spawner.wake({ prompt: "continue", sessionId: ANCHOR, isNew: true });
    child.emit("close", 0);
    await p;
    expect(calls.argv.slice(0, 4)).toEqual(["exec", "resume", TID, "--json"]);
  });
});
