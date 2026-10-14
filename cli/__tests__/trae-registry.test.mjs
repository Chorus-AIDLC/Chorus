// cli/__tests__/trae-registry.test.mjs
// add-trae-cli-backend D4: `trae` is registered everywhere the agent-type and
// clientType lists live, and the static registry literals (backendCli,
// TYPE_TO_BINARY, AGENT_MENU) match the CODEX_FAMILY.trae profile — the single
// source of TRAE names/paths/env vars (design Module Contracts).
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_FAMILY } from "../codex-family.mjs";
import { KNOWN_AGENTS as DAEMON_KNOWN_AGENTS, backendCli, backendClientType, resolveAgentType } from "../daemon-agent.mjs";
import { KNOWN_AGENTS as CLIENT_KNOWN_AGENTS, daemonHelpText, loginHelpText } from "../client-args.mjs";
import { AGENT_MENU, promptAgentBackend } from "../agent-backend-prompt.mjs";
import { TYPE_TO_BINARY, SUPPORTED_TYPES, resolveBinaryName } from "../agent-launcher.mjs";
import { findAgentCli, resolveTraePath } from "../agent-cli-probe.mjs";
import { bannerRows, agentNotFoundWarningLine } from "../daemon-banner.mjs";
import { resolveAgentConfigs } from "../daemon-config.mjs";
import { resolveInstallAgent } from "../daemon-install-config.mjs";
import { selectSpawner } from "../spawner-select.mjs";
import { CodexSpawner } from "../codex-spawner.mjs";
import { createWakeError } from "../wake-error.mjs";
import { codexUsageSourceFor, extractCodexTurnUsage, CODEX_USAGE_SOURCE, createTranscriptUploadHooks } from "../upload-hooks.mjs";
import { runDaemon } from "../daemon.mjs";

const TRAE = CODEX_FAMILY.trae;

