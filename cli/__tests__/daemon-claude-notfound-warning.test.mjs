// cli/__tests__/daemon-claude-notfound-warning.test.mjs
// Covers daemon-startup-output spec: a missing `claude` emits exactly one loud ⚠
// stderr warning at startup, while the daemon STILL subscribes (non-fatal).
import { describe, it, expect, vi } from "vitest";
import { runDaemon } from "../daemon.mjs";
import { claudeNotFoundWarningLine } from "../daemon-banner.mjs";

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
});

describe("claudeNotFoundWarningLine — content", () => {
  it("is a loud, actionable single line", () => {
    const line = claudeNotFoundWarningLine();
    expect(line).toMatch(/^⚠/);
    expect(line).toContain("claude CLI NOT FOUND");
    expect(line).toContain("CHORUS_CLAUDE_PATH");
    expect(line).toContain(".local/bin");
    // stays non-fatal — promises the daemon still subscribes
    expect(line.toLowerCase()).toContain("still subscribe");
  });
});
