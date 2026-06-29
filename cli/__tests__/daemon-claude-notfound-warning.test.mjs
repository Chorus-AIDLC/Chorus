// cli/__tests__/daemon-claude-notfound-warning.test.mjs
// Covers daemon-startup-output spec: a missing `claude` emits exactly one loud ⚠
// stderr warning at startup, while the daemon STILL subscribes (non-fatal).
import { describe, it, expect, vi } from "vitest";
import { runDaemon } from "../daemon.mjs";
import { agentNotFoundWarningLine, claudeNotFoundWarningLine } from "../daemon-banner.mjs";

/** Minimal happy-path deps; per-test overrides merge on top. */
function baseDeps(over = {}) {
  return {
    resolve: () => ({ url: "u", apiKey: "cho_x", source: "env" }),
    validate: async () => ({ uuid: "agent-1", name: "Daemon Bot" }),
    build: vi.fn(() => ({ async start() {}, async stop() {} })),
    isTTY: false,
    // restricted posture so the yolo warning doesn't add noise to these assertions
    chorusOnly: undefined,
    log: () => {},
    errLog: () => {},
    waitForever: async () => {},
    ...over,
  };
}

describe("runDaemon — claude CLI NOT FOUND warning", () => {
  it("emits exactly one ⚠ stderr warning and STILL subscribes when claude is absent", async () => {
    const errs = [];
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const code = await runDaemon(
      { chorusOnly: true }, // restricted → no yolo warning to disambiguate from
      baseDeps({ build, errLog: (m) => errs.push(m), resolveClaudePath: () => null })
    );
    expect(code).toBe(0);
    // Daemon still subscribed (build invoked) despite the missing binary.
    expect(build).toHaveBeenCalledOnce();
    // Exactly one claude-not-found warning line, naming the fixes.
    const warnings = errs.filter((m) => m.includes("claude CLI NOT FOUND"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("CHORUS_CLAUDE_PATH");
    expect(warnings[0]).toContain(".local/bin");
  });

  it("emits NO claude-not-found warning when claude is resolvable", async () => {
    const errs = [];
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const code = await runDaemon(
      { chorusOnly: true },
      baseDeps({ build, errLog: (m) => errs.push(m), resolveClaudePath: () => "/usr/bin/claude" })
    );
    expect(code).toBe(0);
    expect(build).toHaveBeenCalledOnce();
    expect(errs.join("\n")).not.toContain("claude CLI NOT FOUND");
  });

  it("with --agent codex, a missing codex emits a CODEX-specific warning (not claude)", async () => {
    const errs = [];
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const code = await runDaemon(
      { chorusOnly: true, agent: "codex" },
      // resolveClaudePath must NOT be consulted for codex; inject the codex resolver
      baseDeps({
        build,
        errLog: (m) => errs.push(m),
        resolveClaudePath: () => "/usr/bin/claude", // present, but irrelevant for codex
        resolveCodexPath: () => null, // codex missing
      })
    );
    expect(code).toBe(0);
    expect(build).toHaveBeenCalledOnce();
    const joined = errs.join("\n");
    expect(joined).toContain("codex CLI NOT FOUND");
    expect(joined).toContain("CHORUS_CODEX_PATH");
    expect(joined).not.toContain("claude CLI NOT FOUND");
  });
});

describe("agentNotFoundWarningLine — content (backend-aware)", () => {
  it("claude backend: loud, actionable, names CHORUS_CLAUDE_PATH", () => {
    const line = agentNotFoundWarningLine("claude-code");
    expect(line).toMatch(/^⚠/);
    expect(line).toContain("claude CLI NOT FOUND");
    expect(line).toContain("CHORUS_CLAUDE_PATH");
    expect(line).toContain(".local/bin");
    expect(line.toLowerCase()).toContain("still subscribe");
  });

  it("codex backend: names codex + CHORUS_CODEX_PATH", () => {
    const line = agentNotFoundWarningLine("codex");
    expect(line).toMatch(/^⚠/);
    expect(line).toContain("codex CLI NOT FOUND");
    expect(line).toContain("CHORUS_CODEX_PATH");
    expect(line.toLowerCase()).toContain("still subscribe");
  });
});

describe("claudeNotFoundWarningLine — back-compat alias", () => {
  it("still returns the claude warning (delegates to agentNotFoundWarningLine)", () => {
    expect(claudeNotFoundWarningLine()).toBe(agentNotFoundWarningLine("claude-code"));
  });
});
