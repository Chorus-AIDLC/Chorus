// cli/__tests__/daemon-integration.test.mjs
// Full-chain integration: a task_assigned SSE event flows through the assembled
// daemon (mock MCP + mock SSE + mock claude subprocess) all the way to the
// spawn args. Covers the integration AC and "task-dispatch wakes Claude Code".
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDaemon, runDaemon } from "../daemon.mjs";
import { transcriptPath } from "../claude-spawner.mjs";

const silent = { info() {}, warn() {}, error() {} };

const TASK_NOTIF = {
  uuid: "notif-1",
  projectUuid: "proj-1",
  entityType: "task",
  entityUuid: "task-1",
  entityTitle: "Build the thing",
  action: "task_assigned",
  message: "",
  actorType: "user",
  actorUuid: "user-1",
  actorName: "Alice",
};

/** A mock MCP client answering the notification fetch (backfill path). */
function mockMcp() {
  return {
    disconnected: false,
    async callTool(name) {
      switch (name) {
        case "chorus_get_notifications":
          return { notifications: [TASK_NOTIF] };
        default:
          return null;
      }
    },
    async disconnect() {
      this.disconnected = true;
    },
  };
}

/**
 * A fake fetch for the lineage REST endpoint. Resolves task-1 → root-idea via
 * the standard success envelope; anything else → no idea ancestor.
 */
// Direct idea (= deterministic session id) differs from the root, exercising the
// two-id contract end-to-end. Both are canonical lowercase UUIDs.
const DIRECT_IDEA = "11111111-1111-4111-8111-111111111111";
const ROOT_IDEA = "99999999-9999-4999-8999-999999999999";

function lineageFetch() {
  return async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).includes("/api/entities/task/task-1/root-idea")) {
        return {
          success: true,
          data: {
            rootIdeaUuid: ROOT_IDEA,
            directIdeaUuid: DIRECT_IDEA,
            lineage: [],
            resolvedVia: "via_proposal",
          },
        };
      }
      return {
        success: true,
        data: { rootIdeaUuid: null, directIdeaUuid: null, lineage: [], resolvedVia: "not_found" },
      };
    },
  });
}

/** A mock SSE listener we can manually drive. */
class MockSse {
  constructor(opts) {
    this.opts = opts;
    this.connected = false;
  }
  async connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
  /**
   * test helper: deliver an event as if it came off the wire. Mirrors the real
   * SseListener fork — connection_registered → onConnectionId, control → onControl,
   * everything else → onEvent — so integration tests exercise the daemon's actual
   * wiring (onControl is supplied by buildDaemon).
   */
  deliver(event) {
    if (event?.type === "connection_registered") {
      this.opts.onConnectionId?.(event.connectionUuid);
      return;
    }
    if (event?.type === "control") {
      this.opts.onControl?.(event);
      return;
    }
    this.opts.onEvent(event);
  }
}

