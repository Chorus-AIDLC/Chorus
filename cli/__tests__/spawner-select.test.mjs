// cli/__tests__/spawner-select.test.mjs
// Covers daemon-spawner-interface spec: the daemon selects which spawner backend
// to inject from the resolved agent type. claude-code → ClaudeSpawner (unchanged
// construction); codex → CodexSpawner; kiro → KiroSpawner. All satisfy the same
// wake(...) contract.
import { describe, it, expect } from "vitest";
import { selectSpawner } from "../spawner-select.mjs";
import { ClaudeSpawner } from "../claude-spawner.mjs";
import { CodexSpawner } from "../codex-spawner.mjs";
import { DshSpawner } from "../dsh-spawner.mjs";
import { KiroSpawner } from "../kiro-spawner.mjs";

const logger = { info() {}, warn() {}, error() {} };
const creds = { url: "https://example.test", apiKey: "cho_test" };

describe("selectSpawner", () => {
  it("returns a ClaudeSpawner for claude-code", () => {
    const s = selectSpawner("claude-code", { logger, permissionMode: "yolo", creds });
    expect(s).toBeInstanceOf(ClaudeSpawner);
    expect(s.creds).toEqual(creds);
  });

  it("returns a CodexSpawner for codex", () => {
    const s = selectSpawner("codex", { logger, permissionMode: "yolo", creds });
    expect(s).toBeInstanceOf(CodexSpawner);
  });

  it("returns a KiroSpawner for kiro", () => {
    const s = selectSpawner("kiro", { logger, permissionMode: "yolo", creds });
    expect(s).toBeInstanceOf(KiroSpawner);
  });

  it("returns a DshSpawner for dsh", () => {
    const s = selectSpawner("dsh", { logger, permissionMode: "yolo", creds });
    expect(s).toBeInstanceOf(DshSpawner);
    expect(s.creds).toEqual(creds);
  });

  it("threads permissionMode into the selected spawner", () => {
    expect(selectSpawner("claude-code", { logger, permissionMode: "chorus", creds }).permissionMode).toBe("chorus");
    expect(selectSpawner("codex", { logger, permissionMode: "yolo", creds }).permissionMode).toBe("yolo");
    expect(selectSpawner("kiro", { logger, permissionMode: "chorus", creds }).permissionMode).toBe("chorus");
  });

  it("threads creds into every backend spawner", () => {
    expect(selectSpawner("claude-code", { logger, creds }).creds).toEqual(creds);
    expect(selectSpawner("codex", { logger, creds }).creds).toEqual(creds);
    expect(selectSpawner("kiro", { logger, creds }).creds).toEqual(creds);
    expect(selectSpawner("dsh", { logger, creds }).creds).toEqual(creds);
  });

  it("defaults to claude-code when the agent type is unrecognized (no throw — selection is post-validation)", () => {
    // resolveAgentType already rejected unknowns before this point; selectSpawner
    // is total and falls back to the safe default rather than throwing.
    const s = selectSpawner("something-else", { logger, permissionMode: "yolo", creds });
    expect(s).toBeInstanceOf(ClaudeSpawner);
  });

  it("all backends expose a wake() method (shared contract)", () => {
    const c = selectSpawner("claude-code", { logger, permissionMode: "yolo", creds });
    const x = selectSpawner("codex", { logger, permissionMode: "yolo", creds });
    const k = selectSpawner("kiro", { logger, permissionMode: "yolo", creds });
    const d = selectSpawner("dsh", { logger, permissionMode: "yolo", creds });
    expect(typeof c.wake).toBe("function");
    expect(typeof x.wake).toBe("function");
    expect(typeof k.wake).toBe("function");
    expect(typeof d.wake).toBe("function");
  });
});
