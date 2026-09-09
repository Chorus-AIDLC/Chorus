import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const sourceDir = resolve("plugins/chorus/hooks");
const tempDirs = [];

function makeHooks(checkinBody = '{"agent":{"name":"test"}}') {
  const dir = mkdtempSync(join(tmpdir(), "chorus-session-hook-"));
  tempDirs.push(dir);
  // Copy EVERY shipped hook script, not a hand-listed subset: on-session-start.sh
  // sources its siblings (hook-output.sh, resolve-spec-mode.sh) under `set -e`, so
  // a missing sibling makes the hook exit non-zero. An allowlist here goes stale
  // silently the next time the hook grows a dependency.
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".sh")) continue;
    cpSync(join(sourceDir, entry.name), join(dir, entry.name));
    chmodSync(join(dir, entry.name), 0o755);
  }
  // Overwrite the real MCP wrapper with a stub (after the copy loop, so it wins).
  writeFileSync(
    join(dir, "chorus-mcp-call.sh"),
    `#!/usr/bin/env bash\nprintf '%s\\n' '${checkinBody}'\n`,
  );
  chmodSync(join(dir, "on-session-start.sh"), 0o755);
  chmodSync(join(dir, "chorus-mcp-call.sh"), 0o755);
  return join(dir, "on-session-start.sh");
}

function runHook(script, env) {
  const result = spawnSync(script, {
    input: '{"hook_event_name":"SessionStart"}',
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
    // The hook resolves the spec mode against $PWD (Codex has no project-dir env
    // var). Run in the temp dir so the answer can't depend on whether the machine
    // running the tests happens to have an `openspec/` directory — this repo does.
    cwd: resolve(script, ".."),
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("Codex SessionStart Chorus diagnostics", () => {
  it("returns connected user status and model context through separate channels", () => {
    const output = runHook(makeHooks(), {
      CHORUS_URL: "https://chorus.test",
      CHORUS_API_KEY: "cho_test",
    });
    expect(output.systemMessage).toContain("Chorus connected at https://chorus.test");
    expect(output.hookSpecificOutput.additionalContext).toContain("Chorus Plugin");
    expect(output.hookSpecificOutput.additionalContext.match(/Chorus is connected/g)).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain("environment not configured");
    // The hook sources resolve-spec-mode.sh and injects the resolved mode; the temp
    // cwd has no openspec/ dir, so the resolver must land on the lite fallback and
    // route to the spec-lite skill (never to openspec, never to a bare mode line).
    expect(output.systemMessage).toContain("(Spec: lite)");
    expect(output.hookSpecificOutput.additionalContext).toContain("CHORUS_SPEC_MODE=lite");
    expect(output.hookSpecificOutput.additionalContext).toContain("Routing: lite");
    expect(output.hookSpecificOutput.additionalContext).not.toContain("CHORUS_OPENSPEC_ACTIVE=1");
  });

  it("honors an explicit CHORUS_SPEC_MODE=off through the shared resolver", () => {
    const output = runHook(makeHooks(), {
      CHORUS_URL: "https://chorus.test",
      CHORUS_API_KEY: "cho_test",
      CHORUS_SPEC_MODE: "off",
    });
    expect(output.systemMessage).toContain("(Spec: off)");
    expect(output.hookSpecificOutput.additionalContext).toContain("Routing: off");
  });

  it("halts rather than downgrading when an explicit openspec is not usable", () => {
    const output = runHook(makeHooks(), {
      CHORUS_URL: "https://chorus.test",
      CHORUS_API_KEY: "cho_test",
      CHORUS_SPEC_MODE: "openspec",
    });
    expect(output.systemMessage).toContain("(Spec: openspec — not usable)");
    expect(output.hookSpecificOutput.additionalContext).toContain("cannot be honored");
    expect(output.hookSpecificOutput.additionalContext).toContain("MUST halt");
  });

  it("returns missing-config user status and model context through separate channels", () => {
    const output = runHook(makeHooks(), {});
    expect(output.systemMessage).toContain("Chorus plugin: not configured");
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "Chorus environment not configured",
    );
  });

  it("returns connection-failure user status and model context through separate channels", () => {
    const script = makeHooks();
    writeFileSync(join(resolve(script, ".."), "chorus-mcp-call.sh"), "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(join(resolve(script, ".."), "chorus-mcp-call.sh"), 0o755);
    const output = runHook(script, {
      CHORUS_URL: "https://chorus.test",
      CHORUS_API_KEY: "cho_test",
    });
    expect(output.systemMessage).toContain("Chorus: connection failed");
    expect(output.hookSpecificOutput.additionalContext).toContain("Unable to reach Chorus");
  });

  it("allows an independent startup to emit its own warning", () => {
    const script = makeHooks();
    for (let index = 0; index < 2; index += 1) {
      const output = runHook(script, {});
      expect(output.systemMessage).toContain("Chorus plugin: not configured");
      expect(output.hookSpecificOutput.additionalContext).toContain(
        "Chorus environment not configured",
      );
    }
  });
});
