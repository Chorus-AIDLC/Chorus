// cli/__tests__/init-integration.test.mjs
// End-to-end integration for `chorus init` (spec: chorus-init "Pluggable
// step-orchestration seam" + agent-plugin-install). Uses the REAL registry
// (detectAgents / orderedSteps / getAdapter) with injected step collaborators
// (ctxExtras) so no real server / agent CLI is touched. Exercises the full
// detect → select → credential-seed → plugin-install → summary path.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../init.mjs";
import { detectAgents, orderedSteps, getAdapter, STEP_REGISTRY } from "../init/registry.mjs";
import { STEP_SCOPES, OUTCOME_ACTIONS } from "../init/contracts.mjs";
import { pluginInstallStep } from "../init/steps/plugin-install.mjs";

function capture() {
  const lines = [];
  return { log: (m) => lines.push(String(m)), isTTY: false, lines };
}

// A faked fetch serving the kiro .kiro/ template assets from the connected
// instance, so the real registry's installKiro runs hermetically (no network).
function fakeKiroFetch() {
  const mcp = JSON.stringify({
    mcpServers: { chorus: { type: "http", url: "${CHORUS_URL}/api/mcp", headers: { Authorization: "Bearer ${env:CHORUS_API_KEY}" } } },
  });
  const manifest = "skill chorus-idea\nreviewer chorus-task-reviewer\nhook on-stop.sh\n";
  const routes = {
    "/kiro-plugin/manifest.txt": manifest,
    "/kiro-plugin/.kiro/settings/mcp.json": mcp,
    "/kiro-plugin/.kiro/steering/chorus.md": "# steering",
    "/kiro-plugin/.kiro/agents/chorus.md": "# main",
    "/kiro-plugin/.kiro/agents/chorus.json": '{"hooks":{"stop":[{"command":"__CHORUS_BIN__/on-stop.sh"}]}}',
    "/kiro-plugin/.kiro/agents/chorus-task-reviewer.json": '{"name":"chorus-task-reviewer"}',
    "/kiro-plugin/.kiro/skills/chorus-idea/SKILL.md": "# idea",
    "/kiro-plugin/bin/on-stop.sh": "#!/usr/bin/env bash\n",
  };
  return async (url) => {
    for (const suffix of Object.keys(routes)) {
      if (url.endsWith(suffix)) return { ok: true, status: 200, text: async () => routes[suffix] };
    }
    return { ok: false, status: 404, text: async () => "no route" };
  };
}

