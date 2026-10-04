import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { overlayAgentEnv, getAgentEnv, validateAgentCliConfig, rejectSharedCliConfig } from "./agent-cli-config.mjs";
import { resolveBinaryPath } from "./agent-launcher.mjs";
import { readClaudeInstallState } from "./init/adapters.mjs";
import { installClaude, installCodex, installKiro, readCodexInstallState } from "./init/install-methods.mjs";
import { normalizeAssetBase } from "./init/file-template.mjs";
import { runUpgradeCommand, sanitizeUpgradeOutput, upgradeFailure } from "./upgrade-process.mjs";
import { probePiBackend, inspectPiSettings, managePiPackages } from "./init/pi-mcp-backend.mjs";

const HOSTS = {
  claude: { binary: "claude", variable: "CLAUDE_CONFIG_DIR", dir: [".claude"] },
  codex: { binary: "codex", variable: "CODEX_HOME", dir: [".codex"] },
  kiro: { binary: "kiro-cli", variable: "KIRO_DIR", dir: [".kiro"] },
  pi: { binary: "pi", variable: "PI_CODING_AGENT_DIR", dir: [".pi", "agent"] },
};
const text = (v) => typeof v === "string" && v.trim() ? v.trim() : undefined;
const object = (v) => v && typeof v === "object" && !Array.isArray(v);

// Resolve existing ancestors too: two not-yet-created config dirs under aliased
// homes still share a destination. No directory is created during planning.
function canonical(path, io, p) {
  try { return io.realpathSync(path); } catch (e) {
    if (e.code !== "ENOENT") throw e;
    const parent = p.dirname(path);
    if (parent === path) return path;
    return p.join(canonical(parent, io, p), p.basename(path));
  }
}

export function planPluginTargets(config, deps = {}) {
  const io = deps.fs ?? fs, platform = deps.platform ?? process.platform;
  const p = platform === "win32" ? win32 : posix;
  const base = deps.env ?? process.env;
  if (!object(config) || (config.agents !== undefined && !Array.isArray(config.agents))) throw new Error("invalid config");
  rejectSharedCliConfig(config);
  const rows = config.agents ?? (Object.keys(config).length ? [config] : []);
  const targets = new Map(), results = [];
  rows.forEach((row, i) => {
    // Stable indices associate every row without echoing untrusted names/keys.
    const label = `agents[${i}]`;
    if (!object(row)) { results.push({ target: label, complete: false, detail: "Malformed agent record." }); return; }
    const rawType = text(row.agentType) ?? text(config.agent);
    const type = rawType === "claude-code" ? "claude" : rawType;
    const host = Object.hasOwn(HOSTS, type) ? HOSTS[type] : undefined;
    if (!host) { results.push({ target: label, complete: false, detail: "Skipped: offline, unknown or missing explicit host type." }); return; }
    try {
      const overrides = validateAgentCliConfig({ env: row.env }, type, label).env;
      let env = overlayAgentEnv(base, overrides, platform);
      // Normalize Windows case aliases for existing installer readers.
      for (const name of ["HOME", "USERPROFILE", "PATH", ...Object.values(HOSTS).map((h) => h.variable)]) {
        const value = getAgentEnv(env, name, platform);
        if (value !== undefined) env = overlayAgentEnv(env, { [name]: value }, platform);
      }
      const homeOverride = getAgentEnv(overrides, "HOME", platform) ||
        getAgentEnv(overrides, "USERPROFILE", platform);
      const home = p.resolve(homeOverride || env.HOME || env.USERPROFILE || homedir());
      env.HOME = home;
      if (platform === "win32") env.USERPROFILE = home;
      const destination = canonical(p.resolve(env[host.variable] || p.join(home, ...host.dir)), io, p);
      env[host.variable] = destination;
      // Do not inherit an interactive Claude nesting guard into its plugin CLI.
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
      const key = `${type}:${platform === "win32" ? destination.toLowerCase() : destination}`;
      let source;
      if (type === "kiro") {
        source = normalizeAssetBase(text(row.url) ?? text(config.url) ?? env.CHORUS_URL);
        const url = new URL(source);
        if (url.username || url.password || url.search || url.hash) throw new Error("invalid source");
      }
      const existing = targets.get(key);
      if (existing) {
        existing.labels.push(label);
        if (existing.source !== source) existing.conflict = true;
      } else targets.set(key, { type, host, destination, env, source, labels: [label] });
    } catch {
      results.push({ target: label, complete: false, detail: "Invalid environment, destination or Chorus source URL." });
    }
  });
  return { targets: [...targets.values()], results };
}

