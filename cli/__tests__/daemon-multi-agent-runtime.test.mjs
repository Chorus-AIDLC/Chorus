// cli/__tests__/daemon-multi-agent-runtime.test.mjs
// Tests for the multi-agent runtime (daemon-multi-agent):
//   - buildMultiAgentDaemon: fan-out composition over buildDaemon (one runtime per
//     agent config), connection flattening, start/stop fan-out, per-agent failure
//     isolation, and the aggregate allConflict.
//   - runDaemon multi-branch: per-agent identity validation (isolating a bad key),
//     building via the multi builder, and the single-agent path staying untouched.

import { describe, expect, it, vi } from "vitest";
import { buildMultiAgentDaemon, runDaemon } from "../daemon.mjs";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function fakeDaemon(tag, { connections = 1, allConflict } = {}) {
  const calls = { start: 0, stop: 0 };
  return {
    tag,
    calls,
    connections: Array.from({ length: connections }, (_, i) => ({ cwd: `${tag}#${i}` })),
    waker: { tag },
    router: { tag },
    sseListener: { tag },
    allConflict: allConflict ?? new Promise(() => {}),
    start: async () => {
      calls.start += 1;
    },
    stop: async () => {
      calls.stop += 1;
    },
  };
}

const CFG = (over = {}) => ({
  url: "https://c",
  apiKey: "cho_x",
  agentType: "claude-code",
  cwds: [undefined],
  permissionMode: "yolo",
  maxConcurrency: 4,
  sigintTimeoutMs: 1000,
  browseRoots: ["/home"],
  label: "agents[0]",
  ...over,
});

