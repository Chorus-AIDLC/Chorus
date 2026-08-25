// cli/__tests__/init.test.mjs
// Covers the runInit orchestrator skeleton (detect → select → ordered steps →
// summary) and real router dispatch of `chorus init` via chorus.mjs.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runInit, profileExportHint } from "../init.mjs";
import { STEP_SCOPES, OUTCOME_ACTIONS } from "../init/contracts.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function capture() {
  const lines = [];
  return { log: (m) => lines.push(String(m)), isTTY: false, lines };
}

const DETECTIONS = [
  { id: "claude", displayName: "Claude Code", binaryOnPath: true, configDirPresent: true, detected: true },
  { id: "codex", displayName: "Codex", binaryOnPath: false, configDirPresent: true, detected: true },
];

describe("runInit — help", () => {
  it("prints help and exits 0 without detecting or running steps", async () => {
    const io = capture();
    let detectCalled = false;
    let stepsCalled = false;
    const code = await runInit(["--help"], {
      io,
      version: "1.2.3",
      detectAgents: () => {
        detectCalled = true;
        return [];
      },
      orderedSteps: () => {
        stepsCalled = true;
        return [];
      },
    });
    expect(code).toBe(0);
    expect(io.lines.join("\n")).toContain("Chorus agents add v1.2.3");
    expect(detectCalled).toBe(false);
    expect(stepsCalled).toBe(false);
  });
});

describe("runInit — orchestration", () => {
  it("runs `once` steps once and `per-agent` steps per selected agent, in order", async () => {
    const io = capture();
    const calls = [];
    const steps = [
      {
        id: "seed",
        order: 10,
        scope: STEP_SCOPES.ONCE,
        run: (ctx) => {
          calls.push(`seed(once):${ctx.selection.join("+")}`);
          return { stepId: "seed", action: OUTCOME_ACTIONS.SEEDED, detail: "creds" };
        },
      },
      {
        id: "plugin",
        order: 20,
        scope: STEP_SCOPES.PER_AGENT,
        run: (ctx) => {
          calls.push(`plugin(${ctx.agentId})`);
          expect(ctx.adapter).toEqual({ id: ctx.agentId });
          return { stepId: "plugin", agentId: ctx.agentId, action: OUTCOME_ACTIONS.INSTALLED, detail: "ok" };
        },
      },
    ];
    const code = await runInit([], {
      io: { ...io, isTTY: false },
      detectAgents: () => DETECTIONS,
      resolveSelection: async () => ({ selectedIds: ["claude", "codex"] }),
      orderedSteps: () => steps,
      getAdapter: (id) => ({ id }),
    });
    expect(code).toBe(0);
    expect(calls).toEqual(["seed(once):claude+codex", "plugin(claude)", "plugin(codex)"]);
    expect(io.lines.join("\n")).toContain("Summary");
  });

  it("returns 1 when selection resolution errors", async () => {
    const io = capture();
    const code = await runInit(["--agents", "bogus"], {
      io,
      detectAgents: () => DETECTIONS,
      resolveSelection: async () => ({ error: "Unknown agent id(s): bogus." }),
      orderedSteps: () => [],
    });
    expect(code).toBe(1);
    expect(io.lines.join("\n")).toContain("bogus");
  });

  it("returns 1 when a step reports a failed outcome", async () => {
    const io = capture();
    const code = await runInit([], {
      io,
      detectAgents: () => DETECTIONS,
      resolveSelection: async () => ({ selectedIds: ["claude"] }),
      orderedSteps: () => [
        {
          id: "plugin",
          order: 1,
          scope: STEP_SCOPES.PER_AGENT,
          run: () => ({ stepId: "plugin", agentId: "claude", action: OUTCOME_ACTIONS.FAILED, detail: "boom" }),
        },
      ],
      getAdapter: (id) => ({ id }),
    });
    expect(code).toBe(1);
  });

  it("a step that throws becomes a visible failed outcome, not a crash", async () => {
    const io = capture();
    const code = await runInit([], {
      io,
      detectAgents: () => DETECTIONS,
      resolveSelection: async () => ({ selectedIds: ["claude"] }),
      orderedSteps: () => [
        { id: "boom", order: 1, scope: STEP_SCOPES.ONCE, run: () => { throw new Error("kaboom"); } },
      ],
    });
    expect(code).toBe(1);
    expect(io.lines.join("\n")).toContain("kaboom");
  });
});

