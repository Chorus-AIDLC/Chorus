// cli/__tests__/multi-agent-cred-delivery.test.mjs
// T3 — per-agent credential delivery. Proves that in a multi-agent daemon each
// backend receives its OWN agent's creds:
//   - Claude: the per-wake --mcp-config file carries that agent's url + Bearer key.
//   - selectSpawner threads each agent's creds into its spawner (so the per-spawn
//     env — asserted from this.creds in codex-spawner/kiro-spawner tests — is that
//     agent's key/url, never a process-global).
//   - Kiro: a direct two-agent wake shows each child's env is its own agent's pair.

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { buildMcpConfig } from "../mcp-config.mjs";
import { selectSpawner } from "../spawner-select.mjs";
import { KiroSpawner } from "../kiro-spawner.mjs";

const A = { url: "https://alpha.example.com", apiKey: "cho_alpha" };
const B = { url: "https://beta.example.com/", apiKey: "cho_beta" };

describe("Claude — per-agent --mcp-config carries that agent's url + key", () => {
  it("two agents produce two distinct MCP configs", () => {
    const ca = buildMcpConfig(A);
    const cb = buildMcpConfig(B);
    expect(ca.mcpServers.chorus.url).toBe("https://alpha.example.com/api/mcp");
    expect(ca.mcpServers.chorus.headers.Authorization).toBe("Bearer cho_alpha");
    // trailing slash normalized; distinct per agent
    expect(cb.mcpServers.chorus.url).toBe("https://beta.example.com/api/mcp");
    expect(cb.mcpServers.chorus.headers.Authorization).toBe("Bearer cho_beta");
  });
});

describe("selectSpawner threads each agent's creds (per-agent, never global)", () => {
  it.each(["claude-code", "codex", "kiro"])("%s spawner is constructed with the passed creds", (agentType) => {
    const spawnerA = selectSpawner(agentType, { creds: A, logger: { info() {}, warn() {}, error() {} } });
    const spawnerB = selectSpawner(agentType, { creds: B, logger: { info() {}, warn() {}, error() {} } });
    // .creds is the field every spawner exports into the child env (CHORUS_URL /
    // CHORUS_API_KEY) at wake time — see codex-spawner / kiro-spawner env tests.
    expect(spawnerA.creds).toEqual(A);
    expect(spawnerB.creds).toEqual(B);
  });
});

// --- Direct proof: two Kiro agents each wake with their OWN env pair ---
function makeFakeChild() {
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
  child.pid = 4242;
  return child;
}

function makeKiroSpawner(creds) {
  const calls = {};
  const child = makeFakeChild();
  const spawnImpl = vi.fn((command, argv, opts) => {
    calls.command = command;
    calls.argv = argv;
    calls.opts = opts;
    return child;
  });
  const spawner = new KiroSpawner({
    kiroPath: "/usr/bin/kiro-cli",
    spawnImpl,
    permissionMode: "yolo",
    creds,
    platform: "linux",
    logger: { info() {}, warn() {}, error() {} },
    getSessionIdFn: () => null,
    setSessionIdFn: () => {},
    snapshotSessionsFn: () => new Map(),
    reconstructTranscript: null,
  });
  return { spawner, child, calls };
}

describe("Kiro — each agent's wake exports its own creds into the child env", () => {
  it("agent A and agent B get distinct CHORUS_URL / CHORUS_API_KEY", async () => {
    for (const creds of [A, B]) {
      const { spawner, child, calls } = makeKiroSpawner(creds);
      const p = spawner.wake({ prompt: "go", sessionId: "idea-1", isNew: true, onChild: () => {} });
      child.stdout.emit("data", "ok\n");
      child.emit("close", 0);
      await p;
      expect(calls.opts.env.CHORUS_URL).toBe(creds.url);
      expect(calls.opts.env.CHORUS_API_KEY).toBe(creds.apiKey);
      // secrets never on argv
      expect(calls.argv.join(" ")).not.toContain(creds.apiKey);
    }
  });
});