const REAL_HOME = process.env.HOME;
const TMP_HOME = mkdtempSync(join(tmpdir(), "chorus-trae-registry-home-"));
beforeAll(() => {
  process.env.HOME = TMP_HOME;
});
afterAll(() => {
  process.env.HOME = REAL_HOME;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("static registry literals match CODEX_FAMILY.trae", () => {
  it("backendCli('trae') names the profile binary and path env var", () => {
    expect(backendCli("trae")).toEqual({ name: TRAE.binaries.posix[0], envVar: TRAE.pathEnv });
    expect(backendCli("trae")).toEqual({ name: "traecli", envVar: "CHORUS_TRAE_PATH" });
  });

  it("backendClientType('trae') equals the profile clientType / wakeErrorSource", () => {
    expect(backendClientType("trae")).toBe(TRAE.clientType);
    expect(TRAE.wakeErrorSource).toBe(TRAE.clientType);
  });

  it("TYPE_TO_BINARY.trae equals the profile binary", () => {
    expect(TYPE_TO_BINARY.trae).toBe(TRAE.binaries.posix[0]);
    expect(SUPPORTED_TYPES.split(", ")).toContain("trae");
    expect(resolveBinaryName("trae")).toEqual({ type: "trae", binary: "traecli" });
  });

  it("AGENT_MENU lists TRAE CLI (profile displayName) after claude-code, codex, kiro, pi", () => {
    expect(AGENT_MENU.map((r) => r.value)).toEqual(["claude-code", "codex", "kiro", "pi", "trae"]);
    expect(AGENT_MENU.find((r) => r.value === "trae").label).toBe(TRAE.displayName);
  });

  it("the codex rows stay consistent with CODEX_FAMILY.codex", () => {
    const codex = CODEX_FAMILY.codex;
    expect(backendCli("codex")).toEqual({ name: codex.binaries.posix[0], envVar: codex.pathEnv });
    expect(TYPE_TO_BINARY.codex).toBe(codex.binaries.posix[0]);
    expect(backendClientType("codex")).toBe(codex.clientType);
  });
});

describe("agent-type acceptance", () => {
  it("daemon KNOWN_AGENTS includes trae", () => {
    expect(DAEMON_KNOWN_AGENTS).toContain("trae");
  });

  it("client-args accepts exactly claude-code, codex, kiro, dsh, pi, trae (not offline)", () => {
    expect([...CLIENT_KNOWN_AGENTS]).toEqual(["claude-code", "codex", "kiro", "dsh", "pi", "trae"]);
    expect(CLIENT_KNOWN_AGENTS.has("offline")).toBe(false);
    // Every client-accepted value is a daemon-known backend.
    for (const a of CLIENT_KNOWN_AGENTS) expect(DAEMON_KNOWN_AGENTS).toContain(a);
  });

  it("help text advertises trae", () => {
    expect(daemonHelpText("0.0.0")).toMatch(/claude-code \| codex \| kiro \| pi \| trae/);
    expect(daemonHelpText("0.0.0")).toContain("--agent trae");
    expect(loginHelpText("0.0.0")).toMatch(/\| trae/);
    expect(daemonHelpText("0.0.0")).not.toContain("| dsh");
  });

  it("--agent trae, CHORUS_AGENT=trae and daemon.json agent: trae resolve to trae", () => {
    expect(resolveAgentType({ agent: "trae" }, {})).toEqual({ ok: true, agent: "trae" });
    expect(resolveAgentType({}, { CHORUS_AGENT: "trae" })).toEqual({ ok: true, agent: "trae" });
    expect(resolveAgentType({}, {}, { readJson: () => ({ agent: "trae" }), loginPath: "/x" })).toEqual({
      ok: true,
      agent: "trae",
    });
  });

  it("daemon.json agents[] agentType: trae is accepted", () => {
    const configs = resolveAgentConfigs(
      {},
      {
        env: {},
        loginPath: "/x",
        readJson: () => ({
          url: "https://chorus.example",
          agents: [{ label: "t", apiKey: "cho_t", agentType: "trae" }],
        }),
      },
    );
    expect(configs.map((c) => c.agentType)).toEqual(["trae"]);
  });

  it("unknown values are still rejected, listing trae", () => {
    const r = resolveAgentType({ agent: "gemini" }, {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("trae");
  });

  it("the shared prompt accepts trae by number and by name", async () => {
    const idx = AGENT_MENU.findIndex((r) => r.value === "trae") + 1;
    expect(await promptAgentBackend({ ask: async () => String(idx), isTTY: true })).toBe("trae");
    expect(await promptAgentBackend({ ask: async () => "trae", isTTY: true })).toBe("trae");
  });
});

describe("CLI probes cover trae", () => {
  it("findAgentCli('trae') resolves traecli via CHORUS_TRAE_PATH / PATH", () => {
    const isFile = (p) => p === "/opt/bin/traecli" || p === "/custom/traecli";
    expect(findAgentCli("trae", { env: { PATH: "/opt/bin" }, platform: "linux", isFile })).toBe("/opt/bin/traecli");
    expect(
      findAgentCli("trae", { env: { PATH: "/opt/bin", CHORUS_TRAE_PATH: "/custom/traecli" }, platform: "linux", isFile }),
    ).toBe("/custom/traecli");
    expect(resolveTraePath({ env: { PATH: "/nowhere" }, platform: "linux", isFile })).toBeNull();
  });

  it("findAgentCli routes each backend to its own resolver (injectable)", () => {
    const resolvers = {
      resolveClaudePath: () => "claude",
      resolveCodexPath: () => "codex",
      resolveKiroPath: () => "kiro",
      resolveDshPath: () => "dsh",
      resolvePiPath: () => "pi",
      resolveTraePath: () => "trae",
    };
    for (const t of ["codex", "kiro", "dsh", "pi", "trae"]) expect(findAgentCli(t, {}, resolvers)).toBe(t);
    expect(findAgentCli("claude-code", {}, resolvers)).toBe("claude");
    expect(findAgentCli("unknown", {}, resolvers)).toBe("claude");
  });

  it("install probe checks traecli and warns naming CHORUS_TRAE_PATH when missing", async () => {
    const errLog = vi.fn();
    const r = await resolveInstallAgent({ agent: "trae" }, {}, {
      writeConfig: vi.fn(),
      readJson: () => null,
      loginPath: "/tmp/none.json",
      probes: { resolveClaudePath: () => "/bin/claude", resolveTraePath: () => null },
      log: vi.fn(),
      errLog,
    });
    expect(r).toEqual({ agent: "trae", cliPath: null, cliFound: false });
    const joined = errLog.mock.calls.flat().join("\n");
    expect(joined).toContain("traecli CLI NOT FOUND");
    expect(joined).toContain("CHORUS_TRAE_PATH");
  });

  it("the banner names traecli + CHORUS_TRAE_PATH", () => {
    const base = {
      version: "1", url: "u", agentName: "a", agentUuid: "x", permissionMode: "chorus",
      credentialSource: "env", agentType: "trae",
    };
    expect(bannerRows({ ...base, cliPath: null })).toContainEqual([
      "traecli CLI",
      "NOT FOUND — install `traecli` or set CHORUS_TRAE_PATH",
    ]);
    expect(bannerRows({ ...base, cliPath: "/opt/traecli" })).toContainEqual(["traecli CLI", "found: /opt/traecli"]);
    expect(agentNotFoundWarningLine("trae")).toContain("CHORUS_TRAE_PATH");
  });

  it("runDaemon --agent trae probes traecli (not claude) and builds with agentType trae", async () => {
    const errs = [];
    const logs = [];
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const resolveClaudePath = vi.fn(() => "/usr/bin/claude");
    const resolveTraePath = vi.fn(() => null);
    const code = await runDaemon(
      { chorusOnly: true, agent: "trae" },
      {
        resolve: () => ({ url: "u", apiKey: "cho_x", source: "env" }),
        validate: async () => ({ uuid: "agent-1", name: "Daemon Bot" }),
        build,
        isTTY: false,
        log: (m) => logs.push(m),
        errLog: (m) => errs.push(m),
        waitForever: async () => {},
        resolveClaudePath,
        resolveTraePath,
        readJson: () => null,
        loginPath: join(TMP_HOME, "none.json"),
      },
    );
    expect(code).toBe(0);
    expect(resolveTraePath).toHaveBeenCalled();
    expect(resolveClaudePath).not.toHaveBeenCalled();
    expect(build.mock.calls[0][0].agentType ?? build.mock.calls[0][1]?.agentType).toBe("trae");
    expect(logs.join("\n")).toContain("traecli CLI");
    expect(errs.join("\n")).toContain("traecli CLI NOT FOUND");
  });
});

describe("spawner, wake errors, usage source", () => {
  it("selectSpawner('trae') builds a CodexSpawner on the TRAE profile", () => {
    const silent = { info() {}, warn() {}, error() {}, debug() {} };
    const s = selectSpawner("trae", { logger: silent, permissionMode: "chorus", creds: { url: "u", apiKey: "cho_x" } });
    expect(s).toBeInstanceOf(CodexSpawner);
    expect(s.profile).toBe(TRAE);
  });

  it("wake-error source trae is accepted", () => {
    expect(() => createWakeError({ source: "trae", kind: "startup", message: "boom" })).not.toThrow();
  });

  it("Codex-dialect usage frames are stamped with the profile clientType", () => {
    expect(codexUsageSourceFor("trae")).toBe("trae");
    expect(codexUsageSourceFor("codex")).toBe("codex");
    expect(codexUsageSourceFor(undefined)).toBe(CODEX_USAGE_SOURCE);
    expect(codexUsageSourceFor("claude-code")).toBe(CODEX_USAGE_SOURCE);
    const frame = { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 4 } };
    expect(extractCodexTurnUsage(frame).source).toBe("codex");
    expect([frame].map(extractCodexTurnUsage)[0].source).toBe("codex");
    expect(extractCodexTurnUsage(frame, { source: codexUsageSourceFor("trae") }).source).toBe("trae");
  });

  it.each([["trae", "trae"], ["codex", "codex"], [undefined, "codex"]])(
    "transcript hooks for agentType %s report usage source %s",
    async (agentType, expected) => {
      const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
      const hooks = createTranscriptUploadHooks({ url: "https://c", apiKey: "cho_x", agentType, fetchImpl, batchDelayMs: 0 });
      await hooks.onSessionStart({ sessionId: "s1" });
      await hooks.onTranscriptMessage({
        sessionId: "s1",
        message: { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
      });
      const { usage } = await hooks.onSessionEnd({ sessionId: "s1" });
      expect(usage.source).toBe(expected);
    },
  );
});
