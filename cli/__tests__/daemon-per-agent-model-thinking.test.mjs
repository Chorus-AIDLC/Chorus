// cli/__tests__/daemon-per-agent-model-thinking.test.mjs
// Covers add-daemon-per-agent-model-thinking at the daemon-wiring level:
//   • the FLAT (no `agents[]`) branch resolves daemon.json's top-level `model` /
//     `thinking` and hands them to the daemon it builds (the path that used to
//     bypass resolveAgentConfigs and silently ignore them),
//   • the multi-agent startup line prints each agent's OWN values,
//   • an unsupported backend with either field set warns once and STILL starts,
//   • a present-but-invalid value fails startup instead of being ignored,
//   • the startup banner carries Model / Thinking rows only when resolved.
// Resolver-level cases (override / inheritance / pass-through) live in
// daemon-multi-agent-config.test.mjs; argv delivery per backend is covered by the
// per-spawner suites.
import { describe, it, expect, vi } from "vitest";
import { buildDaemon, runDaemon } from "../daemon.mjs";
import { bannerRows, modelFieldsUnsupportedWarningLine } from "../daemon-banner.mjs";

/** Minimal happy-path deps; per-test overrides merge on top. */
function baseDeps(over = {}) {
  return {
    resolve: () => ({ url: "u", apiKey: "cho_x", source: "env" }),
    validate: async () => ({ uuid: "agent-1", name: "Daemon Bot" }),
    build: vi.fn(() => ({ async start() {}, async stop() {} })),
    buildMulti: vi.fn(() => ({
      start: async () => {},
      stop: async () => {},
      allConflict: new Promise(() => {}),
    })),
    isTTY: false,
    log: () => {},
    errLog: () => {},
    waitForever: async () => {},
    readJson: () => null,
    loginPath: "/cfg/daemon.json",
    resolveClaudePath: () => "/usr/bin/claude",
    ...over,
  };
}