describe("chorus init — end-to-end (real registry, injected collaborators)", () => {
  it("detects an installed live dsh profile before interactive profile resolution and asks once to refresh", async () => {
    const dshHome = mkdtempSync(join(tmpdir(), "refresh-dsh-"));
    const profileDir = join(dshHome, "profiles", "work");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, "package.json"),
      JSON.stringify({ dependencies: { "@chorus-aidlc/chorus-dsh": "^0.16.4" } }),
    );
    const prompts = [];
    const calls = [];
    const lines = [];
    const io = {
      log: (m) => lines.push(String(m)),
      isTTY: true,
      ask: async (q) => {
        prompts.push(String(q));
        return String(q).includes("Update installed") ? "y" : "work";
      },
    };
    const code = await runInit(["--agents", "dsh"], {
      io,
      env: { HOME: "/unused", DSH_HOME: dshHome },
      detectAgents,
      orderedSteps: () => [pluginInstallStep],
      getAdapter,
      backup: () => null,
      ctxExtras: {
        binaryOnPath: () => true,
        run: (cmd, args) => {
          calls.push([cmd, args]);
          return { ok: true, stdout: "" };
        },
      },
    });

    expect(code).toBe(0);
    expect(prompts.filter((q) => q.includes("Update installed"))).toHaveLength(1);
    expect(prompts.filter((q) => q.includes("dsh profile"))).toHaveLength(1);
    expect(prompts[0]).toContain("Update installed");
    expect(prompts[1]).toContain("dsh profile");
    expect(calls).toEqual([
      ["dsh", ["plugin", "--profile", "work", "add", "@chorus-aidlc/chorus-dsh", "-w"]],
    ]);
    expect(lines.join("\n")).toContain("dsh: repaired");
  });

  it("continues accepted installed-plugin refreshes after one harness fails and exits non-zero", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "refresh-codex-"));
    const opencodeDir = mkdtempSync(join(tmpdir(), "refresh-opencode-"));
    writeFileSync(
      join(codexHome, "config.toml"),
      '[marketplaces.chorus-plugins]\nsource = "x"\n[plugins."chorus@chorus-plugins"]\nenabled = true\n',
    );
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(join(opencodeDir, "opencode.json"), JSON.stringify({ plugin: ["opencode-chorus@0.16.0"] }));
    const calls = [];
    const io = capture();
    const code = await runInit(["--agents", "codex,opencode", "--yes"], {
      io,
      env: { HOME: "/unused", CODEX_HOME: codexHome, OPENCODE_CONFIG_DIR: opencodeDir },
      detectAgents,
      orderedSteps: () => [pluginInstallStep],
      getAdapter,
      backup: () => null,
      ctxExtras: {
        run: (cmd, args) => {
          calls.push([cmd, args]);
          if (cmd === "codex" && args.includes("upgrade")) {
            return { ok: false, stderr: "simulated marketplace refresh failure" };
          }
          return { ok: true, stdout: "" };
        },
        writeCodexMcpServer: () => {},
        resolveCredentials: () => ({ url: undefined }),
      },
    });
    const text = io.lines.join("\n");
    expect(code).toBe(1);
    expect(text).toContain("codex: failed");
    expect(text).toContain("opencode: repaired");
    expect(calls).toContainEqual([
      "opencode",
      ["plugin", "opencode-chorus", "-g", "--force"],
    ]);
  });

  it("captures a key per selected agent then runs plugin-install per agent, in order, with a summary", async () => {
    // A TTY run so the SECOND agent's key can be prompted (the first pre-fills from
    // --api-key). `--yes` keeps daemon-setup non-interactive. All daemon-setup +
    // credential collaborators are faked so no real ~/.chorus/daemon.json, systemctl,
    // or agent CLI is touched.
    const lines = [];
    const io = { log: (m) => lines.push(String(m)), isTTY: true, lines };
    let credWrites = 0;
    const appended = [];
    // kiro installs a real file-template fetched from the instance — a faked fetch
    // + a temp KIRO_DIR keep it hermetic (no network, no real ~/.kiro touch).
    const kiroDir = join(mkdtempSync(join(tmpdir(), "init-int-")), ".kiro");

    // kiro (→ kiro, wakeable) installs its .kiro/ file template; pi (→ offline)
    // is guided (deterministic UNSUPPORTED) for plugin-install → no real CLI call.
    const code = await runInit(
      ["--agents", "kiro,pi", "--url", "https://c", "--api-key", "cho_kiro", "--yes"],
      {
        io,
        version: "9.9.9",
        env: { ...process.env, KIRO_DIR: kiroDir },
        detectAgents, // real
        orderedSteps, // real: [credential-seed(10), plugin-install(20), daemon-setup(30)]
        getAdapter, // real
        ctxExtras: {
          validateCredentials: async ({ apiKey }) => ({ uuid: `u-${apiKey}`, name: `Agent ${apiKey}` }),
          appendAgent: (obj) => {
            appended.push(obj);
            return { ok: true, path: "/x/daemon.json", agents: appended, index: appended.length - 1 };
          },
          writeLogin: () => { credWrites += 1; },
          fetch: fakeKiroFetch(), // kiro's file-template download (hermetic)
          // pi's own key; "n" to the per-agent daemon-waking prompt (kiro NOT opted in).
          promptFn: async (q) => (String(q).includes("daemon waking") ? "n" : "cho_pi"),
          // daemon-setup reads the agents[] credential-seed just wrote (the fake append
          // accumulates into `appended`) to decide if anything will be woken.
          readJson: () => ({ agents: appended }),
          resolveInstallCwds: async () => ({ cwds: ["/a"] }),
          resolveInstallAgent: async () => ({ ok: true, agent: "kiro", cliFound: false }),
          autostartCapability: () => "systemd",
          detectSupervisor: () => ({ kind: "none" }),
        },
      },
    );

    expect(code).toBe(0);
    const text = io.lines.join("\n");
    // credential-seed captured a DISTINCT key per agent, each tagged with its mapped
    // agentType (kiro is wakeable → "kiro"; pi is not → "offline").
    expect(appended.map((a) => [a.apiKey, a.agentType])).toEqual([
      ["cho_kiro", "kiro"],
      ["cho_pi", "offline"],
    ]);
    // daemon-wake DEFAULTS OFF: the wakeable kiro was not opted in → daemonWake:false;
    // the offline pi gets no daemonWake field.
    expect(appended[0].daemonWake).toBe(false);
    expect(appended[1]).not.toHaveProperty("daemonWake");
    // Flat top-level creds are DEPRECATED — credential-seed never writes them.
    expect(credWrites).toBe(0);
    expect(text).toContain("kiro: seeded");
    expect(text).toContain("pi: seeded");
    // Completion prints a CHORUS_AGENT_PROFILE export hint per configured agent
    // (faked identities u-cho_kiro / u-cho_pi), so an interactive shell can act as
    // one without exporting its API key.
    expect(text).toContain('export CHORUS_AGENT_PROFILE="u-cho_kiro"');
    expect(text).toContain('export CHORUS_AGENT_PROFILE="u-cho_pi"');
    // plugin-install ran per selected agent: kiro installed its .kiro/ file
    // template (fetched + written into the temp KIRO_DIR); pi stays guided.
    expect(text).toContain("kiro: installed");
    expect(text).toContain("pi: unsupported");
    expect(existsSync(join(kiroDir, "agents", "chorus.json"))).toBe(true);
    // daemon-setup: nothing will be woken (kiro not opted in, pi offline) → skip.
    expect(text).toContain("no agent enabled for daemon waking");
    // summary + next-step hint
    expect(text).toContain("Summary");
    expect(text).toContain("Next:");
  });

  it("broadened set (claude,dsh,openclaw,kiro,pi) — install outcomes, agentType mapping, failure isolation, no daemon re-prompt", async () => {
    // Drives the FULL broadened selection with claude INCLUDED so the
    // claude→claude-code agentType rename is exercised (not just same-name
    // backends). openclaw's plugin install is forced to FAIL (its --version passes
    // the host-floor, its install command does not) to prove per-agent isolation:
    // kiro (processed AFTER it) and pi still run. All CLIs/fetch/prompts are faked.
    const lines = [];
    const io = { log: (m) => lines.push(String(m)), isTTY: true, ask: async () => "", lines };
    const kiroDir = join(mkdtempSync(join(tmpdir(), "init-int-")), ".kiro");
    const dshHome = mkdtempSync(join(tmpdir(), "init-dsh-"));
    const openclawDir = mkdtempSync(join(tmpdir(), "init-ocw-"));
    // claude is in the selection, so the credential-seed step writes the user-global
    // Claude Code settings.json env. Point CLAUDE_CONFIG_DIR at a temp dir so this test
    // NEVER touches the developer's real ~/.claude/settings.json.
    const claudeCfgDir = mkdtempSync(join(tmpdir(), "init-cc-"));

    const appended = [];
    let keyN = 0;
    let agentPassedToDaemon; // captures the backend daemon-setup derived (no re-prompt)
    let daemonResolveAgentCalls = 0;

    // One shared command runner for every installer. openclaw's INSTALL fails
    // (version probe passes); everything else succeeds.
    const run = (cmd, args = []) => {
      if (cmd === "openclaw" && args[0] === "--version") return { ok: true, stdout: "openclaw 2026.9.9" };
      if (cmd === "openclaw" && args[0] === "plugins" && args[1] === "install") {
        return { ok: false, stderr: "simulated openclaw install failure" };
      }
      return { ok: true, stdout: "" };
    };

    const code = await runInit(
      ["--agents", "claude,dsh,openclaw,kiro,pi", "--daemon-wake-all", "--url", "https://c", "--api-key", "cho_claude", "--yes"],
      {
        io,
        version: "9.9.9",
        env: {
          ...process.env,
          KIRO_DIR: kiroDir,
          DSH_HOME: dshHome,
          CHORUS_DSH_PROFILE: "default",
          OPENCLAW_CONFIG_DIR: openclawDir,
          CLAUDE_CONFIG_DIR: claudeCfgDir, // isolate the real ~/.claude/settings.json write
        },
        detectAgents, // real
        orderedSteps, // real
        getAdapter, // real
        backup: () => null,
        ctxExtras: {
          // credential-seed: distinct key per agent (claude pre-fills from --api-key).
          validateCredentials: async ({ apiKey }) => ({ uuid: `u-${apiKey}`, name: `A-${apiKey}` }),
          appendAgent: (obj) => {
            appended.push(obj);
            return { ok: true, path: "/x/daemon.json", agents: appended, index: appended.length - 1 };
          },
          writeLogin: () => {},
          promptFn: async () => `cho_${(keyN += 1)}`,
          // plugin-install collaborators (hermetic): shared runner + kiro fetch + a
          // pnpm-present probe so dsh installs without a real pnpm on PATH.
          run,
          fetch: fakeKiroFetch(),
          binaryOnPath: () => true,
          // daemon-setup reads the agents[] credential-seed wrote (in-memory fake).
          readJson: () => ({ agents: appended }),
          // daemon-setup collaborators (hermetic): a wakeable agent IS selected, so
          // resolveInstallAgent must receive the DERIVED backend (claude-code) — proving
          // it does NOT re-render the "which backend?" menu the operator already answered.
          resolveInstallCwds: async () => ({ cwds: ["/a"] }),
          resolveInstallAgent: async (flags) => {
            daemonResolveAgentCalls += 1;
            agentPassedToDaemon = flags.agent;
            return { ok: true, agent: flags.agent, cliFound: false };
          },
          autostartCapability: () => "systemd",
          detectSupervisor: () => ({ kind: "none" }),
        },
      },
    );

    const text = io.lines.join("\n");

    // Exit 1: openclaw's plugin install FAILED (the only FAILED outcome; unsupported
    // pi is not a failure).
    expect(code).toBe(1);

    // agentType written per agent — the load-bearing mapping, incl. claude→claude-code
    // (explicit rename) and opencode/openclaw/pi/dsh→offline (kiro stays wakeable).
    expect(appended.map((a) => a.agentType)).toEqual([
      "claude-code", // claude — the rename actually exercised
      "offline", // dsh (de-advertised)
      "offline", // openclaw
      "kiro", // kiro (wakeable)
      "offline", // pi
    ]);
    expect(appended).toHaveLength(5);
    // --daemon-wake-all opted the wakeable agents in (daemonWake:true); offline agents
    // get no daemonWake field.
    expect(appended[0].daemonWake).toBe(true); // claude
    expect(appended[3].daemonWake).toBe(true); // kiro
    expect(appended[1]).not.toHaveProperty("daemonWake"); // dsh → offline
    expect(appended[4]).not.toHaveProperty("daemonWake"); // pi → offline

    // Per-agent install outcomes, and per-agent failure isolation: openclaw FAILED,
    // yet dsh (before it) AND kiro/pi (after it) all produced their own outcome.
    expect(text).toMatch(/claude: (installed|repaired|skipped)/); // clean HOME → installed
    expect(text).toContain("dsh: installed");
    expect(text).toContain("openclaw: failed");
    expect(text).toContain("kiro: installed");
    expect(text).toContain("pi: unsupported");

    // supported flips: real installers (dsh/openclaw/kiro) true; guided pi false.
    const supportedOf = (id) => getAdapter(id).readInstallState({ env: {}, home: "/nonexistent-xyz" }).supported;
    expect(supportedOf("dsh")).toBe(true);
    expect(supportedOf("openclaw")).toBe(true);
    expect(supportedOf("kiro")).toBe(true);
    expect(supportedOf("pi")).toBe(false);

    // daemon-setup did NOT re-prompt the backend AND did NOT write the deprecated
    // top-level cwds/agent: with an init selection, per-agent cwds + agentType are
    // already in agents[] (credential-seed), so daemon-setup never calls
    // resolveInstallAgent at all (which is what suppresses the menu).
    expect(daemonResolveAgentCalls).toBe(0);
    expect(agentPassedToDaemon).toBeUndefined();
    expect(text).toContain("--daemon-autostart");
  });

  it("all-offline selection (opencode,pi) skips the daemon auto-start prompt", async () => {
    // No wakeable agent selected → daemon-setup persists the agents[] entries but
    // SKIPS both the backend resolve/menu and the auto-start prompt (even on a TTY,
    // no --yes). opencode installs (offline classification is orthogonal to whether
    // its plugin installs); pi is guided.
    const lines = [];
    let askedAutostart = false;
    const io = {
      log: (m) => lines.push(String(m)),
      isTTY: true,
      ask: async (q) => {
        if (/auto-start/i.test(String(q))) askedAutostart = true;
        return "";
      },
      lines,
    };
    const opencodeDir = mkdtempSync(join(tmpdir(), "init-oc-"));
    const appended = [];
    let daemonResolveAgentCalls = 0;

    const code = await runInit(
      ["--agents", "opencode,pi", "--url", "https://c", "--api-key", "cho_oc"],
      {
        io,
        version: "9.9.9",
        env: { ...process.env, OPENCODE_CONFIG_DIR: opencodeDir },
        detectAgents,
        orderedSteps,
        getAdapter,
        backup: () => null,
        ctxExtras: {
          validateCredentials: async ({ apiKey }) => ({ uuid: `u-${apiKey}`, name: `A-${apiKey}` }),
          appendAgent: (obj) => {
            appended.push(obj);
            return { ok: true, path: "/x/daemon.json", agents: appended, index: appended.length - 1 };
          },
          writeLogin: () => {},
          promptFn: async () => "cho_pi",
          run: () => ({ ok: true, stdout: "" }),
          readJson: () => ({ agents: appended }),
          resolveInstallCwds: async () => ({ cwds: ["/a"] }),
          resolveInstallAgent: async (flags) => {
            daemonResolveAgentCalls += 1;
            return { ok: true, agent: flags.agent, cliFound: false };
          },
          autostartCapability: () => "systemd",
          detectSupervisor: () => ({ kind: "none" }),
        },
      },
    );

    const text = io.lines.join("\n");
    // opencode installed + pi unsupported → no FAILED outcome → exit 0.
    expect(code).toBe(0);
    // Both agents parked as offline for the `chorus mcp` proxy (no daemonWake field).
    expect(appended.map((a) => a.agentType)).toEqual(["offline", "offline"]);
    expect(appended.every((a) => !("daemonWake" in a))).toBe(true);
    expect(text).toContain("opencode: installed");
    expect(text).toContain("pi: unsupported");
    // The auto-start gate: nothing will be woken → no backend resolve, no prompt.
    expect(text).toContain("no agent enabled for daemon waking");
    expect(daemonResolveAgentCalls).toBe(0);
    expect(askedAutostart).toBe(false);
  });

  it("credential-seed runs before plugin-install (declared order honored)", () => {
    const ordered = orderedSteps();
    const ids = ordered.map((s) => s.id);
    expect(ids.indexOf("credential-seed")).toBeLessThan(ids.indexOf("plugin-install"));
    expect(ordered.find((s) => s.id === "credential-seed").scope).toBe(STEP_SCOPES.ONCE);
    expect(ordered.find((s) => s.id === "plugin-install").scope).toBe(STEP_SCOPES.PER_AGENT);
  });
});

