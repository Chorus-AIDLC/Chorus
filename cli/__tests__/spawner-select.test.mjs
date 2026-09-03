// cli/__tests__/spawner-select.test.mjs
// Covers daemon-spawner-interface spec: the daemon selects which spawner backend
// to inject from the resolved agent type. claude-code → ClaudeSpawner (unchanged
// construction); codex → CodexSpawner; kiro → KiroSpawner. All satisfy the same
// wake(...) contract.
import { describe, it, expect, vi } from "vitest";
import { selectSpawner, OfflineSpawner } from "../spawner-select.mjs";
import { ClaudeSpawner } from "../claude-spawner.mjs";
import { CodexSpawner } from "../codex-spawner.mjs";
import { DshSpawner } from "../dsh-spawner.mjs";
import { KiroSpawner } from "../kiro-spawner.mjs";
import { PiSpawner } from "../pi-spawner.mjs";

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

  it("returns a PiSpawner for pi — NOT the claude-code default, NOT offline", () => {
    const s = selectSpawner("pi", { logger, permissionMode: "yolo", creds });
    expect(s).toBeInstanceOf(PiSpawner);
    expect(s).not.toBeInstanceOf(ClaudeSpawner);
    expect(s).not.toBeInstanceOf(OfflineSpawner);
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
    expect(selectSpawner("pi", { logger, creds }).creds).toEqual(creds);
  });

  it("defaults to claude-code when the agent type is unrecognized (no throw — selection is post-validation)", () => {
    // resolveAgentType already rejected unknowns before this point; selectSpawner
    // is total and falls back to the safe default rather than throwing.
    const s = selectSpawner("something-else", { logger, permissionMode: "yolo", creds });
    expect(s).toBeInstanceOf(ClaudeSpawner);
  });

  it("returns an OfflineSpawner for 'offline' — NOT a ClaudeSpawner (fail-closed, no fall-through)", () => {
    const s = selectSpawner("offline", { logger, permissionMode: "yolo", creds });
    expect(s).toBeInstanceOf(OfflineSpawner);
    // The critical guard: an offline agent must NEVER become the claude-code default.
    expect(s).not.toBeInstanceOf(ClaudeSpawner);
    expect(typeof s.wake).toBe("function");
  });
});

describe("OfflineSpawner (fail-closed no-op wake)", () => {
  it("never spawns: does not invoke onChild and returns a terminal no-op result", async () => {
    const warn = vi.fn();
    const s = selectSpawner("offline", { logger: { info() {}, warn, error() {} }, creds });
    const onChild = vi.fn();
    const result = await s.wake({ prompt: "do it", sessionId: "idea-1", cwd: "/repo", onChild });
    // No subprocess handed to the caller → no server turn advances to running.
    expect(onChild).not.toHaveBeenCalled();
    // Terminal no-op result (exitCode null mirrors the "skipping wake" convention).
    expect(result).toEqual({ sessionId: "idea-1", exitCode: null, isNew: false });
    // Loud, not silent (no-silent-errors): the drop is logged.
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/offline/i);
  });

  it("tolerates a missing logger / empty params without throwing", async () => {
    const s = new OfflineSpawner();
    const result = await s.wake();
    expect(result).toEqual({ sessionId: "", exitCode: null, isNew: false });
  });

  it("all backends expose a wake() method (shared contract)", () => {
    const c = selectSpawner("claude-code", { logger, permissionMode: "yolo", creds });
    const x = selectSpawner("codex", { logger, permissionMode: "yolo", creds });
    const k = selectSpawner("kiro", { logger, permissionMode: "yolo", creds });
    const d = selectSpawner("dsh", { logger, permissionMode: "yolo", creds });
    const pi = selectSpawner("pi", { logger, permissionMode: "yolo", creds });
    expect(typeof c.wake).toBe("function");
    expect(typeof x.wake).toBe("function");
    expect(typeof k.wake).toBe("function");
    expect(typeof d.wake).toBe("function");
    expect(typeof pi.wake).toBe("function");
  });
});