describe("buildMultiAgentDaemon — fan-out composition", () => {
  it("builds one runtime per agent with that agent's creds + per-agent deps", () => {
    const seen = [];
    const build = (creds, deps) => {
      seen.push({ creds, deps });
      return fakeDaemon(creds.apiKey, { connections: deps.cwds.length });
    };
    const cfgs = [
      CFG({ apiKey: "k1", url: "u1", agentType: "claude-code", cwds: ["/a"], maxConcurrency: 4, label: "agents[0]" }),
      CFG({ apiKey: "k2", url: "u2", agentType: "kiro", cwds: ["/b", "/c"], permissionMode: "chorus", maxConcurrency: 8, sigintTimeoutMs: 2000, label: "agents[1]" }),
    ];
    const d = buildMultiAgentDaemon(cfgs, { build, logger: silent });

    expect(seen).toHaveLength(2);
    expect(seen[0].creds).toEqual({ url: "u1", apiKey: "k1" });
    expect(seen[0].deps).toMatchObject({ agentType: "claude-code", cwds: ["/a"], permissionMode: "yolo", maxConcurrency: 4, sigintTimeoutMs: 1000 });
    expect(seen[1].creds).toEqual({ url: "u2", apiKey: "k2" });
    expect(seen[1].deps).toMatchObject({ agentType: "kiro", cwds: ["/b", "/c"], permissionMode: "chorus", maxConcurrency: 8, sigintTimeoutMs: 2000 });
    // per-agent cwd (singular) never leaks across agents
    expect(seen[0].deps.cwd).toBeUndefined();
    // connections flatten: agent0 (1 cwd) + agent1 (2 cwds) = 3
    expect(d.connections).toHaveLength(3);
    expect(d.agents).toHaveLength(2);
  });

  it("start()/stop() fan out to every agent", async () => {
    const built = [];
    const build = (creds) => {
      const d = fakeDaemon(creds.apiKey);
      built.push(d);
      return d;
    };
    const d = buildMultiAgentDaemon([CFG({ apiKey: "k1" }), CFG({ apiKey: "k2" })], { build, logger: silent });
    await d.start();
    await d.stop();
    expect(built.map((b) => b.calls.start)).toEqual([1, 1]);
    expect(built.map((b) => b.calls.stop)).toEqual([1, 1]);
  });

  it("isolates a build failure — the failed agent is skipped, the rest build", () => {
    const errSpy = vi.fn();
    const build = (creds) => {
      if (creds.apiKey === "bad") throw new Error("boom");
      return fakeDaemon(creds.apiKey);
    };
    const d = buildMultiAgentDaemon(
      [CFG({ apiKey: "ok1", label: "agents[0]" }), CFG({ apiKey: "bad", label: "agents[1]" }), CFG({ apiKey: "ok2", label: "agents[2]" })],
      { build, logger: { ...silent, error: errSpy } },
    );
    expect(d.agents).toHaveLength(2);
    expect(d.agents.map((a) => a.cfg.apiKey)).toEqual(["ok1", "ok2"]);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("agents[1]"));
  });

  it("isolates a start failure — other agents still start", async () => {
    const started = [];
    const build = (creds) => ({
      ...fakeDaemon(creds.apiKey),
      start: async () => {
        if (creds.apiKey === "bad") throw new Error("start boom");
        started.push(creds.apiKey);
      },
    });
    const d = buildMultiAgentDaemon([CFG({ apiKey: "ok1" }), CFG({ apiKey: "bad" }), CFG({ apiKey: "ok2" })], { build, logger: silent });
    await expect(d.start()).resolves.toBeUndefined(); // does not throw
    expect(started).toEqual(["ok1", "ok2"]);
  });

  it("throws only when EVERY agent runtime fails to build", () => {
    const build = () => {
      throw new Error("all boom");
    };
    expect(() => buildMultiAgentDaemon([CFG(), CFG()], { build, logger: silent })).toThrow(/all agent runtimes failed/);
  });

  it("aggregate allConflict settles only when all agents' paths are all-conflicted", async () => {
    // Agent 0 all-conflicts (resolved); agent 1 keeps serving (never settles) →
    // aggregate must NOT settle.
    let a0Resolve;
    const build = (creds) =>
      fakeDaemon(creds.apiKey, {
        allConflict: creds.apiKey === "k0" ? new Promise((r) => (a0Resolve = r)) : new Promise(() => {}),
      });
    const d = buildMultiAgentDaemon([CFG({ apiKey: "k0" }), CFG({ apiKey: "k1" })], { build, logger: silent });
    a0Resolve();
    const raced = await Promise.race([
      d.allConflict.then(() => "settled"),
      new Promise((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(raced).toBe("pending"); // agent 1 still serving keeps the daemon alive
  });

  it("N=1 via the real buildDaemon default constructs one agent with its connections", async () => {
    // No injected build → exercises the real buildDaemon lightly with fake IO seams
    // so nothing connects to the network at construction.
    const connect = vi.fn(async () => {});
    const makeSseListener = () => ({ connect, disconnect: () => {} });
    const d = buildMultiAgentDaemon([CFG({ cwds: ["/x", "/y"] })], {
      logger: silent,
      makeSseListener,
      spawner: { wake: async () => ({}) },
      mcpClient: { disconnect: async () => {} },
      lineage: {},
      hooks: { onConnect: async () => {} },
    });
    expect(d.agents).toHaveLength(1);
    expect(d.connections).toHaveLength(2); // one per cwd
    await d.start();
    expect(connect).toHaveBeenCalledTimes(2);
  });
});

describe("runDaemon — multi-agent branch", () => {
  const baseDeps = (over = {}) => ({
    env: {},
    loginPath: "/cfg/daemon.json",
    log: () => {},
    errLog: () => {},
    waitForever: () => Promise.resolve(),
    ...over,
  });

  it("validates each agent, builds the multi daemon, and returns 0", async () => {
    const file = { url: "https://top", agents: [{ apiKey: "k1" }, { apiKey: "k2", agentType: "kiro" }] };
    const validated = [];
    let builtCfgs = null;
    let started = false;
    const rc = await runDaemon(
      {},
      baseDeps({
        readJson: () => file,
        validate: async ({ apiKey }) => {
          validated.push(apiKey);
          return { name: `n-${apiKey}`, uuid: `id-${apiKey}` };
        },
        buildMulti: (cfgs) => {
          builtCfgs = cfgs;
          return { start: async () => { started = true; }, stop: async () => {}, allConflict: new Promise(() => {}) };
        },
      }),
    );
    expect(rc).toBe(0);
    expect(validated).toEqual(["k1", "k2"]);
    expect(builtCfgs.map((c) => c.agentType)).toEqual(["claude-code", "kiro"]);
    expect(started).toBe(true);
  });

  it("isolates a bad-key agent — it is skipped, the rest are served", async () => {
    const file = { url: "https://top", agents: [{ apiKey: "good" }, { apiKey: "bad" }] };
    let builtCfgs = null;
    const rc = await runDaemon(
      {},
      baseDeps({
        readJson: () => file,
        validate: async ({ apiKey }) => {
          if (apiKey === "bad") throw new Error("401");
          return { name: "n", uuid: "id" };
        },
        buildMulti: (cfgs) => {
          builtCfgs = cfgs;
          return { start: async () => {}, stop: async () => {}, allConflict: new Promise(() => {}) };
        },
      }),
    );
    expect(rc).toBe(0);
    expect(builtCfgs.map((c) => c.apiKey)).toEqual(["good"]);
  });

  it("returns 1 (nothing to serve) when no agent authenticates", async () => {
    const file = { url: "https://top", agents: [{ apiKey: "k1" }, { apiKey: "k2" }] };
    let builtCalled = false;
    const rc = await runDaemon(
      {},
      baseDeps({
        readJson: () => file,
        validate: async () => {
          throw new Error("401");
        },
        buildMulti: () => {
          builtCalled = true;
          return { start: async () => {}, stop: async () => {}, allConflict: new Promise(() => {}) };
        },
      }),
    );
    expect(rc).toBe(1);
    expect(builtCalled).toBe(false);
  });
});
