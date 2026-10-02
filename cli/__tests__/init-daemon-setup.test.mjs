// cli/__tests__/init-daemon-setup.test.mjs
// Unit tests for the `chorus init` daemon-setup step (idea a7c2a3e8). All
// collaborators (capability probe, supervisor detect, installService, and the
// reused daemon-install preflight resolvers) are injected, so the step's decision
// logic is exercised without real systemctl / launchctl / disk / network.
import { describe, it, expect, vi } from "vitest";
import { setupDaemon, daemonSetupStep } from "../init/steps/daemon-setup.mjs";
import { OUTCOME_ACTIONS } from "../init/contracts.mjs";

const { INSTALLED, SKIPPED, FAILED } = OUTCOME_ACTIONS;

function ctx(over = {}) {
  return {
    env: {},
    flags: {},
    io: { log: vi.fn(), isTTY: false },
    autostartCapability: vi.fn(() => "systemd"),
    detectSupervisor: vi.fn(() => ({ kind: "none" })),
    installService: vi.fn(() => ({ platform: "linux", installed: true, unitPath: "/u", unitText: "Type=simple", steps: ["wrote /u", "systemctl --user enable --now chorus-daemon.service"] })),
    // Never reach the REAL loginctl from a unit test (it would change the host).
    ensureLinger: vi.fn(() => ({ result: "already", user: "u" })),
    resolveServicePaths: vi.fn(() => ({ nodePath: "/node", scriptPath: "/x/chorus.mjs", path: "/bin" })),
    resolveInstallCredentials: vi.fn(async () => ({ ok: true, creds: { url: "u", apiKey: "cho_k" }, identity: { uuid: "a", name: "Bot" } })),
    resolveInstallCwds: vi.fn(async () => ({ cwds: ["/a"] })),
    resolveInstallAgent: vi.fn(async () => ({ ok: true, agent: "claude-code", cliFound: true })),
    processCwd: "/proj",
    // The daemon-setup auto-start gate reads daemon.json agents[] (written by
    // credential-seed) to decide if anything WILL be woken. Default: one woken agent.
    readJson: () => ({ agents: [{ agentType: "claude-code", daemonWake: true }] }),
    ...over,
  };
}

describe("daemonSetupStep shape", () => {
  it("is a once-scoped step ordered after plugin-install (20)", () => {
    expect(daemonSetupStep.scope).toBe("once");
    expect(daemonSetupStep.order).toBeGreaterThan(20);
  });
});

describe("full preflight (always runs)", () => {
  it("persists cwds + backend agent before any install decision", async () => {
    const c = ctx({ flags: {} }); // non-interactive, no --daemon-autostart → will skip install
    await setupDaemon(c);
    expect(c.resolveInstallCwds).toHaveBeenCalledOnce();
    expect(c.resolveInstallAgent).toHaveBeenCalledOnce();
  });
});

describe("capability gate", () => {
  it("unsupported platform: writes daemon.json + prints manual steps, never installs (even with --daemon-autostart)", async () => {
    const c = ctx({
      autostartCapability: vi.fn(() => "unsupported"),
      flags: { daemonAutostart: true },
    });
    const r = await setupDaemon(c);
    expect(r.action).toBe(SKIPPED);
    expect(r.detail).toMatch(/unsupported/);
    expect(c.installService).not.toHaveBeenCalled();
    expect(c.resolveInstallCredentials).not.toHaveBeenCalled();
    // manual start hint printed
    expect(c.io.log.mock.calls.flat().join("\n")).toMatch(/chorus daemon/);
  });
});

describe("non-interactive (non-TTY or --yes) decision", () => {
  it("skips the service without --daemon-autostart and names the flag (never prompts)", async () => {
    const ask = vi.fn();
    const c = ctx({ io: { log: vi.fn(), isTTY: false, ask }, flags: {} });
    const r = await setupDaemon(c);
    expect(r.action).toBe(SKIPPED);
    expect(r.detail).toMatch(/--daemon-autostart/);
    expect(ask).not.toHaveBeenCalled();
    expect(c.installService).not.toHaveBeenCalled();
  });

  it("installs with --daemon-autostart on a supported platform", async () => {
    const c = ctx({ flags: { daemonAutostart: true } });
    const r = await setupDaemon(c);
    expect(r.action).toBe(INSTALLED);
    expect(c.resolveInstallCredentials).toHaveBeenCalledOnce();
    expect(c.installService).toHaveBeenCalledOnce();
  });

  it("treats --yes in a TTY as non-interactive (flag governs, no prompt)", async () => {
    const ask = vi.fn();
    const c = ctx({ io: { log: vi.fn(), isTTY: true, ask }, flags: { yes: true } });
    const r = await setupDaemon(c);
    expect(ask).not.toHaveBeenCalled();
    expect(r.action).toBe(SKIPPED); // no --daemon-autostart
  });
});

