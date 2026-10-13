// TRAE CLI (traecli) backend: the shared CodexSpawner parameterized with the
// CODEX_FAMILY.trae profile. Verified baseline: docs/verification/trae-app-server-0.209.1.md
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_FAMILY, codexFamilyProfile, resolveFamilyPath } from "../codex-family.mjs";
import { CodexSpawner, buildFamilyArgs, buildCodexArgs, hasChorusMcpServer, resolveCodexPath } from "../codex-spawner.mjs";
import { familySessionMap, codexSessionMapPath } from "../codex-session-map.mjs";
import { traeSessionMapPath, getThreadId as getTraeThreadId, setThreadId as setTraeThreadId } from "../trae-session-map.mjs";
import { codexUsageMapPath } from "../codex-usage-map.mjs";
import { CodexAppServerEvents } from "../codex-app-server-events.mjs";
import { validateAgentCliConfig, codexAppServerArgs, planAgentArgs } from "../agent-cli-config.mjs";
import { selectSpawner } from "../spawner-select.mjs";
import { appServerChild } from "./fixtures/codex-app-server-child.mjs";

const ANCHOR = "22222222-2222-4222-8222-222222222222";
const TID = "thread-1";
const silent = { info() {}, warn() {}, error() {} };
const methods = (child) => child.requests.map((r) => r.method).filter(Boolean);
const LIVE = JSON.parse(readFileSync(new URL("./fixtures/trae-app-server/live-0.209.1.json", import.meta.url), "utf8"));
const SCHEMA = JSON.parse(readFileSync(new URL("./fixtures/trae-app-server/schema-fields-0.209.1.json", import.meta.url), "utf8"));

function makeTrae(child = appServerChild(), opts = {}) {
  return new CodexSpawner({
    profile: CODEX_FAMILY.trae,
    codexPath: "/fake/traecli", spawnImpl: vi.fn(() => child),
    logger: silent, env: { PATH: "/bin" }, platform: "linux", permissionMode: "yolo",
    getThreadIdFn: () => null, setThreadIdFn: vi.fn(), getUsageSnapshotFn: () => null,
    setUsageSnapshotFn: vi.fn(), hasChorusMcpServerFn: () => true,
    cleanupTimeoutMs: 40, stdioGraceMs: 5,
    rpcLimits: { initializeTimeoutMs: 50, threadSetupTimeoutMs: 50, turnStartTimeoutMs: 50 },
    ...opts,
  });
}
const wake = (spawner, extra = {}) => spawner.wake({ prompt: "private prompt", sessionId: ANCHOR, ...extra });
const recorder = () => {
  const records = [];
  const logger = Object.fromEntries(["info", "warn", "error"].map((level) => [level, (message) => records.push({ level, message })]));
  return { records, logger };
};

describe("CODEX_FAMILY profiles", () => {
  it("are frozen and keep the Codex values unchanged", () => {
    expect(Object.isFrozen(CODEX_FAMILY)).toBe(true);
    expect(Object.isFrozen(CODEX_FAMILY.trae)).toBe(true);
    expect(Object.isFrozen(CODEX_FAMILY.trae.binaries.posix)).toBe(true);
    expect(CODEX_FAMILY.codex).toMatchObject({
      agentType: "codex", displayName: "Codex", pathEnv: "CHORUS_CODEX_PATH", homeEnv: "CODEX_HOME",
      homeDir: ".codex", configFile: "config.toml", sessionMapFile: "codex-sessions.json",
      usageMapFile: "codex-usage.json", wakeErrorSource: "codex", clientType: "codex", resumeExcludeTurns: true,
    });
    expect(CODEX_FAMILY.trae).toMatchObject({
      agentType: "trae", displayName: "TRAE CLI", pathEnv: "CHORUS_TRAE_PATH", homeEnv: "TRAE_HOME",
      homeDir: ".trae", configFile: "traecli.toml", sessionMapFile: "trae-sessions.json",
      usageMapFile: "trae-usage.json", wakeErrorSource: "trae", clientType: "trae",
      marketplaceSourceEnv: "CHORUS_MARKETPLACE_SOURCE_TRAE", resumeExcludeTurns: false,
    });
    expect(CODEX_FAMILY.trae.binaries).toEqual({ posix: ["traecli"], win32: ["traecli.cmd", "traecli.exe", "traecli"] });
    expect(codexFamilyProfile("trae")).toBe(CODEX_FAMILY.trae);
    expect(codexFamilyProfile("claude-code")).toBeNull();
    expect(codexFamilyProfile("toString")).toBeNull();
  });
});

