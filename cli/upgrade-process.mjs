// Queries are bounded; npm installation streams sanitized progress without a
// deadline that could interrupt replacement of the running package.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { win32, posix } from "node:path";
import { resolveBinaryPath } from "./agent-launcher.mjs";
import { getAgentEnv } from "./agent-cli-config.mjs";

export function sanitizeUpgradeOutput(value, { env = process.env, secrets = [] } = {}) {
  let text = stripVTControlCharacters(String(value ?? ""));
  const values = [...secrets, ...Object.entries(env)
    .filter(([key]) => /key|token|secret|password|credential|auth/i.test(key))
    .map(([, v]) => v)].filter((v) => typeof v === "string" && v.length > 0);
  for (const secret of values.sort((a, b) => b.length - a.length)) {
    for (const form of new Set([secret, encodeURIComponent(secret)])) text = text.split(form).join("[redacted]");
  }
  return text
    .replace(/\b(?:cho_|npm_|gh[pousr]_|sk-)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\b(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+)?[^"'\s,;]+/gi, "$1[redacted]")
    .replace(/((?:["']?[\w.-]*(?:token|password|secret|api[_-]?key|_auth)[\w.-]*["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) { parsed.username = "[redacted]"; parsed.password = ""; }
        for (const key of [...parsed.searchParams.keys()]) parsed.searchParams.set(key, "[redacted]");
        if (parsed.hash) parsed.hash = "[redacted]";
        return parsed.toString();
      } catch { return "[redacted URL]"; }
    })
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export function upgradeFailure(result, opts = {}) {
  const status = Number.isInteger(result?.code) ? `exit ${result.code}`
    : result?.signal ? `signal ${result.signal}` : result?.reason || "command failed";
  const sanitized = sanitizeUpgradeOutput(result?.stderr || result?.error || result?.stdout || "", opts);
  const permission = sanitized.match(/\b(?:EACCES|EPERM)\b/)?.[0];
  const detail = sanitized.trim().split("\n").slice(-6).join("\n").slice(-2000);
  return `${status}${permission ? ` (${permission})` : ""}${detail ? `: ${detail}` : ""}`;
}

function processResult(r, opts) {
  return {
    ok: !r.error && r.status === 0,
    code: r.status ?? null, signal: r.signal ?? null,
    stdout: sanitizeUpgradeOutput(r.stdout, opts),
    stderr: sanitizeUpgradeOutput(r.stderr, opts),
    error: sanitizeUpgradeOutput(r.error?.message || r.error?.code, opts),
    reason: r.error?.code === "ETIMEDOUT" ? "timed out" : "command failed",
  };
}

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
    return processResult(r, { ...opts, env });
  } catch (error) {
    return processResult({ error }, { ...opts, env });
  }
}

export async function runUpgradeInstall(cmd, args = [], opts = {}) {
  const env = opts.env ?? process.env, platform = opts.platform ?? process.platform;
  try {
    const binary = (opts.resolveBinary ?? resolveBinaryPath)(cmd, { env, platform });
    if (!binary) return { ok: false, reason: "missing executable" };
    const launch = commandForUpgrade(binary, args, { ...opts, env, platform });
    return await new Promise((resolve) => {
      const child = (opts.spawn ?? spawn)(launch.command, launch.args, {
        env, cwd: opts.cwd, shell: false, windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        stdio: ["ignore", "pipe", "pipe"],
        // No timeout, timer or automatic kill: let npm complete/roll back.
      });
      const buffers = { stdout: "", stderr: "" };
      const tails = { stdout: "", stderr: "" };
      const dropping = { stdout: false, stderr: false };
      const emit = (name, line) => {
        const safe = sanitizeUpgradeOutput(line, { ...opts, env });
        tails[name] = (tails[name] + safe + "\n").slice(-4000);
        if (safe) opts.onOutput?.(safe);
      };
      for (const name of ["stdout", "stderr"]) {
        child[name].setEncoding("utf8");
        child[name].on("data", (chunk) => {
          for (const part of chunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
            const ended = part.endsWith("\n");
            if (!dropping[name]) buffers[name] += part;
            if (buffers[name].length > 16_384) {
              buffers[name] = "";
              dropping[name] = true; // Never emit a fragment of a long secret.
            }
            if (ended) {
              emit(name, dropping[name] ? "[overlong output line omitted]" : buffers[name].trimEnd());
              buffers[name] = ""; dropping[name] = false;
            }
          }
        });
      }
      let error;
      child.on("error", (e) => { error = e; });
      child.on("close", (status, signal) => {
        for (const name of ["stdout", "stderr"]) {
          if (dropping[name] || buffers[name]) emit(name, dropping[name] ? "[overlong output line omitted]" : buffers[name]);
        }
        resolve(processResult({ status, signal, error, ...tails }, { ...opts, env }));
      });
    });
  } catch (error) { return processResult({ error }, { ...opts, env }); }
}
