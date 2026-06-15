// cli/__tests__/daemon-integration.test.mjs
// Full-chain integration: a task_assigned SSE event flows through the assembled
// daemon (mock MCP + mock SSE + mock claude subprocess) all the way to the
// spawn args. Covers the integration AC and "task-dispatch wakes Claude Code".
import { describe, it, expect, vi } from "vitest";
import { buildDaemon, runDaemon } from "../daemon.mjs";

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

/** A mock MCP client answering the lineage walk + notification fetch. */
function mockMcp() {
  return {
    disconnected: false,
    async callTool(name) {
      switch (name) {
        case "chorus_get_notifications":
          return { notifications: [TASK_NOTIF] };
        case "chorus_get_task":
          return { proposalUuid: "prop-1" };
        case "chorus_get_proposal":
          return { inputType: "idea", inputUuids: ["root-idea"] };
        case "chorus_get_idea":
          return { parentUuid: null }; // root-idea is its own root
        default:
          return null;
      }
    },
    async disconnect() {
      this.disconnected = true;
    },
  };
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
        params.onMessage?.({ type: "system", session_id: "sid-new" });
        return { sessionId: "sid-new", exitCode: 0, isNew: true };
      }),
    };
    const sessionMap = {
      resolve: vi.fn(() => ({ sessionId: null, isNew: true })),
      record: vi.fn(),
    };
    let captured;
    const daemon = buildDaemon(
      { url: "https://chorus.example", apiKey: "cho_x" },
      {
        logger: silent,
        mcpClient: mockMcp(),
        spawner,
        sessionMap,
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
    expect(params.sessionId).toBeNull(); // new session for this root idea
    expect(params.mcpConfigPath).toMatch(/mcp\.json$/); // wrote a temp mcp config
    // session id persisted under the root-idea key
    expect(sessionMap.record).toHaveBeenCalledWith("idea:root-idea", "sid-new");

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
      { logger: silent, mcpClient: mcp, spawner, makeSseListener: (o) => (captured = new MockSse(o)) }
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