describe("resolveFamilyPath (trae)", () => {
  const isFile = (set) => (p) => set.has(p);
  const trae = CODEX_FAMILY.trae;

  it("honors CHORUS_TRAE_PATH when it is a file, and ignores CHORUS_CODEX_PATH", () => {
    const env = { CHORUS_TRAE_PATH: "/opt/traecli", CHORUS_CODEX_PATH: "/opt/codex", PATH: "/usr/bin" };
    const files = new Set(["/opt/traecli", "/opt/codex"]);
    expect(resolveFamilyPath(trae, { env, platform: "linux", isFile: isFile(files) })).toBe("/opt/traecli");
    expect(resolveCodexPath({ env, platform: "linux", isFile: isFile(files) })).toBe("/opt/codex");
    expect(resolveFamilyPath(trae, { env: { CHORUS_CODEX_PATH: "/opt/codex", PATH: "/x" }, platform: "linux", isFile: isFile(files) })).toBeNull();
  });

  it("falls back to PATH when the override is not a file", () => {
    const env = { CHORUS_TRAE_PATH: "/missing/traecli", PATH: "/a:/b" };
    expect(resolveFamilyPath(trae, { env, platform: "linux", isFile: isFile(new Set(["/b/traecli"])) })).toBe("/b/traecli");
  });

  it("walks PATH for `traecli` only (never `codex`) on POSIX", () => {
    const env = { PATH: "/a:/b" };
    expect(resolveFamilyPath(trae, { env, platform: "linux", isFile: isFile(new Set(["/a/codex", "/b/traecli"])) })).toBe("/b/traecli");
    expect(resolveFamilyPath(trae, { env, platform: "linux", isFile: isFile(new Set(["/a/codex"])) })).toBeNull();
  });

  it("prefers traecli.cmd / traecli.exe on Windows", () => {
    const env = { Path: "C:\\bin" };
    expect(resolveFamilyPath(trae, { env, platform: "win32", isFile: isFile(new Set(["C:\\bin\\traecli.exe"])) })).toBe("C:\\bin\\traecli.exe");
    expect(resolveFamilyPath(trae, { env: { chorus_trae_path: "C:\\t\\traecli.exe" }, platform: "win32", isFile: isFile(new Set(["C:\\t\\traecli.exe"])) })).toBe("C:\\t\\traecli.exe");
  });

  it("the default TRAE spawner resolves through the TRAE profile", async () => {
    const child = appServerChild();
    const spawner = makeTrae(child, { codexPath: null, env: { PATH: "/nonexistent-chorus-test", CHORUS_TRAE_PATH: "/nonexistent-chorus-test/traecli" } });
    const result = await wake(spawner);
    expect(result.exitCode).toBeNull();
    expect(spawner.spawnImpl).not.toHaveBeenCalled();
    expect(result.wakeError).toMatchObject({ source: "trae", kind: "startup" });
    expect(result.wakeError.message).toBe("Cannot locate traecli executable; check installation and PATH");
  });
});

