// cli/__tests__/multi-agent-integration.test.mjs
// T5 — integration checkpoint for daemon-multi-agent. Composes the whole fan-out:
// resolveAgentConfigs (T1) → buildMultiAgentDaemon (T2) → per-agent runtimes with
// per-agent creds (T3), then drives a real notification through ONE agent's stream
// and asserts ONLY that agent's spawner wakes. Uses the same mock-SSE / mock-spawner
// / fake-lineage harness as daemon-integration.test.mjs.
//
// Manual live-verify (not automatable headlessly): with a real daemon.json declaring
// two agents (distinct cho_ keys) and a running server, `chorus daemon` shows two
// identity lines and the server's connection registry lists two DaemonConnection /
// AgentInstance rows (keyed on agentUuid,host,cwd). See docs (T6).

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { buildMultiAgentDaemon } from "../daemon.mjs";
import { resolveAgentConfigs } from "../daemon-config.mjs";

const silent = { info() {}, warn() {}, error() {} };

const DIRECT_IDEA = "11111111-1111-4111-8111-111111111111";
const ROOT_IDEA = "99999999-9999-4999-8999-999999999999";

function taskNotif() {
  return {
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
}

function lineageFetch() {
  return async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).includes("/api/entities/task/task-1/root-idea")) {
        return {
          success: true,
          data: { rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA, lineage: [], resolvedVia: "via_proposal" },
        };
      }
      return { success: true, data: { rootIdeaUuid: null, directIdeaUuid: null, lineage: [], resolvedVia: "not_found" } };
    },
  });
}

function mockMcp(notif) {
  return {
    async callTool(name) {
      if (name === "chorus_get_notifications") return { notifications: notif ? [notif] : [] };
      return null;
    },
    async disconnect() {},
  };
}

/** A mock SSE listener we can manually drive (mirrors daemon-integration.test.mjs). */
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
  deliver(event) {
    if (event?.type === "connection_registered") return this.opts.onConnectionId?.(event.connectionUuid);
    if (event?.type === "control") return this.opts.onControl?.(event);
    return this.opts.onEvent(event);
  }
}

function fakeSpawner() {
  return {
    wake: vi.fn(async (params) => {
      params.onMessage?.({ type: "system", session_id: params.sessionId });
      return { sessionId: params.sessionId, exitCode: 0, isNew: params.isNew };
    }),
  };
}

async function waitFor(pred, ms = 1000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor: condition not met in time");
}

describe("multi-agent integration — two independent agents online", () => {
  it("config → 2 runtimes → 2 registrations; a wake to agent A never touches agent B", async () => {
    const cwdA = mkdtempSync(join(tmpdir(), "chorus-agentA-"));
    const cwdB = mkdtempSync(join(tmpdir(), "chorus-agentB-"));

    // Resolve two agents from a daemon.json with distinct keys + cwds + backends.
    const file = {
      url: "https://top.example.com",
      agents: [
        { apiKey: "cho_alpha", url: "https://alpha.example.com", agentType: "claude-code", cwds: [cwdA] },
        { apiKey: "cho_beta", url: "https://beta.example.com", agentType: "kiro", cwds: [cwdB] },
      ],
    };
    const cfgs = resolveAgentConfigs({}, { env: {}, readJson: () => file, loginPath: "/cfg/daemon.json" });
    expect(cfgs).toHaveLength(2);
    expect(cfgs[0].agentType).toBe("claude-code");
    expect(cfgs[1].agentType).toBe("kiro");

    const listeners = [];
    const makeSseListener = [
      (opts) => { const s = new MockSse(opts); listeners[0] = s; return s; },
      (opts) => { const s = new MockSse(opts); listeners[1] = s; return s; },
    ];
    const spawnerA = fakeSpawner();
    const spawnerB = fakeSpawner();

    const daemon = buildMultiAgentDaemon(cfgs, {
      logger: silent,
      makeSseListener,
      spawner: [spawnerA, spawnerB],
      mcpClient: [mockMcp(taskNotif()), mockMcp()],
      fetchImpl: lineageFetch(),
      hooks: { onConnect: async () => {} },
    });

    expect(daemon.agents).toHaveLength(2);
    await daemon.start();

    // Both agents connected, each self-reporting its OWN cwd + clientType + key —
    // this is what makes the server register two distinct DaemonConnection rows.
    expect(listeners[0].connected).toBe(true);
    expect(listeners[1].connected).toBe(true);
    expect(listeners[0].opts.cwd).toBe(cwdA);
    expect(listeners[0].opts.clientType).toBe("claude_code");
    expect(listeners[0].opts.apiKey).toBe("cho_alpha");
    expect(listeners[1].opts.cwd).toBe(cwdB);
    expect(listeners[1].opts.clientType).toBe("kiro");
    expect(listeners[1].opts.apiKey).toBe("cho_beta");

    // Register each connection (server assigns a connectionUuid per row).
    listeners[0].deliver({ type: "connection_registered", connectionUuid: "conn-A" });
    listeners[1].deliver({ type: "connection_registered", connectionUuid: "conn-B" });

    // Drive a task_assigned into agent A's stream only (the router fetches the full
    // notification from agent A's own MCP client by uuid).
    listeners[0].deliver({ type: "new_notification", notificationUuid: "notif-1" });
    await waitFor(() => spawnerA.wake.mock.calls.length > 0);

    // A woke in A's cwd; B never woke → independent dispatch.
    expect(spawnerA.wake).toHaveBeenCalledTimes(1);
    expect(spawnerA.wake.mock.calls[0][0].cwd).toBe(cwdA);
    expect(spawnerB.wake).not.toHaveBeenCalled();

    await daemon.stop();
  });

  it("back-compat: a flat single-agent daemon.json yields exactly one agent", () => {
    const flat = { url: "https://c.example.com", apiKey: "cho_flat" };
    const cfgs = resolveAgentConfigs({}, { env: {}, readJson: () => flat, loginPath: "/cfg/daemon.json" });
    expect(cfgs).toHaveLength(1);
    expect(cfgs[0].label).toBe("agent");
    expect(cfgs[0].apiKey).toBe("cho_flat");
  });
});
