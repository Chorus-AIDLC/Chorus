// cli/init/run-command.mjs
// Minimal synchronous command runner for `chorus init` plugin-install steps.
// Injectable (steps take `ctx.run`) so install logic unit-tests without ever
// shelling out. Returns a plain result — never throws.

import { spawnSync } from "node:child_process";

/**
 * Run a command synchronously.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number, cwd?: string }} [opts]
 * @returns {{ ok: boolean, code: number|null, stdout: string, stderr: string, error?: string }}
 */
export function runCommand(cmd, args = [], opts = {}) {
  try {
    const r = spawnSync(cmd, args, {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 120_000,
      encoding: "utf8",
    });
    if (r.error) {
      return { ok: false, code: null, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error.message };
    }
    return { ok: r.status === 0, code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (err) {
    return { ok: false, code: null, stdout: "", stderr: "", error: err?.message ?? String(err) };
  }
}