describe("hasChorusMcpServer (trae profile)", () => {
  it("reads $TRAE_HOME/traecli.toml, else ~/.trae/traecli.toml — never the Codex config", () => {
    const readFile = vi.fn(() => '[mcp_servers.chorus]\nurl = "https://chorus.test/api/mcp"\nbearer_token_env_var = "CHORUS_API_KEY"\n');
    expect(hasChorusMcpServer({ profile: CODEX_FAMILY.trae, env: { TRAE_HOME: "/trae", CODEX_HOME: "/codex" }, readFile })).toBe(true);
    expect(readFile).toHaveBeenLastCalledWith("/trae/traecli.toml", "utf8");
    hasChorusMcpServer({ profile: CODEX_FAMILY.trae, env: { CODEX_HOME: "/codex" }, home: "/home/u", readFile });
    expect(readFile).toHaveBeenLastCalledWith("/home/u/.trae/traecli.toml", "utf8");
  });

  it("the default TRAE probe uses the TRAE config path", async () => {
    const readFile = vi.fn(() => "");
    const dir = mkdtempSync(join(tmpdir(), "trae-home-"));
    try {
      writeFileSync(join(dir, "traecli.toml"), '[mcp_servers.chorus]\nurl = "x"\n');
      const spawner = makeTrae(undefined, { hasChorusMcpServerFn: undefined, env: { PATH: "/bin", TRAE_HOME: dir } });
      expect(spawner.hasChorusMcpServerFn({ env: spawner.env, platform: "linux" })).toBe(true);
      expect(readFile).not.toHaveBeenCalled();
      const codexOnly = makeTrae(undefined, { hasChorusMcpServerFn: undefined, env: { PATH: "/bin", TRAE_HOME: join(dir, "absent"), CODEX_HOME: dir } });
      expect(codexOnly.hasChorusMcpServerFn({ env: codexOnly.env, platform: "linux" })).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("warns once with a TRAE-branded message when [mcp_servers.chorus] is missing, and the wake continues", async () => {
    const { records, logger } = recorder();
    const probe = vi.fn(() => false);
    const spawner = makeTrae(undefined, { logger, hasChorusMcpServerFn: probe, spawnImpl: () => appServerChild() });
    expect((await wake(spawner)).exitCode).toBe(0);
    expect((await wake(spawner)).exitCode).toBe(0);
    expect(probe).toHaveBeenCalledTimes(1);
    const warnings = records.filter((r) => r.level === "warn");
    expect(warnings).toEqual([{ level: "warn", message: "[Chorus] TRAE CLI config has no [mcp_servers.chorus] entry; wake will continue without Chorus MCP tools" }]);
    expect(records.filter((r) => r.message.endsWith("App Server: CLOSED"))).toEqual([
      { level: "info", message: "[Chorus] TRAE CLI App Server: CLOSED" },
      { level: "info", message: "[Chorus] TRAE CLI App Server: CLOSED" },
    ]);
    expect(records.some((r) => /Codex/.test(r.message))).toBe(false);
  });
});

describe("TRAE App Server wake", () => {
  it.each([false, true])("spawns `traecli app-server --listen stdio://` without a shell and sends the Codex RPC sequence (resume=%s)", async (resumed) => {
    const { records, logger } = recorder();
    const child = appServerChild();
    const spawner = makeTrae(child, {
      logger, getThreadIdFn: () => resumed ? TID : null,
      cliConfig: { args: ["-m", "some model", "-c", "model_reasoning_effort=high"], env: { TRAE_HOME: "/isolated" } },
      creds: { url: "https://chorus.test", apiKey: "cho_secret_key_value", agentUuid: "agent-1" },
    });
    const result = await wake(spawner, { cwd: "/work tree" });
    expect(result).toEqual({ sessionId: ANCHOR, backendSessionId: TID, isNew: !resumed, exitCode: 0 });
    const [command, argv, opts] = spawner.spawnImpl.mock.calls[0];
    expect(command).toBe("/fake/traecli");
    expect(argv).toEqual(["app-server", "--listen", "stdio://", "-c", 'model="some model"', "-c", "model_reasoning_effort=high"]);
    expect(opts).toMatchObject({ cwd: "/work tree", shell: false, detached: true, windowsHide: true, env: {
      TRAE_HOME: "/isolated", CHORUS_URL: "https://chorus.test", CHORUS_API_KEY: "cho_secret_key_value",
      CHORUS_AGENT_PROFILE: "agent-1", CHORUS_DAEMON_HEADLESS: "1",
    } });
    // API key only via env: never argv, never RPC frames, never logs.
    expect(JSON.stringify(argv)).not.toMatch(/cho_secret|private prompt/);
    expect(JSON.stringify(child.requests)).not.toContain("cho_secret");
    expect(JSON.stringify(records)).not.toContain("cho_secret");
    expect(methods(child)).toEqual(["initialize", "initialized", resumed ? "thread/resume" : "thread/start", "turn/start"]);
    expect(child.requests[0].params).toMatchObject({ clientInfo: { name: "chorus" }, capabilities: { experimentalApi: false } });
    expect(child.requests[2].params).toMatchObject({ cwd: "/work tree", sandbox: "danger-full-access", approvalPolicy: "never" });
    expect(child.requests[3].params).toMatchObject({
      threadId: TID, cwd: "/work tree", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
      input: [{ type: "text", text: "private prompt", text_elements: [] }],
    });
    if (resumed) {
      // traecli 0.209.1 rejects excludeTurns without experimentalApi; never sent.
      expect(child.requests[2].params).toEqual({ cwd: "/work tree", approvalPolicy: "never", sandbox: "danger-full-access", threadId: TID });
    }
  });

  it.each([false, true])("chorus mode maps to read-only / readOnly with approvalPolicy never (resume=%s)", async (resumed) => {
    const child = appServerChild();
    await wake(makeTrae(child, { permissionMode: "chorus", getThreadIdFn: () => resumed ? TID : null }));
    expect(child.requests[2].params).toMatchObject({ sandbox: "read-only", approvalPolicy: "never" });
    expect(child.requests[3].params).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } });
  });

  it("Codex resume still sends excludeTurns (unchanged)", async () => {
    const child = appServerChild();
    await new CodexSpawner({
      codexPath: "/fake/codex", spawnImpl: () => child, logger: silent, env: { PATH: "/bin" }, platform: "linux",
      getThreadIdFn: () => TID, setThreadIdFn: () => {}, getUsageSnapshotFn: () => null, setUsageSnapshotFn: () => {},
      hasChorusMcpServerFn: () => true, cleanupTimeoutMs: 40, stdioGraceMs: 5,
    }).wake({ prompt: "p", sessionId: ANCHOR });
    expect(child.requests[2].params).toMatchObject({ threadId: TID, excludeTurns: true });
  });

  it.each(["yolo", "chorus"])("%s RPC params use only fields and enum values present in the traecli 0.209.1 schema", async (permissionMode) => {
    for (const resumed of [false, true]) {
      const child = appServerChild();
      await wake(makeTrae(child, { permissionMode, getThreadIdFn: () => resumed ? TID : null }));
      const [init, , setup, turn] = child.requests;
      for (const key of Object.keys(init.params)) expect(SCHEMA.InitializeParams.properties).toContain(key);
      const setupSchema = SCHEMA.params[resumed ? "ThreadResumeParams" : "ThreadStartParams"];
      for (const key of Object.keys(setup.params)) expect(setupSchema.properties).toContain(key);
      for (const key of setupSchema.required) expect(setup.params).toHaveProperty(key);
      for (const key of Object.keys(turn.params)) expect(SCHEMA.params.TurnStartParams.properties).toContain(key);
      for (const key of SCHEMA.params.TurnStartParams.required) expect(turn.params).toHaveProperty(key);
      expect(SCHEMA.enums.SandboxMode).toContain(setup.params.sandbox);
      expect(SCHEMA.enums.AskForApproval).toContain(setup.params.approvalPolicy);
      expect(SCHEMA.enums.SandboxPolicyTypes).toContain(turn.params.sandboxPolicy.type);
      if (turn.params.sandboxPolicy.type === "readOnly") {
        for (const key of Object.keys(turn.params.sandboxPolicy)) expect(SCHEMA.enums.ReadOnlySandboxPolicyProperties).toContain(key);
      }
    }
    expect(SCHEMA.params.ThreadResumeParams.properties).not.toContain("excludeTurns");
    expect(Object.values(SCHEMA.clientRequestsUsed).every(Boolean)).toBe(true);
    expect(Object.values(SCHEMA.serverNotificationsUsed).every(Boolean)).toBe(true);
  });

  it("falls back on the exact verified TRAE history error and emits a TRAE-branded notice", async () => {
    const live = LIVE.transcript.find((e) => e.message.error?.message?.startsWith("no rollout found")).message.error;
    const oldThread = "00000000-0000-4000-8000-000000000001";
    expect(live.message).toBe(`no rollout found for thread id ${oldThread}`);
    const child = appServerChild({ handler(req, c) {
      if (req.method === "thread/resume") { c.send({ id: req.id, error: live }); return true; }
    } });
    const messages = [];
    const { records, logger } = recorder();
    const spawner = makeTrae(child, { logger, getThreadIdFn: () => oldThread });
    expect(await wake(spawner, { onMessage: (m) => messages.push(m) })).toMatchObject({ isNew: true, backendSessionId: TID, exitCode: 0 });
    expect(methods(child)).toEqual(["initialize", "initialized", "thread/resume", "thread/start", "turn/start"]);
    expect(messages.filter((m) => m.item?.text === "Previous TRAE CLI history could not be restored; continuing in a new thread with Chorus context.")).toHaveLength(1);
    expect(records.some((r) => r.message.includes("Previous TRAE CLI history"))).toBe(true);
  });

  it("the live excludeTurns rejection is NOT treated as missing history (no silent fallback)", async () => {
    const live = LIVE.transcript.find((e) => e.message.error?.message?.includes("excludeTurns")).message.error;
    const child = appServerChild({ handler(req, c) {
      if (req.method === "thread/resume") { c.send({ id: req.id, error: live }); return true; }
    } });
    const { records, logger } = recorder();
    const result = await wake(makeTrae(child, { logger, getThreadIdFn: () => "old-thread" }));
    expect(result).toMatchObject({ exitCode: null, backendSessionId: "old-thread" });
    expect(methods(child)).not.toContain("thread/start");
    expect(result.wakeError).toMatchObject({ source: "trae" });
    expect(records.filter((r) => r.level === "error").map((r) => r.message)).toContain(
      "[Chorus] TRAE CLI App Server wake failed (RPC_ERROR); check TRAE CLI 0.209.1+ installation, login, model/config and local session storage. Unsupported args must use model or permitted -c settings.",
    );
  });

  it("replays the live 0.209.1 notification stream into one completed turn with exclusive usage", async () => {
    const server = LIVE.transcript.filter((e) => e.direction === "server").map((e) => e.message);
    const tid = server.find((m) => m.method === "thread/started").params.thread.id;
    const turnId = server.find((m) => m.method === "turn/started").params.turn.id;
    const child = appServerChild({ threadId: tid, turnId, handler(req, c) {
      if (req.method === "thread/start") {
        c.send(server.find((m) => m.method === "thread/started"));
        c.reply(req, server.find((m) => m.id === 2).result); return true;
      }
      if (req.method === "turn/start") {
        c.send(server.find((m) => m.method === "turn/started"));
        c.reply(req, server.find((m) => m.id === 3).result);
        for (const method of ["item/completed", "thread/tokenUsage/updated", "turn/completed"]) c.send(server.find((m) => m.method === method));
        return true;
      }
    } });
    const messages = [];
    const setUsageSnapshotFn = vi.fn();
    const result = await wake(makeTrae(child, { setUsageSnapshotFn }), { onMessage: (m) => messages.push(m) });
    expect(result).toEqual({ sessionId: ANCHOR, backendSessionId: tid, isNew: true, exitCode: 0 });
    expect(messages.find((m) => m.type === "item.completed").item).toMatchObject({ type: "agent_message", text: "OK" });
    const total = server.find((m) => m.method === "thread/tokenUsage/updated").params.tokenUsage.total;
    // TRAE spells the cache-write counter cacheCreationInputTokens.
    expect(setUsageSnapshotFn).toHaveBeenCalledWith(ANCHOR, tid, {
      input_tokens: total.inputTokens, cached_input_tokens: total.cachedInputTokens,
      cache_write_input_tokens: total.cacheCreationInputTokens,
      output_tokens: total.outputTokens, reasoning_output_tokens: total.reasoningOutputTokens,
    });
    const usage = messages.find((m) => m.type === "turn.completed").usage;
    expect(usage).toMatchObject({
      input_tokens: total.inputTokens - total.cachedInputTokens - total.cacheCreationInputTokens,
      cache_write_input_tokens: total.cacheCreationInputTokens, output_tokens: total.outputTokens,
    });
  });

  it.each([
    ["spawn", { spawnImpl: () => { throw Object.assign(new Error("spawn traecli ENOENT /secret/path"), { code: "ENOENT" }); } }],
    ["unsafe shim", { codexPath: "C:\\bin\\traecli.cmd", platform: "win32", cliConfig: { args: ["-c", "model=a b"] } }],
  ])("fails with TRAE-branded diagnostics for %s", async (mode, opts) => {
    const { records, logger } = recorder();
    const result = await wake(makeTrae(appServerChild(), { logger, ...opts }));
    expect(result.exitCode).toBeNull();
    expect(result.wakeError.source).toBe("trae");
    if (mode === "spawn") expect(result.wakeError.message).toMatch(/^Cannot spawn traecli: /);
    else expect(result.wakeError.message).toBe("TRAE CLI Windows shim cannot safely carry configured arguments; use a native executable");
    expect(records.every((r) => !/Codex/.test(r.message))).toBe(true);
  });

  it("rejects unsupported daemon args with a TRAE-branded configuration error before spawn", () => {
    expect(() => makeTrae(undefined, { cliConfig: { args: ["--permission-mode=bypass_permissions"] } })).toThrow(/managed backend controls/);
    expect(() => makeTrae(undefined, { cliConfig: { args: ["-y"] } })).toThrow(/managed backend controls/);
    expect(() => makeTrae(undefined, { cliConfig: { args: ["-c", 'permission_mode="bypass_permissions"'] } })).toThrow(/managed TRAE CLI config key/);
    expect(() => makeTrae(undefined, { cliConfig: { args: ["-c", 'mcp_servers.chorus.url="x"'] } })).toThrow(/managed TRAE CLI config key/);
  });

  it("wakeErrorSource and default stores come from the TRAE profile", () => {
    const spawner = new CodexSpawner({ profile: CODEX_FAMILY.trae, logger: silent });
    expect(spawner.wakeErrorSource).toBe("trae");
    expect(new CodexSpawner({ logger: silent }).wakeErrorSource).toBe("codex");
  });
});