describe("interactive (TTY) decision — default No", () => {
  it("declining (blank/Enter) writes daemon.json + manual steps, installs nothing", async () => {
    const ask = vi.fn(async () => ""); // Enter = default No
    const c = ctx({ io: { log: vi.fn(), isTTY: true, ask } });
    const r = await setupDaemon(c);
    expect(ask).toHaveBeenCalledOnce();
    expect(r.action).toBe(SKIPPED);
    expect(c.installService).not.toHaveBeenCalled();
  });

  it("accepting (y) runs the credential gate and installs", async () => {
    const ask = vi.fn(async () => "y");
    const c = ctx({ io: { log: vi.fn(), isTTY: true, ask } });
    const r = await setupDaemon(c);
    expect(r.action).toBe(INSTALLED);
    expect(c.resolveInstallCredentials).toHaveBeenCalledOnce();
    expect(c.installService).toHaveBeenCalledOnce();
  });
});

describe("credential validate-or-abort gate", () => {
  it("aborts installing nothing when credentials fail to resolve/validate", async () => {
    const c = ctx({
      flags: { daemonAutostart: true },
      resolveInstallCredentials: vi.fn(async () => ({ ok: false })),
    });
    const r = await setupDaemon(c);
    expect(r.action).toBe(FAILED);
    expect(c.installService).not.toHaveBeenCalled();
  });

  it("does not lean on credential-seed — it calls the validating resolver itself", async () => {
    const c = ctx({ flags: { daemonAutostart: true } });
    await setupDaemon(c);
    expect(c.resolveInstallCredentials).toHaveBeenCalledOnce();
  });
});

describe("idempotency (report_skip_repair)", () => {
  it("already-installed re-run skips WITHOUT re-validating creds or reinstalling", async () => {
    const c = ctx({
      flags: { daemonAutostart: true },
      detectSupervisor: vi.fn(() => ({ kind: "systemd", installed: true, active: true, unitPath: "/u" })),
    });
    const r = await setupDaemon(c);
    expect(r.action).toBe(SKIPPED);
    expect(r.detail).toMatch(/already configured/);
    expect(c.resolveInstallCredentials).not.toHaveBeenCalled();
    expect(c.installService).not.toHaveBeenCalled();
  });

  it("launchd already-installed also short-circuits", async () => {
    const c = ctx({
      flags: { daemonAutostart: true },
      autostartCapability: vi.fn(() => "launchd"),
      detectSupervisor: vi.fn(() => ({ kind: "launchd", installed: true, active: true, label: "com.chorus.daemon", plistPath: "/p.plist" })),
    });
    const r = await setupDaemon(c);
    expect(r.action).toBe(SKIPPED);
    expect(c.installService).not.toHaveBeenCalled();
  });
});

