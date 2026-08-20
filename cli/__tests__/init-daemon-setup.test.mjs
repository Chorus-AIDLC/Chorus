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
    resolveServicePaths: vi.fn(() => ({ nodePath: "/node", scriptPath: "/x/chorus.mjs", path: "/bin" })),
    resolveInstallCredentials: vi.fn(async () => ({ ok: true, creds: { url: "u", apiKey: "cho_k" }, identity: { uuid: "a", name: "Bot" } })),
    resolveInstallCwds: vi.fn(async () => ({ cwds: ["/a"] })),
    resolveInstallAgent: vi.fn(async () => ({ ok: true, agent: "claude-code", cliFound: true })),
    processCwd: "/proj",
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

describe("reuse init selection (no second 'which agent backend?' prompt)", () => {
  it("derives the daemon default backend from the first WAKEABLE selected agent and passes it to resolveInstallAgent", async () => {
    // Selecting claude + opencode: claude→claude-code (wakeable) is the derived
    // default; opencode→offline is ignored for the backend. Passing an explicit
    // agent to resolveInstallAgent is what suppresses its interactive menu.
    const c = ctx({ selection: ["claude", "opencode"], flags: { daemonAutostart: true } });
    const r = await setupDaemon(c);
    expect(c.resolveInstallAgent).toHaveBeenCalledOnce();
    expect(c.resolveInstallAgent.mock.calls[0][0]).toMatchObject({ agent: "claude-code" });
    expect(r.action).toBe(INSTALLED);
  });

  it("codex-only selection derives 'codex' as the default backend", async () => {
    const c = ctx({ selection: ["codex"], flags: { daemonAutostart: true } });
    await setupDaemon(c);
    expect(c.resolveInstallAgent.mock.calls[0][0]).toMatchObject({ agent: "codex" });
  });

  it("an explicit --agent still wins over the selection-derived default (and still suppresses the menu)", async () => {
    const c = ctx({ selection: ["claude"], flags: { agent: "kiro", daemonAutostart: true } });
    await setupDaemon(c);
    expect(c.resolveInstallAgent.mock.calls[0][0]).toMatchObject({ agent: "kiro" });
  });

  it("with NO selection, keeps the original prompt-driven resolveInstallAgent call", async () => {
    const c = ctx({ flags: { daemonAutostart: true } }); // no selection
    await setupDaemon(c);
    expect(c.resolveInstallAgent).toHaveBeenCalledOnce();
    // The operator's raw flags are forwarded unchanged (no injected agent).
    expect(c.resolveInstallAgent.mock.calls[0][0]).not.toHaveProperty("agent");
  });
});

describe("capability-gate on wakeability (all-offline selection)", () => {
  it("all-offline selection SKIPS the prompt + service install (agents[] already persisted), never resolving the backend or creds", async () => {
    const ask = vi.fn(async () => "y");
    const c = ctx({
      io: { log: vi.fn(), isTTY: true, ask },
      selection: ["opencode", "pi"], // both → offline
      flags: { daemonAutostart: true },
    });
    const r = await setupDaemon(c);
    expect(r.action).toBe(SKIPPED);
    expect(r.detail).toMatch(/no daemon-wakeable agent selected/);
    // Never prompts, never probes the backend, never validates creds, never installs.
    expect(ask).not.toHaveBeenCalled();
    expect(c.resolveInstallAgent).not.toHaveBeenCalled();
    expect(c.resolveInstallCredentials).not.toHaveBeenCalled();
    expect(c.installService).not.toHaveBeenCalled();
    // But the served-cwd preflight still runs (config persistence is not gated).
    expect(c.resolveInstallCwds).toHaveBeenCalledOnce();
  });

  it("a mixed selection with at least one wakeable agent does NOT hit the all-offline skip", async () => {
    const c = ctx({ selection: ["opencode", "codex"], flags: { daemonAutostart: true } });
    const r = await setupDaemon(c);
    expect(r.action).toBe(INSTALLED);
    expect(c.resolveInstallAgent.mock.calls[0][0]).toMatchObject({ agent: "codex" });
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