describe("separate session and usage maps", () => {
  let home;
  let previousHome;
  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "chorus-family-home-"));
    process.env.HOME = home;
    mkdirSync(join(home, ".chorus"), { recursive: true });
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const realStores = (profile) => new CodexSpawner({
    profile, codexPath: "/fake/bin", logger: silent, env: { PATH: "/bin" }, platform: "linux",
    hasChorusMcpServerFn: () => true, cleanupTimeoutMs: 40, stdioGraceMs: 5,
    spawnImpl: vi.fn(() => appServerChild({ threadId: `${profile.agentType}-new-thread` })),
  });
  const readJson = (file) => JSON.parse(readFileSync(join(home, ".chorus", file), "utf8"));

  it("map files are distinct per profile", () => {
    expect(familySessionMap(CODEX_FAMILY.codex).mapPath()).toBe(codexSessionMapPath());
    expect(codexSessionMapPath()).toBe(join(home, ".chorus", "codex-sessions.json"));
    expect(traeSessionMapPath()).toBe(join(home, ".chorus", "trae-sessions.json"));
    expect(codexUsageMapPath()).toBe(join(home, ".chorus", "codex-usage.json"));
    expect(codexUsageMapPath(CODEX_FAMILY.trae.usageMapFile)).toBe(join(home, ".chorus", "trae-usage.json"));
  });

  it("a Codex thread id is never resumed on TRAE", async () => {
    writeFileSync(join(home, ".chorus", "codex-sessions.json"), JSON.stringify({ [ANCHOR]: "codex-thread" }));
    const spawner = realStores(CODEX_FAMILY.trae);
    const result = await wake(spawner);
    expect(result).toMatchObject({ isNew: true, backendSessionId: "trae-new-thread", exitCode: 0 });
    const child = spawner.spawnImpl.mock.results[0].value;
    expect(methods(child)).toContain("thread/start");
    expect(methods(child)).not.toContain("thread/resume");
    expect(readJson("trae-sessions.json")).toEqual({ [ANCHOR]: "trae-new-thread" });
    expect(readJson("codex-sessions.json")).toEqual({ [ANCHOR]: "codex-thread" });
    expect(getTraeThreadId(ANCHOR)).toBe("trae-new-thread");
  });

  it("a TRAE thread id is never resumed on Codex", async () => {
    setTraeThreadId(ANCHOR, "trae-thread");
    const spawner = realStores(CODEX_FAMILY.codex);
    const result = await wake(spawner);
    expect(result).toMatchObject({ isNew: true, backendSessionId: "codex-new-thread", exitCode: 0 });
    expect(methods(spawner.spawnImpl.mock.results[0].value)).not.toContain("thread/resume");
    expect(readJson("codex-sessions.json")).toEqual({ [ANCHOR]: "codex-new-thread" });
    expect(readJson("trae-sessions.json")).toEqual({ [ANCHOR]: "trae-thread" });
  });

  it("each backend resumes only its own thread and writes usage only to its own file", async () => {
    writeFileSync(join(home, ".chorus", "codex-sessions.json"), JSON.stringify({ [ANCHOR]: "codex-thread" }));
    writeFileSync(join(home, ".chorus", "trae-sessions.json"), JSON.stringify({ [ANCHOR]: "trae-thread" }));
    for (const profile of [CODEX_FAMILY.trae, CODEX_FAMILY.codex]) {
      const own = `${profile.agentType}-thread`;
      const spawner = new CodexSpawner({
        profile, codexPath: "/fake/bin", logger: silent, env: { PATH: "/bin" }, platform: "linux",
        hasChorusMcpServerFn: () => true, cleanupTimeoutMs: 40, stdioGraceMs: 5,
        spawnImpl: vi.fn(() => appServerChild({ threadId: own, handler(req, c) {
          if (req.method === "turn/start") {
            c.reply(req, { turn: { id: "turn-1" } });
            c.send({ method: "thread/tokenUsage/updated", params: { threadId: own, turnId: "turn-1", tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 } } } });
            c.terminal(); return true;
          }
        } })),
      });
      expect(await wake(spawner)).toMatchObject({ isNew: false, backendSessionId: own, exitCode: 0 });
      const resume = spawner.spawnImpl.mock.results[0].value.requests.find((r) => r.method === "thread/resume");
      expect(resume.params.threadId).toBe(own);
    }
    expect(readJson("trae-usage.json")).toEqual({ [ANCHOR]: { threadId: "trae-thread", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } } });
    expect(readJson("codex-usage.json")).toEqual({ [ANCHOR]: { threadId: "codex-thread", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } } });
  });

  it("a Codex usage baseline is never applied to a TRAE thread", async () => {
    writeFileSync(join(home, ".chorus", "trae-sessions.json"), JSON.stringify({ [ANCHOR]: "shared-id" }));
    writeFileSync(join(home, ".chorus", "codex-usage.json"), JSON.stringify({ [ANCHOR]: { threadId: "shared-id", usage: { input_tokens: 5 } } }));
    const spawner = realStores(CODEX_FAMILY.trae);
    expect(spawner.getUsageSnapshotFn(ANCHOR, "shared-id")).toBeNull();
    expect(existsSync(join(home, ".chorus", "trae-usage.json"))).toBe(false);
  });
});

