// cli/__tests__/daemon-install-integration.test.mjs
// Integration checkpoint for `chorus daemon install` (fix-daemon-install-config,
// task 3). Drives the REAL install wiring end-to-end through runDaemon →
// handleLifecycleAction("install") → the REAL resolveInstallCredentials /
// resolveInstallCwds helpers, persisting to a REAL temp ~/.chorus/daemon.json via
// the REAL updateDaemonConfig writer. Only two things are stubbed:
//   - the network (validate) — no live Chorus server in CI,
//   - the unit writer + systemctl (service.installService / resolveServicePaths) —
//     we must NEVER `systemctl --user enable --now` the chorus-daemon.service that
//     may be running the host session.
// This proves the whole chain: env-only creds → validated → written to daemon.json
// (so a clean boot env can read them) → unit rendered WITHOUT --cwd → cwds persisted
// to daemon.json. The bad-key path proves no unit is written and exit is non-zero.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDaemon } from "../daemon.mjs";
import { updateDaemonConfig } from "../login.mjs";
import { renderSystemdUnit } from "../daemon-service.mjs";

let dir;
let loginPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chorus-install-it-"));
  loginPath = join(dir, "daemon.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Read the temp daemon.json (or null if absent). */
function readConfig() {
  if (!existsSync(loginPath)) return null;
  return JSON.parse(readFileSync(loginPath, "utf8"));
}

/**
 * A service seam that captures the spec + renders a REAL unit (so we assert the
 * real ExecStart), but NEVER touches systemctl or the real filesystem unit path.
 */
function captureService() {
  const calls = { spec: null };
  return {
    detectSupervisor: () => ({ kind: "none" }),
    resolveServicePaths: () => ({ nodePath: "/usr/bin/node", scriptPath: "/opt/chorus/chorus.mjs", path: "/usr/bin:/bin" }),
    installService: vi.fn((spec) => {
      calls.spec = spec;
      // Render the REAL systemd unit from the spec to assert its content, but do
      // not write it anywhere or run systemctl.
      const unitText = renderSystemdUnit({ ...spec, home: dir });
      return { platform: "linux", installed: true, unitPath: join(dir, "unit"), unitText, steps: ["wrote (stub)"] };
    }),
    uninstallService: vi.fn(),
    systemctlUser: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    journalctlUser: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    __calls: calls,
  };
}

const fakeLifecycle = () => ({
  isRunning: () => ({ running: false, pid: null, stale: false }),
  startBackground: vi.fn(),
  stopDaemon: vi.fn(),
  readLog: vi.fn(),
});

describe("chorus daemon install — end-to-end config phase (real helpers, temp daemon.json)", () => {
  it("env-only creds: validates, persists creds+cwds to daemon.json, renders a --cwd-free unit", async () => {
    const service = captureService();
    const logs = [];
    const code = await runDaemon(
      { action: "install", cwd: ["/srv/one", "/srv/two", "/srv/one"] }, // dup dropped
      {
        isTTY: false, // non-TTY → skip prompts, but still resolve+persist+validate
        env: { CHORUS_URL: "https://chorus.example", CHORUS_API_KEY: "cho_realkey" },
        // Only the network is stubbed.
        validate: async ({ url, apiKey }) => {
          expect(url).toBe("https://chorus.example");
          expect(apiKey).toBe("cho_realkey");
          return { uuid: "agent-xyz", name: "Installer Bot" };
        },
        // Real 0600 field-merge writer, pointed at the temp file.
        writeConfig: (partial) => updateDaemonConfig(partial, { path: loginPath }),
        readJson: () => readConfig(),
        loginPath,
        service,
        lifecycle: fakeLifecycle(),
        log: (m) => logs.push(m),
        errLog: (m) => logs.push("E:" + m),
      }
    );

    expect(code).toBe(0);

    // daemon.json gained the validated credentials + identity...
    const cfg = readConfig();
    expect(cfg).toMatchObject({
      url: "https://chorus.example",
      apiKey: "cho_realkey",
      agentUuid: "agent-xyz",
      agentName: "Installer Bot",
    });
    // ...and the normalized, de-duplicated cwd set (single source of truth).
    expect(cfg.cwds).toEqual(["/srv/one", "/srv/two"]);

    // The rendered unit authenticates from the file, so it must carry NO --cwd
    // and NO credential env line.
    const unit = service.__calls.spec ? service.installService.mock.results[0].value.unitText : "";
    expect(unit).toMatch(/ExecStart=.*chorus\.mjs daemon$/m);
    expect(unit).not.toMatch(/--cwd/);
    expect(unit).not.toMatch(/CHORUS_API_KEY/);
    expect(unit).not.toMatch(/CHORUS_URL/);
  });

  it("bad key: aborts non-zero, writes NO unit, and no daemon.json", async () => {
    const service = captureService();
    const errs = [];
    const code = await runDaemon(
      { action: "install", cwd: ["/srv/one"] },
      {
        isTTY: false,
        env: { CHORUS_URL: "https://chorus.example", CHORUS_API_KEY: "cho_badkey" },
        validate: async () => { throw new Error("401 Unauthorized — invalid API key"); },
        writeConfig: (partial) => updateDaemonConfig(partial, { path: loginPath }),
        readJson: () => readConfig(),
        loginPath,
        service,
        lifecycle: fakeLifecycle(),
        log: () => {},
        errLog: (m) => errs.push(m),
      }
    );

    expect(code).toBe(1);
    // No unit was written (installService never called)...
    expect(service.installService).not.toHaveBeenCalled();
    // ...and no credentials were persisted.
    expect(readConfig()).toBeNull();
    expect(errs.join("")).toMatch(/validation failed|aborted/i);
  });

  it("no resolvable creds on a non-TTY: aborts with the multi-source hint, writes nothing", async () => {
    const service = captureService();
    const errs = [];
    const code = await runDaemon(
      { action: "install" },
      {
        isTTY: false,
        env: {}, // nothing exported
        // resolve default would read the real ~/.chorus/daemon.json + plugin; to keep
        // the test hermetic, inject a resolve that fails like the real one when empty.
        resolve: () => { throw new Error("Could not resolve Chorus credentials (url + cho_ API key). Tried, in order: ..."); },
        validate: async () => { throw new Error("should not be called"); },
        writeConfig: (partial) => updateDaemonConfig(partial, { path: loginPath }),
        readJson: () => readConfig(),
        loginPath,
        service,
        lifecycle: fakeLifecycle(),
        log: () => {},
        errLog: (m) => errs.push(m),
      }
    );

    expect(code).toBe(1);
    expect(service.installService).not.toHaveBeenCalled();
    expect(readConfig()).toBeNull();
    expect(errs.join("")).toMatch(/Could not resolve Chorus credentials/);
  });

  it("preserves pre-existing daemon.json fields across the install persist (field-merge)", async () => {
    // Seed a login file that already carries yoloAckAt + sigintTimeoutMs.
    updateDaemonConfig({ yoloAckAt: "2026-01-01T00:00:00.000Z", sigintTimeoutMs: 12345 }, { path: loginPath });
    const service = captureService();
    const code = await runDaemon(
      { action: "install", cwd: ["/srv/x"] },
      {
        isTTY: false,
        env: { CHORUS_URL: "https://c.example", CHORUS_API_KEY: "cho_k2" },
        validate: async () => ({ uuid: "a2", name: "Bot2" }),
        writeConfig: (partial) => updateDaemonConfig(partial, { path: loginPath }),
        readJson: () => readConfig(),
        loginPath,
        service,
        lifecycle: fakeLifecycle(),
        log: () => {},
        errLog: () => {},
      }
    );
    expect(code).toBe(0);
    const cfg = readConfig();
    // credential + cwd fields added, pre-existing fields preserved.
    expect(cfg).toMatchObject({
      url: "https://c.example",
      apiKey: "cho_k2",
      agentUuid: "a2",
      yoloAckAt: "2026-01-01T00:00:00.000Z",
      sigintTimeoutMs: 12345,
      cwds: ["/srv/x"],
    });
  });

  it("prepares a managed dsh composition before activating the service", async () => {
    const service = captureService();
    const prepareManagedDshConfig = vi.fn(async () => ({ configPath: join(dir, "dsh", "cordis.yml") }));
    const code = await runDaemon(
      { action: "install", agent: "dsh" },
      {
        isTTY: false,
        env: { CHORUS_URL: "https://c.example", CHORUS_API_KEY: "cho_dsh" },
        validate: async () => ({ uuid: "dsh-agent", name: "Dsh Bot" }),
        resolveDshPath: () => "/usr/bin/dsh-jsonrpc-agent",
        prepareManagedDshConfig,
        writeConfig: (partial) => updateDaemonConfig(partial, { path: loginPath }),
        readJson: () => readConfig(),
        loginPath,
        service,
        lifecycle: fakeLifecycle(),
        log: () => {},
        errLog: () => {},
        version: "0.16.3",
      },
    );
    expect(code).toBe(0);
    expect(prepareManagedDshConfig).toHaveBeenCalledWith(expect.objectContaining({
      bundleVersion: "0.16.3",
      dshPath: "/usr/bin/dsh-jsonrpc-agent",
      creds: { url: "https://c.example", apiKey: "cho_dsh" },
    }));
    expect(prepareManagedDshConfig.mock.invocationCallOrder[0])
      .toBeLessThan(service.installService.mock.invocationCallOrder[0]);
  });

  it("aborts service activation on managed dsh validation failure", async () => {
    const service = captureService();
    const errs = [];
    const code = await runDaemon(
      { action: "install", agent: "dsh" },
      {
        isTTY: false,
        env: { CHORUS_URL: "https://c.example", CHORUS_API_KEY: "cho_dsh" },
        validate: async () => ({ uuid: "dsh-agent", name: "Dsh Bot" }),
        resolveDshPath: () => "/usr/bin/dsh-jsonrpc-agent",
        prepareManagedDshConfig: async () => { throw new Error("peer resolution failed"); },
        writeConfig: (partial) => updateDaemonConfig(partial, { path: loginPath }),
        readJson: () => readConfig(),
        loginPath,
        service,
        lifecycle: fakeLifecycle(),
        log: () => {},
        errLog: (line) => errs.push(line),
        version: "0.16.3",
      },
    );
    expect(code).toBe(1);
    expect(service.installService).not.toHaveBeenCalled();
    expect(errs.join("\n")).toMatch(/managed composition.*peer resolution failed/);
  });

  it("leaves an explicit dsh config override untouched and skips managed preparation", async () => {
    const service = captureService();
    const prepareManagedDshConfig = vi.fn();
    const code = await runDaemon(
      { action: "install", agent: "dsh" },
      {
        isTTY: false,
        env: {
          CHORUS_URL: "https://c.example",
          CHORUS_API_KEY: "cho_dsh",
          CHORUS_DSH_CONFIG: "/operator/cordis.yml",
        },
        validate: async () => ({ uuid: "dsh-agent", name: "Dsh Bot" }),
        resolveDshPath: () => "/usr/bin/dsh-jsonrpc-agent",
        prepareManagedDshConfig,
        writeConfig: (partial) => updateDaemonConfig(partial, { path: loginPath }),
        readJson: () => readConfig(),
        loginPath,
        service,
        lifecycle: fakeLifecycle(),
        log: () => {},
        errLog: () => {},
      },
    );
    expect(code).toBe(0);
    expect(prepareManagedDshConfig).not.toHaveBeenCalled();
    expect(readConfig()).not.toHaveProperty("dshConfig");
  });
});