describe("runDaemon (flat, no agents[]) — top-level model / thinking", () => {
  it("resolves the file's top-level values and hands them to the built daemon", async () => {
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const logs = [];
    const code = await runDaemon(
      { chorusOnly: true, agent: "claude-code" },
      baseDeps({
        build,
        readJson: () => ({ url: "u", apiKey: "cho_x", model: "opus", thinking: "high" }),
        log: (m) => logs.push(m),
      })
    );
    expect(code).toBe(0);
    expect(build).toHaveBeenCalledOnce();
    const daemonDeps = build.mock.calls[0][1];
    expect(daemonDeps.model).toBe("opus");
    expect(daemonDeps.thinking).toBe("high");
    // Banner rows show the resolved values (the flat path's startup output).
    const banner = logs.join("\n");
    expect(banner).toContain("Model");
    expect(banner).toContain("opus");
    expect(banner).toContain("Thinking");
    expect(banner).toContain("high");
  });

  it("passes nothing (undefined) when the file sets neither field", async () => {
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const code = await runDaemon(
      { chorusOnly: true, agent: "claude-code" },
      baseDeps({ build, readJson: () => ({ url: "u", apiKey: "cho_x" }) })
    );
    expect(code).toBe(0);
    const daemonDeps = build.mock.calls[0][1];
    expect(daemonDeps.model).toBeUndefined();
    expect(daemonDeps.thinking).toBeUndefined();
  });

  it("fails startup (exit 1) on a present-but-invalid top-level value", async () => {
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const errs = [];
    const code = await runDaemon(
      { chorusOnly: true, agent: "claude-code" },
      baseDeps({ build, readJson: () => ({ url: "u", apiKey: "cho_x", model: "" }), errLog: (m) => errs.push(m) })
    );
    expect(code).toBe(1);
    expect(build).not.toHaveBeenCalled();
    expect(errs.join("\n")).toMatch(/invalid model/);
  });

  it("warns once and still starts when the backend cannot receive the fields", async () => {
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const errs = [];
    const code = await runDaemon(
      { chorusOnly: true, agent: "kiro" },
      baseDeps({
        build,
        readJson: () => ({ url: "u", apiKey: "cho_x", model: "opus", thinking: "high" }),
        errLog: (m) => errs.push(m),
        resolveKiroPath: () => "/usr/bin/kiro-cli",
      })
    );
    expect(code).toBe(0);
    expect(build).toHaveBeenCalledOnce();
    const warns = errs.filter((m) => m.includes("has no verified model/thinking parameter"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("kiro");
    expect(warns[0]).toContain("model + thinking");
  });
});

describe("runDaemon (agents[]) — per-agent model / thinking", () => {
  it("prints each agent's OWN values on its startup line", async () => {
    const file = {
      url: "https://top",
      agents: [
        { apiKey: "k1", label: "dev", model: "opus", thinking: "high" },
        { apiKey: "k2", label: "solo" },
      ],
    };
    const logs = [];
    const code = await runDaemon(
      {},
      baseDeps({
        readJson: () => file,
        log: (m) => logs.push(m),
        validate: async ({ apiKey }) => ({ name: `n-${apiKey}`, uuid: `id-${apiKey}` }),
      })
    );
    expect(code).toBe(0);
    const devLine = logs.find((m) => m.includes("agent dev:"));
    expect(devLine).toContain("model=opus");
    expect(devLine).toContain("thinking=high");
    // An agent without the fields keeps the un-suffixed line (no empty placeholder).
    const soloLine = logs.find((m) => m.includes("agent solo:"));
    expect(soloLine).not.toContain("model=");
    expect(soloLine).not.toContain("thinking=");
  });

  it("warns once for an unsupported backend agent that sets the fields, without failing", async () => {
    const file = {
      url: "https://top",
      agents: [{ apiKey: "k1", label: "legacy", agentType: "kiro", model: "opus", thinking: "high" }],
    };
    const errs = [];
    const code = await runDaemon({}, baseDeps({ readJson: () => file, errLog: (m) => errs.push(m) }));
    expect(code).toBe(0);
    const warns = errs.filter((m) => m.includes("has no verified model/thinking parameter"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("legacy");
  });

  it("rejects a present-but-invalid per-agent value before building anything", async () => {
    const file = { url: "https://top", agents: [{ apiKey: "k1", label: "dev", thinking: 7 }] };
    const buildMulti = vi.fn();
    const errs = [];
    const code = await runDaemon({}, baseDeps({ readJson: () => file, buildMulti, errLog: (m) => errs.push(m) }));
    expect(code).toBe(1);
    expect(buildMulti).not.toHaveBeenCalled();
    expect(errs.join("\n")).toMatch(/Agent dev: invalid thinking/);
  });
});

describe("buildDaemon — the built daemon's spawner carries model / thinking", () => {
  const silent = { info() {}, warn() {}, error() {} };
  const construct = (agentType, fields = {}) =>
    buildDaemon(
      { url: "https://c", apiKey: "cho_x" },
      { logger: silent, agentType, mcpClient: {}, lineage: { resolve: vi.fn() }, sseListener: {}, cwd: "/tmp", ...fields },
    );

  it("hands the resolved values to the spawner the waker will drive", () => {
    const d = construct("pi", { model: "anthropic/claude-haiku-4-5", thinking: "low" });
    expect(d.spawner.model).toBe("anthropic/claude-haiku-4-5");
    expect(d.spawner.thinking).toBe("low");
  });

  it("carries none when the fields are unset (spawn argv stays pre-feature)", () => {
    const d = construct("claude-code");
    expect(d.spawner.model ?? null).toBeNull();
    expect(d.spawner.thinking ?? null).toBeNull();
  });

  it("never throws for a backend without the parameter (dsh ignores them)", () => {
    expect(() => construct("dsh", { model: "x", thinking: "y" })).not.toThrow();
  });
});

describe("bannerRows — Model / Thinking rows", () => {
  const info = (over = {}) => ({
    version: "0.0.0",
    url: "https://c",
    agentName: "Bot",
    agentUuid: "id-1",
    permissionMode: "chorus",
    credentialSource: "env",
    agentType: "claude-code",
    cliPath: "/usr/bin/claude",
    ...over,
  });

  it("shows both rows when resolved", () => {
    const rows = bannerRows(info({ model: "opus", thinking: "high" }));
    expect(rows).toContainEqual(["Model", "opus"]);
    expect(rows).toContainEqual(["Thinking", "high"]);
  });

  it("omits both rows when the backend resolves its own defaults", () => {
    const labels = bannerRows(info()).map(([label]) => label);
    expect(labels).not.toContain("Model");
    expect(labels).not.toContain("Thinking");
  });
});

describe("modelFieldsUnsupportedWarningLine", () => {
  it("names the agent, the fields, and the supported backends", () => {
    const line = modelFieldsUnsupportedWarningLine("dev", ["model", "thinking"], "dsh");
    expect(line).toMatch(/^⚠/);
    expect(line).toContain("dev");
    expect(line).toContain("model + thinking");
    expect(line).toContain("dsh");
    expect(line).toContain("claude-code, pi, codex");
    expect(line).toContain("NOT applied");
  });

  it("lists only the field that is actually set", () => {
    expect(modelFieldsUnsupportedWarningLine("a", ["thinking"], "kiro")).toContain("thinking configured");
  });
});
