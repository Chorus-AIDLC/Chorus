// cli/__tests__/init-integration.test.mjs
// End-to-end integration for `chorus init` (spec: chorus-init "Pluggable
// step-orchestration seam" + agent-plugin-install). Uses the REAL registry
// (detectAgents / orderedSteps / getAdapter) with injected step collaborators
// (ctxExtras) so no real server / agent CLI is touched. Exercises the full
// detect → select → credential-seed → plugin-install → summary path.
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../init.mjs";
import { detectAgents, orderedSteps, getAdapter, STEP_REGISTRY } from "../init/registry.mjs";
import { STEP_SCOPES, OUTCOME_ACTIONS } from "../init/contracts.mjs";

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
          promptFn: async () => "cho_pi", // pi's own key (kiro pre-filled from --api-key)
          // daemon-setup collaborators (hermetic): a wakeable agent is selected, but
          // no --daemon-autostart → the step writes config then SKIPS the install.
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
    // Flat top-level creds seeded once (from the first agent).
    expect(credWrites).toBe(1);
    expect(text).toContain("kiro: seeded");
    expect(text).toContain("pi: seeded");
    // plugin-install ran per selected agent: kiro installed its .kiro/ file
    // template (fetched + written into the temp KIRO_DIR); pi stays guided.
    expect(text).toContain("kiro: installed");
    expect(text).toContain("pi: unsupported");
    expect(existsSync(join(kiroDir, "agents", "chorus.json"))).toBe(true);
    // daemon-setup: a wakeable agent selected, no --daemon-autostart → skipped.
    expect(text).toContain("--daemon-autostart");
    // summary + next-step hint
    expect(text).toContain("Summary");
    expect(text).toContain("Next:");
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
