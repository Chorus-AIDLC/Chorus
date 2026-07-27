import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const sourceDir = resolve("plugins/chorus/hooks");
const tempDirs = [];

function makeHooks(checkinBody = '{"agent":{"name":"test"}}') {
  const dir = mkdtempSync(join(tmpdir(), "chorus-session-hook-"));
  tempDirs.push(dir);
  cpSync(join(sourceDir, "on-session-start.sh"), join(dir, "on-session-start.sh"));
  cpSync(join(sourceDir, "hook-output.sh"), join(dir, "hook-output.sh"));
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
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("Codex SessionStart Chorus diagnostics", () => {
  it("injects connected context through one output channel", () => {
    const output = runHook(makeHooks(), {
      CHORUS_URL: "https://chorus.test",
      CHORUS_API_KEY: "cho_test",
    });
    expect(output.systemMessage).toBe("");
    expect(output.hookSpecificOutput.additionalContext).toContain("Chorus Plugin");
    expect(output.hookSpecificOutput.additionalContext.match(/Chorus is connected/g)).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain("environment not configured");
  });

  it("emits a missing-config warning through one output channel", () => {
    const output = runHook(makeHooks(), {});
    const serialized = JSON.stringify(output);
    expect(output.systemMessage).toContain("Chorus environment not configured");
    expect(output.hookSpecificOutput).toBeUndefined();
    expect(serialized.match(/Chorus environment not configured/g)).toHaveLength(1);
  });

  it("emits a connection-failure warning through one output channel", () => {
    const script = makeHooks();
    writeFileSync(join(resolve(script, ".."), "chorus-mcp-call.sh"), "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(join(resolve(script, ".."), "chorus-mcp-call.sh"), 0o755);
    const output = runHook(script, {
      CHORUS_URL: "https://chorus.test",
      CHORUS_API_KEY: "cho_test",
    });
    expect(output.systemMessage).toContain("Unable to reach Chorus");
    expect(output.hookSpecificOutput).toBeUndefined();
    expect(JSON.stringify(output).match(/Unable to reach Chorus/g)).toHaveLength(1);
  });

  it("allows an independent startup to emit its own warning", () => {
    const script = makeHooks();
    expect(runHook(script, {}).systemMessage).toContain("environment not configured");
    expect(runHook(script, {}).systemMessage).toContain("environment not configured");
  });
});