describe("systemd lingering (ensure_linger)", () => {
  const logText = (c) => c.io.log.mock.calls.flat().join("\n");

  it("fresh install forwards noLinger:false and logs the enabled note", async () => {
    const c = ctx({
      flags: { daemonAutostart: true },
      installService: vi.fn(() => ({ platform: "linux", installed: true, unitPath: "/u", unitText: "", steps: ["wrote /u", "loginctl enable-linger u"], linger: { result: "enabled", user: "u" } })),
    });
    const r = await setupDaemon(c);
    expect(r.action).toBe(INSTALLED);
    expect(c.installService.mock.calls[0][0].noLinger).toBe(false);
    expect(logText(c)).toMatch(/\[chorus agents add\] enabled systemd lingering for u/);
  });

  it("fresh install with --no-linger forwards noLinger:true", async () => {
    const c = ctx({ flags: { daemonAutostart: true, noLinger: true } });
    await setupDaemon(c);
    expect(c.installService.mock.calls[0][0].noLinger).toBe(true);
  });

  it("a linger failure keeps the outcome INSTALLED and logs the sudo fix", async () => {
    const c = ctx({
      flags: { daemonAutostart: true },
      installService: vi.fn(() => ({ platform: "linux", installed: true, unitPath: "/u", unitText: "", steps: ["wrote /u"], linger: { result: "failed", user: "u", error: "Access denied", fix: "sudo loginctl enable-linger u" } })),
    });
    const r = await setupDaemon(c);
    expect(r.action).toBe(INSTALLED);
    expect(logText(c)).toContain("sudo loginctl enable-linger u");
  });

  it("already-installed systemd: ensures lingering, stays SKIPPED, never reinstalls", async () => {
    const serviceIo = { platform: "linux" };
    const c = ctx({
      flags: { daemonAutostart: true },
      serviceIo,
      detectSupervisor: vi.fn(() => ({ kind: "systemd", installed: true, active: true, unitPath: "/u" })),
      ensureLinger: vi.fn(() => ({ result: "enabled", user: "u" })),
    });
    const r = await setupDaemon(c);
    expect(r.action).toBe(SKIPPED);
    expect(r.detail).toMatch(/already configured.*enabled lingering/);
    expect(c.ensureLinger).toHaveBeenCalledWith(serviceIo);
    expect(c.installService).not.toHaveBeenCalled();
    expect(logText(c)).toMatch(/enabled systemd lingering/);
  });

  it("already-installed systemd with lingering already on: plain SKIPPED detail", async () => {
    const c = ctx({
      flags: { daemonAutostart: true },
      detectSupervisor: vi.fn(() => ({ kind: "systemd", installed: true, active: true, unitPath: "/u" })),
    });
    const r = await setupDaemon(c);
    expect(r.action).toBe(SKIPPED);
    expect(r.detail).toBe("daemon already configured for auto-start (systemd) — left unchanged");
    expect(c.ensureLinger).toHaveBeenCalledOnce();
  });

  it("already-installed systemd where lingering fails: SKIPPED with a warning", async () => {
    const c = ctx({
      flags: { daemonAutostart: true },
      detectSupervisor: vi.fn(() => ({ kind: "systemd", installed: true, active: true, unitPath: "/u" })),
      ensureLinger: vi.fn(() => ({ result: "failed", user: "u", error: "Access denied", fix: "sudo loginctl enable-linger u" })),
    });
    const r = await setupDaemon(c);
    expect(r.action).toBe(SKIPPED);
    expect(r.detail).toMatch(/lingering NOT enabled/);
    expect(logText(c)).toContain("sudo loginctl enable-linger u");
  });

  it("already-installed systemd with --no-linger: no linger call", async () => {
    const c = ctx({
      flags: { daemonAutostart: true, noLinger: true },
      detectSupervisor: vi.fn(() => ({ kind: "systemd", installed: true, active: true, unitPath: "/u" })),
    });
    const r = await setupDaemon(c);
    expect(r.action).toBe(SKIPPED);
    expect(c.ensureLinger).not.toHaveBeenCalled();
  });

  it("already-installed launchd never ensures lingering", async () => {
    const c = ctx({
      flags: { daemonAutostart: true },
      autostartCapability: vi.fn(() => "launchd"),
      detectSupervisor: vi.fn(() => ({ kind: "launchd", installed: true, active: true, label: "com.chorus.daemon", plistPath: "/p.plist" })),
    });
    await setupDaemon(c);
    expect(c.ensureLinger).not.toHaveBeenCalled();
  });

  it("declined auto-start never touches lingering", async () => {
    const c = ctx({ flags: {} }); // non-interactive, no --daemon-autostart
    await setupDaemon(c);
    expect(c.ensureLinger).not.toHaveBeenCalled();
  });
});

