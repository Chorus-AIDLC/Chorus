// cli/__tests__/kiro-backend-integration.test.mjs
// Integration checkpoint for add-daemon-kiro-backend (task 5): proves the Kiro
// backend works through the REAL daemon wiring (tasks 1–4 together) and that the
// claude-code default + codex backend do not regress.
//
//   1. Interrupt parity — the real KiroSpawner spawns a detached process group,
//      so the EXISTING killProcessTree (no new killer) group-signals its tree.
//   2. Backend selection unchanged — buildDaemon with no agentType injects a
//      ClaudeSpawner; agentType:"codex" a CodexSpawner; agentType:"kiro" a KiroSpawner.
//   3. Kiro backend end-to-end — driving the daemon-selected KiroSpawner's wake()
//      through a fake spawn yields the expected `kiro-cli chat --no-interactive
//      --agent chorus` (new) and `+ --resume-id <id>` (known anchor) argv, prompt on
//      stdin, daemon key in the child env (never argv).
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { buildDaemon } from "../daemon.mjs";
import { ClaudeSpawner } from "../claude-spawner.mjs";
import { CodexSpawner } from "../codex-spawner.mjs";
import { KiroSpawner } from "../kiro-spawner.mjs";
import { killProcessTree } from "../process-killer.mjs";

const CREDS = { url: "https://chorus.test", apiKey: "cho_daemonkey" };
const ANCHOR = "11111111-1111-4111-8111-111111111111";
const SID = "540019be-35ec-4740-8880-a6c83f172646";
const silent = { info() {}, warn() {}, error() {} };

function makeFakeChild(pid = 9200) {
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

describe("interrupt parity — KiroSpawner detached group is reaped by the existing killProcessTree", () => {
  it("KiroSpawner spawns detached on POSIX (process-group leader)", async () => {
    const child = makeFakeChild();
    let spawnOpts;
    const spawner = new KiroSpawner({
      kiroPath: "/usr/bin/kiro-cli",
      platform: "linux",
      permissionMode: "yolo",
      creds: CREDS,
      logger: silent,
      getSessionIdFn: () => null,
      setSessionIdFn: () => {},
      snapshotSessionsFn: () => new Map(),
      reconstructTranscript: null,
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

  it("killProcessTree group-signals the Kiro child's pid (negative pid) — same killer, no new code", async () => {
    const child = makeFakeChild(4322);
    const killImpl = vi.fn();
    const res = await killProcessTree(child, {
      platform: "linux",
      logger: silent,
      killImpl,
      sigintTimeoutMs: 20,
      waitForExit: vi.fn(async () => true),
    });
    expect(killImpl).toHaveBeenCalledWith(-4322, "SIGINT");
    expect(res).toMatchObject({ signaled: true, killed: true });
  });
});

describe("buildDaemon spawner selection (end-to-end wiring, all three backends)", () => {
  it("default (no agentType) injects a ClaudeSpawner — claude-code unchanged", () => {
    const daemon = buildDaemon(CREDS, { logger: silent, permissionMode: "yolo" });
    expect(daemon.spawner).toBeInstanceOf(ClaudeSpawner);
  });

  it("agentType 'codex' injects a CodexSpawner — codex unchanged", () => {
    const daemon = buildDaemon(CREDS, { logger: silent, permissionMode: "yolo", agentType: "codex" });
    expect(daemon.spawner).toBeInstanceOf(CodexSpawner);
  });

  it("agentType 'kiro' injects a KiroSpawner carrying creds + permissionMode", () => {
    const daemon = buildDaemon(CREDS, { logger: silent, permissionMode: "yolo", agentType: "kiro" });
    expect(daemon.spawner).toBeInstanceOf(KiroSpawner);
    expect(daemon.spawner.permissionMode).toBe("yolo");
    expect(daemon.spawner.creds).toEqual(CREDS);
  });
});

describe("kiro backend end-to-end argv (via the daemon-selected spawner)", () => {
  /** Build a daemon, grab its KiroSpawner, and drive wake() with a fake spawn. */
  function kiroSpawnerWithFakeSpawn({ getSessionId } = {}) {
    const daemon = buildDaemon(CREDS, { logger: silent, permissionMode: "yolo", agentType: "kiro" });
    const spawner = daemon.spawner;
    // Inject test seams onto the real selected spawner.
    spawner.kiroPath = "/usr/bin/kiro-cli";
    spawner.platform = "linux";
    spawner.getSessionIdFn = getSessionId ?? (() => null);
    spawner.setSessionIdFn = vi.fn();
    spawner.snapshotSessionsFn = () => new Map();
    spawner.reconstructTranscript = null; // isolate from the real ~/.kiro store
    const calls = {};
    const child = makeFakeChild();
    spawner.spawnImpl = (command, argv, opts) => {
      calls.command = command;
      calls.argv = argv;
      calls.opts = opts;
      return child;
    };
    return { spawner, calls, child };
  }

  it("NEW anchor → prompt on stdin, daemon connection pair in env not argv", async () => {
    const { spawner, calls, child } = kiroSpawnerWithFakeSpawn({ getSessionId: () => null });
    const p = spawner.wake({ prompt: "wake up kiro", sessionId: ANCHOR, isNew: true });
    child.stdout.emit("data", "plain text turn output\n");
    child.emit("close", 0);
    await p;

    expect(calls.command).toBe("/usr/bin/kiro-cli");
    expect(calls.argv.slice(0, 4)).toEqual(["chat", "--no-interactive", "--agent", "chorus"]);
    expect(calls.argv).toContain("--trust-all-tools");
    expect(calls.argv).not.toContain("--resume-id");
    expect(calls.argv).not.toContain("--v3");
    expect(child.stdin.writes.join("")).toBe("wake up kiro");
    expect(calls.argv.join(" ")).not.toContain("wake up kiro");
    expect(calls.opts.env.CHORUS_URL).toBe("https://chorus.test");
    expect(calls.opts.env.CHORUS_API_KEY).toBe("cho_daemonkey");
    expect(calls.opts.env.CHORUS_DAEMON_HEADLESS).toBe("1");
    expect(calls.argv.join(" ")).not.toContain("cho_daemonkey");
  });

  it("KNOWN anchor (map hit) → `kiro-cli chat --no-interactive --resume-id <sessionId> --agent chorus`", async () => {
    const { spawner, calls, child } = kiroSpawnerWithFakeSpawn({ getSessionId: () => SID });
    const p = spawner.wake({ prompt: "continue", sessionId: ANCHOR, isNew: true });
    child.emit("close", 0);
    await p;
    expect(calls.argv.slice(0, 3)).toEqual(["chat", "--no-interactive", "--resume-id"]);
    expect(calls.argv[3]).toBe(SID);
    expect(calls.argv.slice(4, 6)).toEqual(["--agent", "chorus"]);
  });
});