describe("chorus init — step-registry is extensible", () => {
  it("an extra step registered into the registry participates with no core change", async () => {
    const io = capture();
    let fixtureRan = 0;
    const fixtureStep = {
      id: "fixture-sibling",
      order: 30, // after the built-ins
      scope: STEP_SCOPES.ONCE,
      run: () => {
        fixtureRan += 1;
        return { stepId: "fixture-sibling", action: OUTCOME_ACTIONS.SEEDED, detail: "sibling ran" };
      },
    };
    // Simulate a sibling idea pushing its step — no edit to runInit's core.
    STEP_REGISTRY.push(fixtureStep);
    // kiro installs a real .kiro/ file template — a faked fetch + a temp KIRO_DIR
    // keep it hermetic (no network, no real ~/.kiro touch) in a clean CI HOME.
    const kiroDir = join(mkdtempSync(join(tmpdir(), "init-int-")), ".kiro");
    try {
      // Supply --url/--api-key so credential-seed is deterministic (SEEDED)
      // regardless of the machine's ~/.chorus/daemon.json — otherwise the exit
      // code depends on the environment (skipped when creds already resolve,
      // failed in a clean CI container where none do).
      const code = await runInit(["--agents", "kiro", "--url", "https://c", "--api-key", "cho_k", "--yes"], {
        io,
        detectAgents,
        env: { ...process.env, KIRO_DIR: kiroDir },
        orderedSteps, // real, now includes the fixture
        getAdapter,
        ctxExtras: {
          validateCredentials: async () => ({ uuid: "a", name: "A" }),
          // Fake the agents[] append + flat write so no real ~/.chorus/daemon.json
          // is touched (credential-seed now appends per agent via appendAgentConfig).
          appendAgent: () => ({ ok: true, path: "/x/daemon.json", agents: [{}], index: 0 }),
          writeLogin: () => {},
          fetch: fakeKiroFetch(), // kiro's file-template download (hermetic)
        },
      });
      expect(code).toBe(0);
      expect(fixtureRan).toBe(1);
      expect(io.lines.join("\n")).toContain("sibling ran");
    } finally {
      // Restore the registry so other tests see the canonical two steps.
      const i = STEP_REGISTRY.indexOf(fixtureStep);
      if (i >= 0) STEP_REGISTRY.splice(i, 1);
    }
  });
});