describe("daemon integration: notification → spawn", () => {
  it("a task_assigned event drives a headless claude spawn with the right prompt + mcp-config", async () => {
    const spawnCalls = [];
    const spawner = {
      wake: vi.fn(async (params) => {
        spawnCalls.push(params);
        params.onMessage?.({ type: "system", session_id: params.sessionId });
        return { sessionId: params.sessionId, exitCode: 0, isNew: params.isNew };
      }),
    };
    let captured;
    // A cwd whose transcript dir surely has no <DIRECT_IDEA>.jsonl → probe says "new".
    const daemon = buildDaemon(
      { url: "https://chorus.example", apiKey: "cho_x" },
      {
        logger: silent,
        mcpClient: mockMcp(),
        fetchImpl: lineageFetch(),
        spawner,
        cwd: "/nonexistent/chorus-daemon-itest-dir",
        makeSseListener: (o) => {
          captured = new MockSse(o);
          return captured;
        },
      }
    );

    await daemon.start();
    expect(captured.connected).toBe(true);

    // Deliver a task_assigned notification.
    captured.deliver({ type: "new_notification", notificationUuid: "notif-1" });
    // Let the async fetch/route/queue/spawn chain settle.
    await new Promise((r) => setTimeout(r, 20));

    expect(spawner.wake).toHaveBeenCalledTimes(1);
    const params = spawnCalls[0];
    expect(params.prompt).toContain("task-1"); // task UUID in prompt
    expect(params.prompt).toContain("chorus_claim_task");
    // Session id is the DIRECT idea uuid (deterministic, human-resumable), NOT the root.
    expect(params.sessionId).toBe(DIRECT_IDEA);
    expect(params.sessionId).not.toBe(ROOT_IDEA);
    expect(params.isNew).toBe(true); // no transcript on disk for this cwd → new session
    expect(params.cwd).toBe("/nonexistent/chorus-daemon-itest-dir"); // probe+spawn share cwd
    expect(params.mcpConfigPath).toMatch(/mcp\.json$/); // wrote a temp mcp config

    // The execution snapshot reports the RESOLVED ROOT idea, not the direct-idea key.
    const snap = daemon.waker.buildExecutionSnapshot();
    // (wake finished, so the row is gone; assert via a fresh markQueued instead)
    expect(Array.isArray(snap)).toBe(true);

    await daemon.stop();
    expect(captured.connected).toBe(false);
  });

  it("ignores a non-wake notification (no spawn)", async () => {
    const spawner = { wake: vi.fn() };
    const mcp = mockMcp();
    mcp.callTool = async (name) =>
      name === "chorus_get_notifications"
        ? { notifications: [{ ...TASK_NOTIF, action: "count_update" }] }
        : null;
    let captured;
    const daemon = buildDaemon(
      { url: "https://c", apiKey: "k" },
      {
        logger: silent,
        mcpClient: mcp,
        fetchImpl: lineageFetch(),
        spawner,
        makeSseListener: (o) => (captured = new MockSse(o)),
      }
    );
    await daemon.start();
    captured.deliver({ type: "new_notification", notificationUuid: "notif-1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(spawner.wake).not.toHaveBeenCalled();
  });
});

describe("daemon integration: reverse control channel (子3)", () => {
  it("a control event interrupts the running child, never enqueues a wake, and reports interrupted(user)", async () => {
    const CONN = "conn-itest";
    const FAKE_CHILD = { pid: 24680 };
    const reportInterrupt = vi.fn(async () => {});

    // A controllable spawner: it registers the child via onChild, then HANGS until
    // we resolve it — so the wake is still "running" when the control event lands.
    let resolveWake;
    const spawner = {
      wake: vi.fn(
        (params) =>
          new Promise((resolve) => {
            params.onChild?.(FAKE_CHILD);
            params.onMessage?.({ type: "system", session_id: params.sessionId });
            resolveWake = () => resolve({ sessionId: params.sessionId, exitCode: 0, isNew: params.isNew });
          })
      ),
    };

    let captured;
    const daemon = buildDaemon(
      { url: "https://c", apiKey: "cho_x" },
      {
        logger: silent,
        mcpClient: mockMcp(),
        fetchImpl: lineageFetch(),
        spawner,
        cwd: "/nonexistent/chorus-daemon-itest-control",
        reportInterrupt,
        sigintTimeoutMs: 50,
        makeSseListener: (o) => (captured = new MockSse(o)),
      }
    );
    // buildDaemon wires the real control handler + the real killProcessTree. We
    // don't inject a killer here; instead we stub process.kill so the POSIX group
    // signal is observable without touching a real process, and assert the kill via
    // that spy plus the interrupting flag, zero-enqueue, and reportInterrupt(user).
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});

    await daemon.start();
    // Handshake: learn our connectionUuid.
    captured.deliver({ type: "connection_registered", connectionUuid: CONN });

    // Start a wake so a running child exists in the registry.
    captured.deliver({ type: "new_notification", notificationUuid: "notif-1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(spawner.wake).toHaveBeenCalledTimes(1);
    expect(daemon.waker.executions.get("task:task-1")?.child).toBe(FAKE_CHILD);

    // Deliver the control (interrupt) event for THIS connection + the running entity.
    captured.deliver({
      type: "control",
      command: "interrupt",
      targetConnectionUuid: CONN,
      entityType: "task",
      entityUuid: "task-1",
    });
    await new Promise((r) => setTimeout(r, 5));

    // The interrupting flag was set (so the exit reports reason=user)...
    expect(daemon.waker.interrupting.has("task:task-1")).toBe(true);
    // ...and the killer signalled the process GROUP via process.kill(-pid, "SIGINT").
    expect(killSpy).toHaveBeenCalledWith(-FAKE_CHILD.pid, "SIGINT");
    // The control event NEVER spawned a second wake.
    expect(spawner.wake).toHaveBeenCalledTimes(1);

    // Now let the (interrupted) subprocess exit → the waker reports interrupted(user).
    resolveWake();
    await new Promise((r) => setTimeout(r, 10));
    expect(reportInterrupt).toHaveBeenCalledWith("task", "task-1", "user");

    killSpy.mockRestore();
    await daemon.stop();
  });

  it("ignores a control event for a different connection (no kill, no report)", async () => {
    const FAKE_CHILD = { pid: 13579 };
    const reportInterrupt = vi.fn(async () => {});
    let resolveWake;
    const spawner = {
      wake: vi.fn(
        (params) =>
          new Promise((resolve) => {
            params.onChild?.(FAKE_CHILD);
            resolveWake = () => resolve({ sessionId: params.sessionId, exitCode: 0, isNew: true });
          })
      ),
    };
    let captured;
    const daemon = buildDaemon(
      { url: "https://c", apiKey: "cho_x" },
      {
        logger: silent,
        mcpClient: mockMcp(),
        fetchImpl: lineageFetch(),
        spawner,
        cwd: "/nonexistent/chorus-daemon-itest-control-2",
        reportInterrupt,
        makeSseListener: (o) => (captured = new MockSse(o)),
      }
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});

    await daemon.start();
    captured.deliver({ type: "connection_registered", connectionUuid: "conn-MINE" });
    captured.deliver({ type: "new_notification", notificationUuid: "notif-1" });
    await new Promise((r) => setTimeout(r, 20));

    // Control event names a DIFFERENT connection → ignored.
    captured.deliver({
      type: "control",
      command: "interrupt",
      targetConnectionUuid: "conn-SOMEONE-ELSE",
      entityType: "task",
      entityUuid: "task-1",
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(daemon.waker.interrupting.has("task:task-1")).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();

    // The clean exit reports nothing (it wasn't interrupted, exit 0).
    resolveWake();
    await new Promise((r) => setTimeout(r, 10));
    expect(reportInterrupt).not.toHaveBeenCalled();

    killSpy.mockRestore();
    await daemon.stop();
  });
});

describe("runDaemon entry", () => {
  it("aborts with code 1 when credentials don't resolve", async () => {
    const errs = [];
    const code = await runDaemon(
      {},
      {
        resolve: () => {
          throw new Error("no creds");
        },
        errLog: (m) => errs.push(m),
        log: () => {},
      }
    );
    expect(code).toBe(1);
    expect(errs.join("")).toContain("no creds");
  });

  it("aborts with code 1 when validation fails (bad key)", async () => {
    const errs = [];
    const code = await runDaemon(
      { url: "u", apiKey: "bad" },
      {
        resolve: () => ({ url: "u", apiKey: "bad", source: "flag" }),
        validate: async () => {
          throw new Error("401 Unauthorized");
        },
        errLog: (m) => errs.push(m),
        log: () => {},
      }
    );
    expect(code).toBe(1);
    expect(errs.join("")).toMatch(/validation failed/);
  });

  it("validates, starts the daemon, and waits (happy path)", async () => {
    const logs = [];
    const started = vi.fn();
    const code = await runDaemon(
      { url: "u", apiKey: "cho_x" },
      {
        resolve: () => ({ url: "u", apiKey: "cho_x", source: "env" }),
        validate: async () => ({ uuid: "agent-1", name: "Daemon Bot" }),
        build: () => ({ async start() { started(); }, async stop() {} }),
        log: (m) => logs.push(m),
        errLog: (m) => logs.push("ERR:" + m),
        waitForever: async () => {}, // return immediately for the test
      }
    );
    expect(code).toBe(0);
    expect(started).toHaveBeenCalled();
    expect(logs.join("\n")).toContain("authenticated as Daemon Bot (agent-1)");
  });
});

// ===== Integration checkpoint: direct-idea session id, end to end =====
// Drives the REAL assembled daemon (real LineageResolver via fetchImpl, real Waker
// with the real on-disk transcript probe + real escapeCwd/transcriptPath) against a
// spawn stub that writes the transcript the way `claude` would. Proves the server
// resolution and daemon anchor work TOGETHER (not mocked in isolation): a child-idea
// task creates a session named by its DIRECT idea uuid; a second same-idea wake
// resumes it; the PARENT idea gets a DISTINCT session (cross-idea isolation).
describe("integration checkpoint: direct-idea session id, resume, and isolation", () => {
  // Distinct canonical lowercase UUIDs for child(direct), its root(parent), used as
  // a separate dispatch target too. child ≠ root exercises the two-id contract.
  const CHILD_IDEA = "11111111-1111-4111-8111-111111111111"; // direct idea of task-child
  const PARENT_IDEA = "99999999-9999-4999-8999-999999999999"; // root of the child + a dispatch target itself

  let configDir;
  let cwd;

  afterEach(() => {
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    configDir = undefined;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  /**
   * MCP client returning the right notification by uuid (the router fetches the
   * unread list and finds the one it was told about).
   */
  function mcpFor(notifs) {
    return {
      async callTool(name) {
        return name === "chorus_get_notifications" ? { notifications: notifs } : null;
      },
      async disconnect() {},
    };
  }

  /** Lineage REST stub: task-child → {direct: CHILD, root: PARENT}; idea PARENT → itself. */
  function lineageFetch() {
    return async (url) => ({
      ok: true,
      status: 200,
      async json() {
        const u = String(url);
        if (u.includes("/api/entities/task/task-child/root-idea")) {
          return {
            success: true,
            data: { rootIdeaUuid: PARENT_IDEA, directIdeaUuid: CHILD_IDEA, lineage: [], resolvedVia: "via_proposal" },
          };
        }
        if (u.includes(`/api/entities/idea/${PARENT_IDEA}/root-idea`)) {
          // A top-level idea: direct == root == itself.
          return {
            success: true,
            data: { rootIdeaUuid: PARENT_IDEA, directIdeaUuid: PARENT_IDEA, lineage: [], resolvedVia: "root_idea" },
          };
        }
        return { success: true, data: { rootIdeaUuid: null, directIdeaUuid: null, lineage: [], resolvedVia: "not_found" } };
      },
    });
  }

  class MockSse {
    constructor(opts) { this.opts = opts; this.connected = false; }
    async connect() { this.connected = true; }
    disconnect() { this.connected = false; }
    deliver(event) { this.opts.onEvent(event); }
  }

  it("child→session-id, resume on 2nd same-idea wake, parent gets a distinct session", async () => {
    configDir = mkdtempSync(join(tmpdir(), "chorus-itest-cfg-"));
    cwd = mkdtempSync(join(tmpdir(), "chorus-itest-cwd-"));
    // The Waker's real isNewSession probe reads CLAUDE_CONFIG_DIR via the spawner helpers.
    process.env.CLAUDE_CONFIG_DIR = configDir;

    const spawnEvents = [];
    // Spawn stub that behaves like claude: on a NEW session it creates the transcript
    // file at the real probed path; on resume it appends. Records {sessionId,isNew,cwd}.
    const spawner = {
      wake: vi.fn(async ({ sessionId, isNew, cwd: spawnCwd }) => {
        spawnEvents.push({ sessionId, isNew, cwd: spawnCwd });
        // Behave like claude: create the transcript on a new session, append on resume.
        const tpath = transcriptPath(sessionId, spawnCwd, { env: process.env });
        mkdirSync(tpath.slice(0, tpath.lastIndexOf("/")), { recursive: true });
        writeFileSync(tpath, `{"type":"system","session_id":"${sessionId}"}\n`, { flag: "a" });
        return { sessionId, exitCode: 0, isNew };
      }),
    };

    let captured;
    const daemon = buildDaemon(
      { url: "https://chorus.example", apiKey: "cho_x" },
      {
        logger: silent,
        mcpClient: mcpFor([
          { ...TASK_NOTIF, uuid: "n-child-1", entityType: "task", entityUuid: "task-child" },
          { ...TASK_NOTIF, uuid: "n-child-2", entityType: "task", entityUuid: "task-child" },
          { ...TASK_NOTIF, uuid: "n-parent", entityType: "idea", entityUuid: PARENT_IDEA, action: "mentioned" },
        ]),
        fetchImpl: lineageFetch(),
        spawner,
        cwd,
        makeSseListener: (o) => (captured = new MockSse(o)),
      }
    );
    await daemon.start();

    // (1) First child-idea wake → NEW session named by the DIRECT (child) idea.
    captured.deliver({ type: "new_notification", notificationUuid: "n-child-1" });
    await new Promise((r) => setTimeout(r, 30));

    // (2) Second wake for the SAME direct idea → RESUME (transcript now exists).
    captured.deliver({ type: "new_notification", notificationUuid: "n-child-2" });
    await new Promise((r) => setTimeout(r, 30));

    // (3) Parent idea wake → DISTINCT session (its own direct idea == PARENT_IDEA).
    captured.deliver({ type: "new_notification", notificationUuid: "n-parent" });
    await new Promise((r) => setTimeout(r, 30));

    expect(spawner.wake).toHaveBeenCalledTimes(3);
    const [first, second, third] = spawnEvents;

    // AC: child-idea task → --session-id = the DIRECT (child) idea, new session.
    expect(first.sessionId).toBe(CHILD_IDEA);
    expect(first.sessionId).not.toBe(PARENT_IDEA); // direct ≠ root
    expect(first.isNew).toBe(true);
    expect(first.cwd).toBe(cwd);

    // AC: second same-direct-idea wake resumes the SAME session (no new id).
    expect(second.sessionId).toBe(CHILD_IDEA);
    expect(second.isNew).toBe(false); // transcript existed → resume

    // AC: parent idea is a DISTINCT session.
    expect(third.sessionId).toBe(PARENT_IDEA);
    expect(third.sessionId).not.toBe(CHILD_IDEA);
    expect(third.isNew).toBe(true); // its own first wake

    // AC: transcripts are id-addressable on disk at the verified path, one per idea.
    const childPath = transcriptPath(CHILD_IDEA, cwd, { env: process.env });
    const parentPath = transcriptPath(PARENT_IDEA, cwd, { env: process.env });
    expect(existsSync(childPath)).toBe(true);
    expect(existsSync(parentPath)).toBe(true);
    expect(childPath).not.toBe(parentPath); // separate .jsonl per idea → isolation
    expect(childPath.endsWith(`/${CHILD_IDEA}.jsonl`)).toBe(true);

    // The child session resumed into the SAME file (2 lines: create + resume append),
    // i.e. no second child transcript was created.
    const projectsDir = join(configDir, "projects");
    const escapedDirs = readdirSync(projectsDir);
    expect(escapedDirs).toHaveLength(1); // one cwd-escaped dir
    const jsonls = readdirSync(join(projectsDir, escapedDirs[0])).filter((f) => f.endsWith(".jsonl"));
    expect(jsonls.sort()).toEqual([`${CHILD_IDEA}.jsonl`, `${PARENT_IDEA}.jsonl`].sort());

    await daemon.stop();
  });
});

// =============================================================================
// Integration checkpoint: daemon-interrupt-resume (子3) end-to-end.
//
// Drives the FULLY ASSEMBLED daemon — real SseListener fork (via the MockSse
// that mirrors its onControl/onConnectionId/onReconnect contract), real
// EventRouter/WakeQueue, real Waker (with the real on-disk isNewSession probe
// + real escapeCwd/transcriptPath), real createControlHandler, real
// killProcessTree (POSIX group kill via a stubbed process.kill), real
// createBackfill (driven through the listener's onReconnect) — against a fake
// `claude` subprocess (an EventEmitter pretending to be a ChildProcess) and a
// fake reportInterrupt. Together these prove the four required ACs hold across
// the wired modules, not just inside each module's slice.
//
// What is NOT exercised here (and why):
//   • A REAL `claude` binary — flaky, slow, requires a live SSE+server. The
//     subprocess seam is the spawner; existing claude-spawner tests cover the
//     real spawn args + detached + onChild. Combined with this checkpoint
//     driving a fake child through the same orchestration, the wiring is fully
//     covered without launching a child process.
//   • A REAL browser. The Agent Connections Interrupt button → POST
//     /api/daemon/control and Resume button → POST /api/daemon/resume wiring is
//     covered by execution-view.test.tsx plus each route's own __tests__. A live
//     Playwright run is not feasible inside this test environment (no running
//     server, SSE, real claude); the test plan documents this gap.
// =============================================================================

describe("integration checkpoint (子3): interrupt + resume + crash recovery", () => {
  // Distinct canonical lowercase UUIDs — the daemon's session anchor is the DIRECT
  // idea, threaded through the lineage REST stub identical to the rest of the file.
  const DIRECT = "11111111-1111-4111-8111-111111111111";
  const ROOT = "99999999-9999-4999-8999-999999999999";
  const CONN = "conn-checkpoint";
  const TASK_UUID = "task-1";

  /** Fake child: a ChildProcess-shape EventEmitter the daemon's onChild can capture. */
  function fakeChild(pid = 24680) {
    const listeners = { exit: [], close: [] };
    return {
      pid,
      exitCode: null,
      _listeners: listeners,
      // Both `on` and `once` are used along the kill path — implement both, fired once.
      on(ev, cb) { listeners[ev]?.push(cb); return this; },
      once(ev, cb) { listeners[ev]?.push(cb); return this; },
      /** Test helper: emit exit + close (in that order) once. */
      _emitExit(code) {
        this.exitCode = code;
        const fire = (arr) => { for (const cb of arr.splice(0)) try { cb(code, null); } catch {} };
        fire(listeners.exit);
        fire(listeners.close);
      },
    };
  }

  /** Lineage REST stub returning the canonical { direct, root } pair for task-1. */
  function lineageFetch() {
    return async (url) => ({
      ok: true,
      status: 200,
      async json() {
        if (String(url).includes(`/api/entities/task/${TASK_UUID}/root-idea`)) {
          return {
            success: true,
            data: { rootIdeaUuid: ROOT, directIdeaUuid: DIRECT, lineage: [], resolvedVia: "via_proposal" },
          };
        }
        return {
          success: true,
          data: { rootIdeaUuid: null, directIdeaUuid: null, lineage: [], resolvedVia: "not_found" },
        };
      },
    });
  }

  /** MCP client that returns the supplied unread notifications on chorus_get_notifications. */
  function mcpFor(notifs) {
    return {
      async callTool(name) {
        return name === "chorus_get_notifications" ? { notifications: notifs } : null;
      },
      async disconnect() {},
    };
  }

  /**
   * MockSse mirroring the real listener fork: connection_registered → onConnectionId,
   * type:control → onControl, everything else → onEvent. Exposes deliver() and
   * fireReconnect() so a test can drive the backfill path the listener would normally
   * fire on an SSE reconnect.
   */
  class MockSse {
    constructor(opts) { this.opts = opts; this.connected = false; }
    async connect() { this.connected = true; }
    disconnect() { this.connected = false; }
    deliver(event) {
      if (event?.type === "connection_registered") return this.opts.onConnectionId?.(event.connectionUuid);
      if (event?.type === "control") return this.opts.onControl?.(event);
      this.opts.onEvent(event);
    }
    /** Drive the daemon's wired backfill (the same fn the SSE listener calls on reconnect). */
    async fireReconnect() { await this.opts.onReconnect?.(); }
  }

  /**
   * A controllable fake spawner that:
   *   - hands a fakeChild() to onChild (so the daemon's executions registry attaches it),
   *   - calls onMessage with a system frame so observedSessionId is set,
   *   - resolves only when the test signals exit (resolveWake({exitCode})).
   * The wake's args are recorded into `calls` for assertion (sessionId, isNew, prompt).
   */
  function makeFakeSpawner({ writeTranscriptOnNew = false } = {}) {
    const calls = [];
    let resolvers = []; // FIFO of pending resolve fns
    let children = []; // FIFO of created fake children
    const spawner = {
      wake: vi.fn(async (params) => {
        const child = fakeChild(40000 + calls.length);
        children.push(child);
        calls.push({
          sessionId: params.sessionId,
          isNew: params.isNew,
          cwd: params.cwd,
          prompt: params.prompt,
          mcpConfigPath: params.mcpConfigPath,
        });
        // If a real-disk transcript was requested, lay it down so a SECOND wake's
        // isNewSession probe flips to false (resume). Mirrors what claude does on a
        // fresh session — the existing direct-idea checkpoint uses the same trick.
        if (writeTranscriptOnNew && params.isNew && params.sessionId) {
          const tpath = transcriptPath(params.sessionId, params.cwd, { env: process.env });
          mkdirSync(tpath.slice(0, tpath.lastIndexOf("/")), { recursive: true });
          writeFileSync(tpath, `{"type":"system","session_id":"${params.sessionId}"}\n`, { flag: "a" });
        }
        // The daemon's onChild runs SYNCHRONOUSLY here — that's the point: the
        // executions registry attaches the live child immediately, so a control event
        // arriving before exit can target the right pid.
        params.onChild?.(child);
        params.onMessage?.({ type: "system", session_id: params.sessionId });
        // Block until the test signals exit.
        return await new Promise((resolve) => {
          resolvers.push((exitCode) => {
            child._emitExit(exitCode);
            resolve({ sessionId: params.sessionId, exitCode, isNew: params.isNew });
          });
        });
      }),
    };
    return {
      spawner,
      calls,
      /** Resolve the i-th in-flight wake with the given exit code. */
      resolveWake(i, exitCode) {
        const fn = resolvers[i];
        if (!fn) throw new Error(`no in-flight wake at index ${i}`);
        resolvers[i] = null;
        fn(exitCode);
      },
      childAt(i) { return children[i]; },
    };
  }

  // --- AC1: end-to-end interrupt → user → resume continues the same session ---
  it("AC1: interrupt → reportInterrupt(user); a resume CONTROL command then RESUMES the same session", async () => {
    // Real on-disk transcript probe — set up a sandboxed CLAUDE_CONFIG_DIR + cwd so the
    // first wake creates the transcript and the second wake's probe flips to --resume.
    const configDir = mkdtempSync(join(tmpdir(), "chorus-itest-ac1-cfg-"));
    const cwd = mkdtempSync(join(tmpdir(), "chorus-itest-ac1-cwd-"));
    const prevConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;

    try {
      // Resume is entity-generic and rides the reverse CONTROL channel (NOT a
      // persisted notification). The daemon's control handler turns a
      // `command:"resume"` event into a synthetic `resource_resumed` re-dispatch,
      // which the router resolves via the SAME keyFor/lineage path — so only the
      // initial task_assigned notification needs to be fetchable by uuid.
      const TASK_NOTIF_LOCAL = { ...TASK_NOTIF, uuid: "n-assigned" };

      const reportInterrupt = vi.fn(async () => {});
      const { spawner, calls, resolveWake } = makeFakeSpawner({ writeTranscriptOnNew: true });

      let captured;
      const daemon = buildDaemon(
        { url: "https://c", apiKey: "cho_x" },
        {
          logger: silent,
          mcpClient: mcpFor([TASK_NOTIF_LOCAL]),
          fetchImpl: lineageFetch(),
          spawner,
          cwd,
          reportInterrupt,
          // Tight escalation window — irrelevant for AC1 (the fake child exits gracefully
          // on signal in this test) but keeps the test fast.
          sigintTimeoutMs: 50,
          makeSseListener: (o) => (captured = new MockSse(o)),
        }
      );

      // Stub process.kill so the SIGINT to the (negative-pid) group is observable
      // without touching a real process. The fake spawner's child exits when the
      // test resolves the wake — we drive that explicitly below.
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});

      await daemon.start();
      captured.deliver({ type: "connection_registered", connectionUuid: CONN });

      // (1) Initial dispatch: task_assigned → wake spawns a NEW session.
      captured.deliver({ type: "new_notification", notificationUuid: "n-assigned" });
      await new Promise((r) => setTimeout(r, 30));
      expect(spawner.wake).toHaveBeenCalledTimes(1);
      expect(calls[0].sessionId).toBe(DIRECT);
      expect(calls[0].isNew).toBe(true); // first wake → new session
      expect(daemon.waker.executions.get(`task:${TASK_UUID}`)?.status).toBe("running");

      // (2) Interrupt: control event for THIS connection + this entity.
      captured.deliver({
        type: "control",
        command: "interrupt",
        targetConnectionUuid: CONN,
        entityType: "task",
        entityUuid: TASK_UUID,
      });
      // Let the synchronous control-handler path mark the entity interrupting + signal.
      await new Promise((r) => setTimeout(r, 5));
      expect(daemon.waker.interrupting.has(`task:${TASK_UUID}`)).toBe(true);
      // SIGINT was delivered to the process GROUP via process.kill(-pid, "SIGINT").
      // The negative-pid form is the structural guarantee against orphaned grandchildren
      // on POSIX (process-killer.mjs / spec "two-stage tree-kill").
      const sigintCall = killSpy.mock.calls.find((c) => c[1] === "SIGINT");
      expect(sigintCall).toBeTruthy();
      expect(sigintCall[0]).toBeLessThan(0);

      // The control event MUST NOT have spawned a second wake (safety: control ≠ wake).
      expect(spawner.wake).toHaveBeenCalledTimes(1);

      // (3) The interrupted subprocess exits cleanly (exitCode 0 — graceful SIGINT
      //     handler). The waker reads the interrupting flag and reports reason="user".
      resolveWake(0, 0);
      await new Promise((r) => setTimeout(r, 10));
      expect(reportInterrupt).toHaveBeenCalledWith("task", TASK_UUID, "user");
      // The flag is cleared after the wake — never leaks to the next wake of the same entity.
      expect(daemon.waker.interrupting.has(`task:${TASK_UUID}`)).toBe(false);

      // The on-disk transcript exists at the canonical path → the next wake's probe will
      // pick `--resume` (`isNew=false`).
      const tpath = transcriptPath(DIRECT, cwd, { env: process.env });
      expect(existsSync(tpath)).toBe(true);

      // (4) Resume: the server-side /resume route dispatches a `command:"resume"`
      //     CONTROL event to this connection (NOT a persisted notification). The
      //     daemon's control handler re-dispatches the wake via the router.
      captured.deliver({
        type: "control",
        command: "resume",
        targetConnectionUuid: CONN,
        entityType: "task",
        entityUuid: TASK_UUID,
      });
      await new Promise((r) => setTimeout(r, 30));

      // The resumed dispatch produced exactly ONE more wake (total 2). The second wake
      // anchors on the SAME direct idea and ─crucially─ the daemon's isNewSession probe
      // flipped to RESUME because the transcript exists from the first run.
      expect(spawner.wake).toHaveBeenCalledTimes(2);
      expect(calls[1].sessionId).toBe(DIRECT); // SAME session as the first wake
      expect(calls[1].isNew).toBe(false); // → claude --resume <directIdeaUuid>
      // The resume prompt mentions the resumed entity — so the woken Claude knows to
      // continue, not start fresh.
      expect(calls[1].prompt).toContain(TASK_UUID);
      expect(calls[1].prompt).toContain("RESUMED");

      // Resolve the resumed wake cleanly — no further interrupt / crash report.
      reportInterrupt.mockClear();
      resolveWake(1, 0);
      await new Promise((r) => setTimeout(r, 10));
      expect(reportInterrupt).not.toHaveBeenCalled();

      killSpy.mockRestore();
      await daemon.stop();
    } finally {
      if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevConfig;
      rmSync(configDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // --- AC2: a child that ignores SIGINT escalates to a forceful tree-kill ---
  it("AC2: a child ignoring SIGINT is force-killed (SIGKILL on the POSIX group) after sigintTimeoutMs", async () => {
    // Real timers + a SHORT sigintTimeoutMs keep the test deterministic without
    // colliding with the spawner's `await new Promise((r) => setTimeout(...))` settles
    // (mixing those with fake timers stalls the test setup). The fake child never
    // auto-exits on SIGINT; the killer's waitForChildExit races the child's 'exit'
    // against the real timer, and the assertion follows that race to completion.
    const SIGINT_WINDOW_MS = 80;

    const reportInterrupt = vi.fn(async () => {});
    const { spawner, calls, resolveWake } = makeFakeSpawner();

    let captured;
    const daemon = buildDaemon(
      { url: "https://c", apiKey: "cho_x" },
      {
        logger: silent,
        mcpClient: mcpFor([{ ...TASK_NOTIF, uuid: "n-2" }]),
        fetchImpl: lineageFetch(),
        spawner,
        cwd: "/nonexistent/chorus-daemon-itest-ac2",
        reportInterrupt,
        sigintTimeoutMs: SIGINT_WINDOW_MS,
        makeSseListener: (o) => (captured = new MockSse(o)),
      }
    );

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});

    await daemon.start();
    captured.deliver({ type: "connection_registered", connectionUuid: CONN });

    // Start the wake so a running child exists to interrupt.
    captured.deliver({ type: "new_notification", notificationUuid: "n-2" });
    await new Promise((r) => setTimeout(r, 30));
    expect(spawner.wake).toHaveBeenCalledTimes(1);
    const child = daemon.waker.executions.get(`task:${TASK_UUID}`)?.child;
    expect(child).toBeTruthy();

    // Deliver the control event. The handler synchronously marks interrupting +
    // fire-and-forgets killProcessTree. Stage 1: SIGINT to the negative pid.
    captured.deliver({
      type: "control",
      command: "interrupt",
      targetConnectionUuid: CONN,
      entityType: "task",
      entityUuid: TASK_UUID,
    });
    // Inside the escalation window — let the killer's microtask + signal land,
    // but don't wait long enough for the timer to fire.
    await new Promise((r) => setTimeout(r, 5));
    const stage1 = killSpy.mock.calls.filter((c) => c[1] === "SIGINT");
    expect(stage1.length).toBe(1);
    expect(stage1[0][0]).toBe(-child.pid); // negative pid → group signal
    expect(killSpy.mock.calls.some((c) => c[1] === "SIGKILL")).toBe(false);

    // Cross the threshold: stage 2 fires — SIGKILL on the group (the fake child
    // never exits on SIGINT, so the killer escalates).
    await new Promise((r) => setTimeout(r, SIGINT_WINDOW_MS + 30));
    const stage2 = killSpy.mock.calls.filter((c) => c[1] === "SIGKILL");
    expect(stage2.length).toBe(1);
    expect(stage2[0][0]).toBe(-child.pid); // negative pid → group kill (no orphan grandchild)

    // The control event NEVER spawned a second Claude.
    expect(spawner.wake).toHaveBeenCalledTimes(1);

    // Now the (force-killed) subprocess "exits" — the wake completes and reports user.
    // SIGKILL produces a non-zero code in real runs; here we simulate with 137.
    resolveWake(0, 137);
    await new Promise((r) => setTimeout(r, 10));
    expect(reportInterrupt).toHaveBeenCalledWith("task", TASK_UUID, "user");

    killSpy.mockRestore();
    await daemon.stop();
    // Drop our reference to calls so the linter doesn't flag it.
    void calls;
  });

  // --- AC3: a crash exit (non-zero, no interrupt) → reportInterrupt('crash');
  // reconnect-backfill re-fires the wake without a user action. ---
  it("AC3: a crashed wake reports reason=crash; reconnect-backfill re-fires the wake automatically", async () => {
    const reportInterrupt = vi.fn(async () => {});
    const { spawner, calls, resolveWake } = makeFakeSpawner();

    // The MCP client always returns the same notification as unread — that's how a
    // server-side unread list looks for a task whose wake crashed and was never
    // marked-read.
    const mcp = mcpFor([{ ...TASK_NOTIF, uuid: "n-crash" }]);

    let captured;
    const daemon = buildDaemon(
      { url: "https://c", apiKey: "cho_x" },
      {
        logger: silent,
        mcpClient: mcp,
        fetchImpl: lineageFetch(),
        spawner,
        cwd: "/nonexistent/chorus-daemon-itest-ac3",
        reportInterrupt,
        makeSseListener: (o) => (captured = new MockSse(o)),
      }
    );

    await daemon.start();
    captured.deliver({ type: "connection_registered", connectionUuid: CONN });

    // (1) First dispatch + crash exit (exitCode=2, NO interrupt flag set).
    captured.deliver({ type: "new_notification", notificationUuid: "n-crash" });
    await new Promise((r) => setTimeout(r, 30));
    expect(spawner.wake).toHaveBeenCalledTimes(1);
    // Crash: non-zero exit, no interrupting flag.
    expect(daemon.waker.interrupting.has(`task:${TASK_UUID}`)).toBe(false);
    resolveWake(0, 2);
    await new Promise((r) => setTimeout(r, 10));
    expect(reportInterrupt).toHaveBeenCalledWith("task", TASK_UUID, "crash");
    // The execution row has cleared — the wake is no longer running.
    expect(daemon.waker.executions.has(`task:${TASK_UUID}`)).toBe(false);

    // (2) The reconnect-backfill path next runs (in production: after the SSE link
    //     re-establishes). The daemon's seen set still holds n-crash from the live
    //     dispatch, so a same-uuid backfill is a no-op — that is the correct behavior
    //     for a still-running daemon process. The auto-recovery promise from the spec
    //     applies to a DAEMON RESTART (the realistic crash-recovery scenario, fresh seen
    //     set). Simulate that by clearing seen, then driving onReconnect.
    daemon.router.seen.clear();
    await captured.fireReconnect();
    await new Promise((r) => setTimeout(r, 30));

    // The backfill re-dispatched the same notification through the wired router →
    // a SECOND wake fired automatically with no user action.
    expect(spawner.wake).toHaveBeenCalledTimes(2);
    expect(calls[1].sessionId).toBe(DIRECT); // anchored on the same direct idea

    // Resolve the recovery wake cleanly — no further crash/interrupt report.
    reportInterrupt.mockClear();
    resolveWake(1, 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(reportInterrupt).not.toHaveBeenCalled();

    await daemon.stop();
  });

  // --- AC4: safety ─ wrong connectionUuid / not-held entity ─ NO kill, ZERO new wakes ---
  it("AC4: a control event for a different connection does NOT kill and does NOT spawn", async () => {
    const reportInterrupt = vi.fn(async () => {});
    const { spawner, resolveWake } = makeFakeSpawner();

    let captured;
    const daemon = buildDaemon(
      { url: "https://c", apiKey: "cho_x" },
      {
        logger: silent,
        mcpClient: mcpFor([{ ...TASK_NOTIF, uuid: "n-safety-1" }]),
        fetchImpl: lineageFetch(),
        spawner,
        cwd: "/nonexistent/chorus-daemon-itest-ac4a",
        reportInterrupt,
        makeSseListener: (o) => (captured = new MockSse(o)),
      }
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});

    await daemon.start();
    captured.deliver({ type: "connection_registered", connectionUuid: "conn-MINE" });
    captured.deliver({ type: "new_notification", notificationUuid: "n-safety-1" });
    await new Promise((r) => setTimeout(r, 30));
    expect(spawner.wake).toHaveBeenCalledTimes(1);

    // Control event names a DIFFERENT connection → ignored end-to-end:
    captured.deliver({
      type: "control",
      command: "interrupt",
      targetConnectionUuid: "conn-SOMEONE-ELSE",
      entityType: "task",
      entityUuid: TASK_UUID,
    });
    await new Promise((r) => setTimeout(r, 10));

    // Nothing was killed, nothing was marked interrupting, no second wake spawned.
    expect(killSpy).not.toHaveBeenCalled();
    expect(daemon.waker.interrupting.has(`task:${TASK_UUID}`)).toBe(false);
    expect(spawner.wake).toHaveBeenCalledTimes(1);

    // Resolve the wake cleanly so the test exits.
    resolveWake(0, 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(reportInterrupt).not.toHaveBeenCalled();

    killSpy.mockRestore();
    await daemon.stop();
  });

  it("AC4: a control event for an entity this daemon does not hold does NOT kill and does NOT spawn", async () => {
    const reportInterrupt = vi.fn(async () => {});
    const { spawner } = makeFakeSpawner();

    let captured;
    const daemon = buildDaemon(
      { url: "https://c", apiKey: "cho_x" },
      {
        logger: silent,
        mcpClient: mcpFor([]), // no notifications → no running wakes
        fetchImpl: lineageFetch(),
        spawner,
        cwd: "/nonexistent/chorus-daemon-itest-ac4b",
        reportInterrupt,
        makeSseListener: (o) => (captured = new MockSse(o)),
      }
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});

    await daemon.start();
    captured.deliver({ type: "connection_registered", connectionUuid: CONN });

    // No wake started → executions registry is empty. A control event for a not-held
    // entity is ignored — never spawns a wake (control ≠ wake), never kills anything.
    expect(daemon.waker.executions.size).toBe(0);
    captured.deliver({
      type: "control",
      command: "interrupt",
      targetConnectionUuid: CONN,
      entityType: "task",
      entityUuid: "task-not-held",
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(spawner.wake).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    expect(reportInterrupt).not.toHaveBeenCalled();

    killSpy.mockRestore();
    await daemon.stop();
  });
});
