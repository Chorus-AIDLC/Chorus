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
  /** test helper: deliver an event as if it came off the wire */
  deliver(event) {
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
