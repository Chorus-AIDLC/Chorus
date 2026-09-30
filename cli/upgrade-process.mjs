// Bounded, captured subprocesses. Never print child diagnostics (they may contain
// credentials). npm's Windows shim is launched through Node, without cmd parsing.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { win32, posix } from "node:path";
import { resolveBinaryPath } from "./agent-launcher.mjs";
import { getAgentEnv } from "./agent-cli-config.mjs";

export function commandForUpgrade(binary, args, {
  platform = process.platform, env = process.env, node = process.execPath,
  exists = existsSync, realpath = realpathSync,
} = {}) {
  const p = platform === "win32" ? win32 : posix;
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(binary)) {
    return { command: binary, args };
  }
  if (/^npm\.(cmd|bat)$/i.test(p.basename(binary))) {
    const cli = p.join(p.dirname(binary), "node_modules", "npm", "bin", "npm-cli.js");
    if (!exists(cli)) throw new Error("npm shim has no npm-cli.js");
    return { command: node, args: [realpath(cli), ...args] };
  }
  // Native host binaries use argv directly. For a Windows command shim, quote
  // spaces and reject cmd expansion/control characters rather than interpolate.
  const tokens = [binary, ...args];
  if (tokens.some((s) => /["%!^&|<>()\r\n\0]/.test(s))) {
    throw new Error("Unsupported characters in Windows command shim");
  }
  return {
    command: getAgentEnv(env, "COMSPEC", platform) || "cmd.exe",
    args: ["/d", "/s", "/c", `"${tokens.map((s) => `"${s}"`).join(" ")}"`],
    windowsVerbatimArguments: true,
  };
}

export function runUpgradeCommand(cmd, args = [], opts = {}) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  try {
    const binary = (opts.resolveBinary ?? resolveBinaryPath)(cmd, { env, platform });
    if (!binary) return { ok: false, reason: "missing executable" };
    const launch = commandForUpgrade(binary, args, { ...opts, env, platform });
    const r = (opts.spawnSync ?? spawnSync)(launch.command, launch.args, {
      env, cwd: opts.cwd, shell: false, windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
      timeout: opts.timeoutMs ?? 120_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
    });
    return {
      ok: !r.error && r.status === 0, stdout: r.stdout ?? "",
      reason: r.error?.code === "ETIMEDOUT" ? "timed out" : "command failed",
    };
  } catch {
    return { ok: false, reason: "could not launch command safely" };
  }
}
