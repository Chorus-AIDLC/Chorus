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
  it("returns connected user status and model context through separate channels", () => {
    const output = runHook(makeHooks(), {
      CHORUS_URL: "https://chorus.test",
      CHORUS_API_KEY: "cho_test",
    });
    expect(output.systemMessage).toContain("Chorus connected at https://chorus.test");
    expect(output.hookSpecificOutput.additionalContext).toContain("Chorus Plugin");
    expect(output.hookSpecificOutput.additionalContext.match(/Chorus is connected/g)).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain("environment not configured");
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