describe("reuse init selection (no top-level cwds/agent writes, no backend re-prompt)", () => {
  it("with a selection, does NOT write the deprecated top-level cwds/agent (per-agent config is credential-seed's job) and never re-prompts the backend", async () => {
    // credential-seed (order 10) already wrote each selected agent into agents[] with
    // its OWN cwds + agentType (the authoritative per-agent config). daemon-setup must
    // NOT persist the flat top-level cwds/agent — doing so leaked a duplicate agent
    // config outside the array. Not calling resolveInstallAgent also means no re-prompt.
    const c = ctx({ selection: ["claude", "opencode"], flags: { daemonAutostart: true } });
    const r = await setupDaemon(c);
    expect(c.resolveInstallCwds).not.toHaveBeenCalled();
    expect(c.resolveInstallAgent).not.toHaveBeenCalled();
    expect(r.action).toBe(INSTALLED);
  });

  it("with NO selection, keeps the original single-agent preflight (top-level cwds + prompt-driven backend)", async () => {
    const c = ctx({ flags: { daemonAutostart: true } }); // no selection
    await setupDaemon(c);
    expect(c.resolveInstallCwds).toHaveBeenCalledOnce();
    expect(c.resolveInstallAgent).toHaveBeenCalledOnce();
    // The operator's raw flags are forwarded unchanged (no injected agent).
    expect(c.resolveInstallAgent.mock.calls[0][0]).not.toHaveProperty("agent");
  });
});

describe("capability-gate on will-be-woken (read from daemon.json agents[])", () => {
  it("no agent will be woken (all offline OR daemonWake:false) → SKIPS prompt + install, never validating creds", async () => {
    const ask = vi.fn(async () => "y");
    const c = ctx({
      io: { log: vi.fn(), isTTY: true, ask },
      selection: ["opencode", "kiro"],
      flags: { daemonAutostart: true },
      // credential-seed wrote: opencode → offline; kiro → daemonWake:false (opted out).
      readJson: () => ({ agents: [{ agentType: "offline" }, { agentType: "kiro", daemonWake: false }] }),
    });
    const r = await setupDaemon(c);
    expect(r.action).toBe(SKIPPED);
    expect(r.detail).toMatch(/no agent enabled for daemon waking/);
    // Never prompts, never probes the backend, never validates creds, never installs.
    expect(ask).not.toHaveBeenCalled();
    expect(c.resolveInstallAgent).not.toHaveBeenCalled();
    expect(c.resolveInstallCwds).not.toHaveBeenCalled();
    expect(c.resolveInstallCredentials).not.toHaveBeenCalled();
    expect(c.installService).not.toHaveBeenCalled();
  });

  it("at least one agent WILL be woken (wakeable + daemonWake not false) → proceeds to install", async () => {
    const c = ctx({
      selection: ["opencode", "kiro"],
      flags: { daemonAutostart: true },
      // kiro opted in (daemonWake:true) → the daemon will wake it → auto-start offered.
      readJson: () => ({ agents: [{ agentType: "offline" }, { agentType: "kiro", daemonWake: true }] }),
    });
    const r = await setupDaemon(c);
    expect(r.action).toBe(INSTALLED);
    // Still no top-level cwds/agent write (per-agent config is authoritative).
    expect(c.resolveInstallAgent).not.toHaveBeenCalled();
  });

  it("an agent with a wakeable backend and ABSENT daemonWake still counts as woken (back-compat)", async () => {
    const c = ctx({
      selection: ["kiro"],
      flags: { daemonAutostart: true },
      readJson: () => ({ agents: [{ agentType: "kiro" }] }), // no daemonWake field
    });
    const r = await setupDaemon(c);
    expect(r.action).toBe(INSTALLED);
  });
});

describe("install outcome", () => {
  it("surfaces a failed install as FAILED (non-zero)", async () => {
    const c = ctx({
      flags: { daemonAutostart: true },
      installService: vi.fn(() => ({ platform: "linux", installed: false, error: "systemctl enable --now failed: boom", steps: ["wrote /u"] })),
    });
    const r = await setupDaemon(c);
    expect(r.action).toBe(FAILED);
    expect(r.detail).toMatch(/systemctl enable --now failed: boom/);
  });

  it("never collects provider secrets — no AWS_/ANTHROPIC prompt or write path exists", async () => {
    // The step only ever calls resolveInstallCwds/Agent/Credentials; there is no
    // provider-secret collection. Guard against a regression that adds one.
    const ask = vi.fn(async () => "y");
    const c = ctx({ io: { log: vi.fn(), isTTY: true, ask } });
    await setupDaemon(c);
    const askedText = ask.mock.calls.flat().join(" ");
    expect(askedText).not.toMatch(/AWS|ANTHROPIC|BEDROCK|secret|token/i);
  });
});
