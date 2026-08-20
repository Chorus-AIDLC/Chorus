// cli/__tests__/init-integration.test.mjs
// End-to-end integration for `chorus init` (spec: chorus-init "Pluggable
// step-orchestration seam" + agent-plugin-install). Uses the REAL registry
// (detectAgents / orderedSteps / getAdapter) with injected step collaborators
// (ctxExtras) so no real server / agent CLI is touched. Exercises the full
// detect → select → credential-seed → plugin-install → summary path.
import { describe, it, expect } from "vitest";
import { runInit } from "../init.mjs";
import { detectAgents, orderedSteps, getAdapter, STEP_REGISTRY } from "../init/registry.mjs";
import { STEP_SCOPES, OUTCOME_ACTIONS } from "../init/contracts.mjs";

function capture() {
  const lines = [];
  return { log: (m) => lines.push(String(m)), isTTY: false, lines };
}

describe("chorus init — end-to-end (real registry, injected collaborators)", () => {
  it("runs credential-seed then plugin-install per agent, in order, with a summary", async () => {
    const io = capture();
    const identity = { uuid: "agent-1", name: "Agent One" };
    let credWrites = 0;

    // kiro + pi are both guided (deterministic UNSUPPORTED) → no real CLI call.
    // (dsh is no longer guided — it has a real installer now.)
    const code = await runInit(
      ["--agents", "kiro,pi", "--url", "https://c", "--api-key", "cho_k", "--yes"],
      {
        io,
        version: "9.9.9",
        detectAgents, // real
        orderedSteps, // real: [credential-seed(10), plugin-install(20)]
        getAdapter, // real
        ctxExtras: {
          validateCredentials: async () => identity,
          writeLogin: () => { credWrites += 1; },
        },
      },
    );

    expect(code).toBe(0);
    const text = io.lines.join("\n");
    // credential-seed ran once and wrote once
    expect(credWrites).toBe(1);
    expect(text).toContain("seeded credentials for Agent One");
    // plugin-install ran per selected agent (both guided → unsupported)
    expect(text).toContain("kiro: unsupported");
    expect(text).toContain("pi: unsupported");
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
    try {
      // Supply --url/--api-key so credential-seed is deterministic (SEEDED)
      // regardless of the machine's ~/.chorus/daemon.json — otherwise the exit
      // code depends on the environment (skipped when creds already resolve,
      // failed in a clean CI container where none do).
      const code = await runInit(["--agents", "kiro", "--url", "https://c", "--api-key", "cho_k", "--yes"], {
        io,
        detectAgents,
        orderedSteps, // real, now includes the fixture
        getAdapter,
        ctxExtras: {
          validateCredentials: async () => ({ uuid: "a", name: "A" }),
          writeLogin: () => {},
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
