import { describe, expect, it, vi } from "vitest";
import { runUpgradeCommand, runUpgradeInstall, sanitizeUpgradeOutput, upgradeFailure } from "../upgrade-process.mjs";

describe("upgrade diagnostics", () => {
  it("retains useful causes/status while redacting tokens, headers, URL credentials and environment secrets", () => {
    const result = runUpgradeCommand("npm", [], {
      env: { PRIVATE_TOKEN: "env-secret", CUSTOM_PASSWORD: "with/slash" },
      resolveBinary: () => "/fake/npm",
      spawnSync: () => ({
        status: 13, stdout: "", stderr: [
          "EACCES permission denied",
          "env-secret with%2Fslash cho_secret npm_secret",
          "Authorization: Bearer header-secret",
          '"Authorization": "Bearer json-secret"',
          "env-\u001b[31msecret\u001b[0m",
          'password="quoted secret"',
          "https://user:url-password@registry.example/path?auth=opaque-value",
        ].join("\n"),
      }),
    });
    const diagnostic = upgradeFailure(result);
    expect(diagnostic).toContain("exit 13");
    expect(diagnostic).toContain("EACCES");
    for (const secret of ["env-secret", "with%2Fslash", "cho_secret", "npm_secret", "header-secret", "json-secret", "quoted secret", "url-password", "opaque-value"]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(diagnostic).toContain("registry.example");
  });
  it("retains signals and launch error codes", () => {
    expect(upgradeFailure({ signal: "SIGTERM" })).toContain("SIGTERM");
    const result = runUpgradeCommand("npm", [], {
      resolveBinary: () => "/missing",
      spawnSync: () => ({ error: { code: "ENOENT", message: "spawn ENOENT" }, status: null }),
    });
    expect(upgradeFailure(result)).toContain("ENOENT");
  });
  it("redacts before truncating a bounded diagnostic tail", () => {
    const secret = "x".repeat(2500);
    const output = upgradeFailure({ code: 1, stderr: "old\n".repeat(1000) + secret }, { env: { API_KEY: secret } });
    expect(output.length).toBeLessThan(2100);
    expect(output).not.toContain("x".repeat(10));
    expect(sanitizeUpgradeOutput("token=abc")).not.toContain("abc");
  });
});

describe("npm installation lifecycle", () => {
  it("streams sanitized lines before completion without an installation deadline", async () => {
    const lines = [];
    let complete = false;
    const result = await runUpgradeInstall("node", ["-e", `
      process.stdout.write("downloading\\n");
      process.stderr.write("Authorization: Bea");
      setTimeout(() => process.stderr.write("rer hidden-token\\n"), 30);
      setTimeout(() => process.exit(7), 80);
    `], {
      resolveBinary: () => process.execPath,
      timeoutMs: 1, // Deliberately ignored by the installation runner.
      env: {},
      onOutput: (line) => { expect(complete).toBe(false); lines.push(line); },
    });
    complete = true;
    expect(result).toMatchObject({ ok: false, code: 7, signal: null });
    expect(lines).toContain("downloading");
    expect(lines.join("\n")).toContain("[redacted]");
    expect(JSON.stringify({ result, lines })).not.toContain("hidden-token");
  });
  it("does not expose overlong lines or secrets split across stdout chunks", async () => {
    const onOutput = vi.fn();
    const result = await runUpgradeInstall("node", ["-e", `
      process.stdout.write("begin-sec");
      setTimeout(() => {
        process.stdout.write("ret-end\\n");
        process.stderr.write("z".repeat(17000));
        process.stderr.write("\\nEACCES\\n");
      }, 20);
    `], {
      resolveBinary: () => process.execPath,
      env: { API_KEY: "begin-secret-end" }, onOutput,
    });
    expect(result.ok).toBe(true);
    expect(onOutput.mock.calls.flat()).toContain("[redacted]");
    expect(onOutput.mock.calls.flat()).toContain("[overlong output line omitted]");
    expect(onOutput.mock.calls.flat()).toContain("EACCES");
    expect(JSON.stringify(result)).not.toContain("begin-secret-end");
  });
});