describe("events: counter alias", () => {
  it("uses cacheCreationInputTokens only when cacheWriteInputTokens is absent", () => {
    const snapshots = [];
    const make = () => new CodexAppServerEvents({ threadId: "t", isNew: true, onUsageSnapshot: (s) => snapshots.push(s) });
    const feed = (adapter, total) => {
      adapter.confirmTurn("u");
      adapter.accept({ method: "thread/tokenUsage/updated", params: { threadId: "t", turnId: "u", tokenUsage: { total } } });
    };
    feed(make(), { inputTokens: 10, cacheCreationInputTokens: 4 });
    feed(make(), { inputTokens: 10, cacheWriteInputTokens: 3, cacheCreationInputTokens: 4 });
    expect(snapshots).toEqual([
      { input_tokens: 10, cache_write_input_tokens: 4 },
      { input_tokens: 10, cache_write_input_tokens: 3 },
    ]);
  });
});

describe("agent-cli-config: trae", () => {
  it("reuses the Codex -c parser, model translation and managed-key denylist", () => {
    expect(validateAgentCliConfig({ args: ["-c", 'model="m"', "--model=x", "-mfoo"] }, "trae").args).toHaveLength(4);
    for (const key of ["mcp_servers.chorus.url", "sandbox_mode", "approval_policy", "permissions.x", "developer_instructions", "permission_mode"]) {
      expect(() => validateAgentCliConfig({ args: ["-c", `${key}="x"`] }, "trae")).toThrow(/managed TRAE CLI config key/);
    }
    // permission_mode is TRAE-specific; Codex's denylist is unchanged.
    expect(() => validateAgentCliConfig({ args: ["-c", "permission_mode=1"] }, "codex")).not.toThrow();
    expect(codexAppServerArgs(["-m", "gpt", "-c", "k=1"], "agent", "trae")).toEqual(["-c", 'model="gpt"', "-c", "k=1"]);
    expect(() => codexAppServerArgs(["--enable=x"], "agent", "trae")).toThrow(/unsupported by TRAE CLI App Server/);
    expect(buildFamilyArgs(CODEX_FAMILY.trae, { args: ["-m", "x"] })).toEqual(["app-server", "--listen", "stdio://", "-c", 'model="x"']);
    expect(buildCodexArgs({ args: ["-m", "x"] })).toEqual(["app-server", "--listen", "stdio://", "-c", 'model="x"']);
  });

  it.each([
    "--permission-mode=default", "-y", "--dangerously-bypass-approvals-and-sandbox", "-w", "--worktree=x",
    "--session-id=x", "--session-source=x", "--acp", "--listen=stdio://", "--sandbox=read-only", "-s", "-a", "--resume=x",
    "--allowed-tool=x", "--disallowed-tool=x", "--no-daemon",
  ])("protects TRAE posture/session/transport control %s", (arg) => {
    expect(() => validateAgentCliConfig({ args: [arg] }, "trae")).toThrow(/managed backend controls/);
  });

  it("model singletons override configured model in foreground plans like Codex", () => {
    expect(planAgentArgs("trae", ["-m", "a"], ["-m", "b"]).args).toEqual(["-m", "b"]);
    expect(planAgentArgs("trae", ["-c", 'model="a"'], ["exec", "-c", 'model="b"']).args).toEqual(["exec", "-c", 'model="b"']);
  });
});

describe("selectSpawner: trae", () => {
  it("returns the shared CodexSpawner bound to the TRAE profile, threading opts", () => {
    const creds = { url: "https://chorus.test", apiKey: "cho_x" };
    const s = selectSpawner("trae", { logger: silent, permissionMode: "chorus", creds });
    expect(s).toBeInstanceOf(CodexSpawner);
    expect(s.profile).toBe(CODEX_FAMILY.trae);
    expect(s.wakeErrorSource).toBe("trae");
    expect(s.permissionMode).toBe("chorus");
    expect(s.creds).toEqual(creds);
    expect(selectSpawner("codex", { logger: silent }).profile).toBe(CODEX_FAMILY.codex);
  });
});