function readJson(path, io) {
  try { return JSON.parse(io.readFileSync(path, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return undefined; throw e; }
}

export function upgradePi(target, { run, fs: io = fs, cwd = process.cwd() }) {
  const env = { ...target.env, PI_CODING_AGENT_DIR: target.destination };
  const backend = probePiBackend({ run, env });
  const scopes = inspectPiSettings({ env, cwd, readJson: (path) => readJson(path, io) });
  return managePiPackages({ backend, scopes, run, env, update: true });
}

export async function upgradePlugins(deps = {}) {
  const io = deps.fs ?? fs, env = deps.env ?? process.env, platform = deps.platform ?? process.platform;
  const p = platform === "win32" ? win32 : posix;
  const configPath = deps.configPath ?? p.join(getAgentEnv(env, "HOME", platform) || getAgentEnv(env, "USERPROFILE", platform) || homedir(), ".chorus", "daemon.json");
  let plan;
  try {
    const config = readJson(configPath, io);
    if (config === undefined) return [{ target: "plugins", complete: true, detail: "No daemon configuration; no configured plugins." }];
    plan = planPluginTargets(config, deps);
  } catch {
    return [{ target: "plugins", complete: false, detail: "Cannot read or validate daemon configuration." }];
  }
  const results = plan.results;
  if (!plan.targets.length && !results.length) return [{ target: "plugins", complete: true, detail: "No configured plugins." }];
  for (const target of plan.targets) {
    const label = `${target.type} (${target.labels.join(", ")})`;
    if (target.conflict) {
      results.push({ target: label, complete: false, detail: "Conflicting Chorus URLs for one Kiro destination; no update attempted." });
      continue;
    }
    if (!(deps.resolveBinary ?? resolveBinaryPath)(target.host.binary, { env: target.env, platform })) {
      results.push({ target: label, complete: false, detail: "Skipped: host executable missing from this record's PATH." });
      continue;
    }
    let scratch;
    let changed = false;
    const failures = [];
    const safe = (text) => sanitizeUpgradeOutput(text, { env: target.env });
    try {
      // Package commands must not discover project-local plugin configuration.
      scratch = io.mkdtempSync(join(tmpdir(), "chorus-upgrade-"));
      const run = (cmd, args, options = {}) => {
        if (!args.includes("--help") && !args.includes("--version")) changed = true;
        const result = (deps.run ?? runUpgradeCommand)(cmd, args, { env: target.env, platform, cwd: scratch, timeoutMs: options.timeoutMs ?? 120_000 });
        if (!result.ok) failures.push(`${cmd} ${args.slice(0, 2).join(" ")}: ${upgradeFailure(result, { env: target.env })}`);
        return result;
      };
      if (target.type === "pi") {
        const result = upgradePi(target, { run, fs: io, cwd: deps.cwd });
        results.push({ target: label, ...result, detail: safe([result.detail, ...failures].join("\n")) });
        continue;
      }
      const state = target.type === "claude"
        ? readClaudeInstallState({ env: target.env, home: target.env.HOME, readJson: (path) => readJson(path, io) })
        : target.type === "codex" ? readCodexInstallState({ env: target.env }) : {};
      const install = (deps.installers ?? { claude: installClaude, codex: installCodex, kiro: installKiro })[target.type];
      const outcome = await install({
        env: target.env, platform, run,
        flags: { updateInstalled: true, pluginOnly: true, url: target.source },
        adapter: { readInstallState: () => state },
        backup: (path) => {
          if (io.existsSync(path)) io.copyFileSync(path, `${path}.chorus-upgrade.bak`);
        },
        // Keep the deadline active while response bodies are consumed too.
        fetch: (url) => (deps.fetch ?? globalThis.fetch)(url, { signal: AbortSignal.timeout(30_000) }),
      });
      const complete = ["installed", "repaired"].includes(outcome.action);
      changed ||= complete;
      results.push({
        target: label, complete, changed,
        detail: complete ? (target.source ? `Refreshed Chorus templates from ${target.source}.` : "Chorus plugin refreshed.")
          : safe([outcome.detail || "Plugin update failed or is unsupported.", ...failures].join("\n")),
      });
    } catch (error) {
      results.push({ target: label, complete: false, changed, detail: safe(`Plugin update failed: ${error?.message || "unknown error"}\n${failures.join("\n")}`) });
    } finally {
      if (scratch) io.rmSync(scratch, { recursive: true, force: true });
    }
  }
  return results;
}
