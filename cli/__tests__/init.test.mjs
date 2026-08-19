// cli/__tests__/init.test.mjs
// Covers the runInit orchestrator skeleton (detect → select → ordered steps →
// summary) and real router dispatch of `chorus init` via chorus.mjs.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runInit } from "../init.mjs";
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
    expect(io.lines.join("\n")).toContain("Chorus init v1.2.3");
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

describe("chorus init — router dispatch (real entry)", () => {
  it("`node chorus.mjs init --help` prints usage and exits 0 without starting the server", () => {
    const out = execFileSync(process.execPath, ["chorus.mjs", "init", "--help"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(out).toContain("Chorus init v");
    expect(out).toContain("USAGE");
    expect(out).not.toContain("Starting embedded PostgreSQL");
  });
});