describe("profileExportHint", () => {
  it("prints one export line per agent identity (deduped), with the name as a comment", () => {
    const io = capture();
    profileExportHint(
      [
        { stepId: "credential-seed", action: OUTCOME_ACTIONS.SEEDED, detail: "…", agentUuid: "u-1", agentName: "Admin Claude" },
        { stepId: "plugin-install", agentId: "claude", action: OUTCOME_ACTIONS.INSTALLED, detail: "…" }, // no identity → ignored
        { stepId: "credential-seed", action: OUTCOME_ACTIONS.SKIPPED, detail: "…", agentUuid: "u-2", agentName: "Codex" },
        { stepId: "credential-seed", action: OUTCOME_ACTIONS.SEEDED, detail: "…", agentUuid: "u-1", agentName: "Admin Claude" }, // dup uuid → deduped
      ],
      io,
    );
    const text = io.lines.join("\n");
    expect(text).toContain('export CHORUS_AGENT_PROFILE="u-1"');
    expect(text).toContain("# Admin Claude");
    expect(text).toContain('export CHORUS_AGENT_PROFILE="u-2"');
    expect(text).toContain("# Codex");
    // deduped: exactly two export lines
    expect(text.match(/export CHORUS_AGENT_PROFILE=/g)).toHaveLength(2);
    // accurate framing: resolves the key from daemon.json, and daemon-woken auto
    expect(text).toContain("~/.chorus/daemon.json");
    expect(text).toContain("Daemon-woken sessions set CHORUS_AGENT_PROFILE automatically");
  });

  it("prints nothing when no outcome carries an identity", () => {
    const io = capture();
    profileExportHint(
      [{ stepId: "plugin-install", agentId: "claude", action: OUTCOME_ACTIONS.INSTALLED, detail: "…" }],
      io,
    );
    expect(io.lines.join("\n")).toBe("");
  });

  it("omits a dsh agent whose profile is already in $DSH_HOME/.env (profileInEnv) but keeps the others", () => {
    const io = capture();
    profileExportHint(
      [
        { stepId: "credential-seed", action: OUTCOME_ACTIONS.SEEDED, detail: "…", agentUuid: "u-claude", agentName: "Admin Claude" },
        { stepId: "credential-seed", action: OUTCOME_ACTIONS.SEEDED, detail: "…", agentUuid: "u-dsh", agentName: "DSH Agent", profileInEnv: true },
      ],
      io,
    );
    const text = io.lines.join("\n");
    expect(text).toContain('export CHORUS_AGENT_PROFILE="u-claude"'); // non-dsh still hinted
    expect(text).not.toContain("u-dsh"); // dsh loads it from $DSH_HOME/.env — no manual export
    expect(text.match(/export CHORUS_AGENT_PROFILE=/g)).toHaveLength(1);
  });

  it("prints nothing when the only agent has its profile in $DSH_HOME/.env", () => {
    const io = capture();
    profileExportHint(
      [{ stepId: "credential-seed", action: OUTCOME_ACTIONS.SEEDED, detail: "…", agentUuid: "u-dsh", agentName: "DSH Agent", profileInEnv: true }],
      io,
    );
    expect(io.lines.join("\n")).toBe("");
  });
});

describe("chorus agents add — router dispatch (real entry)", () => {
  it("`node chorus.mjs agents add --help` prints the init help and exits 0 without starting the server", () => {
    const out = execFileSync(process.execPath, ["chorus.mjs", "agents", "add", "--help"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(out).toContain("Chorus agents add v");
    expect(out).toContain("USAGE");
    expect(out).not.toContain("Starting embedded PostgreSQL");
  });
});
