// cli/agent-launcher.mjs
// `chorus agents run` — launch a configured coding-agent binary in the FOREGROUND
// with the selected Chorus agent's connection + identity injected into the child
// environment only. This is the interactive counterpart to the daemon's headless
// spawners (claude-spawner / codex-spawner / …): it reuses the SAME env-injection
// contract (CHORUS_URL / CHORUS_API_KEY / CHORUS_AGENT_PROFILE) and the SAME
// shell-free PATH resolution, but differs deliberately —
//   • stdio is INHERITED (the agent gets the real TTY; Ctrl-C reaches it directly),
//   • CHORUS_DAEMON_HEADLESS is NOT set (and is cleared if it leaked in),
//   • every token after `--` is passed to the agent VERBATIM, with no validation,
//   • the child's exit (code or signal) is forwarded as this command's exit code.
//
// SECRET RULE: the `cho_` API key is injected into the child env only. It is NEVER
// written to stdout, stderr, or any log — diagnostics name the agent by
// name/UUID and the resolved binary, nothing else.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { win32 as pathWin32, posix as pathPosix } from "node:path";
import { resolveLaunchAgent } from "./credentials.mjs";

/**
 * Launch agent-type → executable base name. Launch is a SUPERSET of daemon wake:
 * it can start ANY known agent, including the ones the daemon classifies
 * "offline" (opencode / openclaw / dsh) and therefore never auto-wakes. The
 * "offline" value itself is intentionally ABSENT: it is a wake classification,
 * not a concrete backend, so it cannot name a binary — a user who added such an
 * agent must pass an explicit `--type` (see resolveBinaryName).
 * @type {Readonly<Record<string,string>>}
 */
export const TYPE_TO_BINARY = Object.freeze({
  "claude-code": "claude",
  claude: "claude",
  codex: "codex",
  kiro: "kiro-cli",
  pi: "pi",
  opencode: "opencode",
  openclaw: "openclaw",
  dsh: "dsh-jsonrpc-agent",
});

/** Human list of accepted --type values, for help + error text. */
export const SUPPORTED_TYPES = "claude-code, codex, kiro, pi, opencode, openclaw, dsh";

/**
 * POSIX signal name → number, for the shell `128 + signum` exit convention when
 * the launched agent is terminated by a signal (e.g. Ctrl-C = SIGINT → 130).
 * Node's `close` event yields a signal NAME (or null); a naive `exit(code)` with
 * code=null would collapse a signal death to exit 0 and hide it.
 */
const SIGNUM = Object.freeze({
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGABRT: 6,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
});

/** A non-empty trimmed string, or undefined. */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Split raw `chorus agents run` argv into chorus-owned flags and verbatim
 * passthrough. The FIRST bare `--` terminates chorus-flag parsing; everything
 * after it is passthrough, untouched. Chorus flags (before `--`): `--name <v>` /
 * `--name=<v>`, its `--agent` alias, `--type <v>` / `--type=<v>`, and `--help`/`-h`.
 * The first token that is NOT a recognized chorus flag also starts the
 * passthrough (lenient) — so `chorus agents run --name x foo --bar` treats
 * `foo --bar` as passthrough even without an explicit `--`.
 *
 * @param {string[]} argv  argv AFTER the `run` sub-verb.
 * @returns {{ name?: string, type?: string, help: boolean, passthrough: string[], error?: string }}
 */
export function parseRunArgs(argv = []) {
  const out = { help: false, passthrough: [] };
  let i = 0;
  for (; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--") {
      i += 1; // consume the separator; the rest is passthrough
      break;
    }
    if (tok === "--help" || tok === "-h") {
      out.help = true;
      continue;
    }
    if (tok === "--name" || tok === "--agent") {
      const v = argv[i + 1];
      if (v === undefined) return { ...out, error: `flag ${tok} needs a value` };
      out.name = v;
      i += 1;
      continue;
    }
    if (tok.startsWith("--name=")) {
      out.name = tok.slice("--name=".length);
      continue;
    }
    if (tok.startsWith("--agent=")) {
      out.name = tok.slice("--agent=".length);
      continue;
    }
    if (tok === "--type") {
      const v = argv[i + 1];
      if (v === undefined) return { ...out, error: `flag --type needs a value` };
      out.type = v;
      i += 1;
      continue;
    }
    if (tok.startsWith("--type=")) {
      out.type = tok.slice("--type=".length);
      continue;
    }
    // Unrecognized token → start of verbatim passthrough.
    break;
  }
  out.passthrough = argv.slice(i);
  return out;
}

/**
 * Resolve the agent type (explicit `--type` wins over the stored `agentType`)
 * and map it to a binary base name. An `offline` classification or any unknown
 * type has no launchable binary → returns an `error` string instructing the user
 * to pass an explicit `--type`.
 * @param {string|undefined} explicitType  the `--type` flag value
 * @param {string|undefined} configType    the agent's stored agentType
 * @returns {{ type: string, binary: string } | { error: string }}
 */
export function resolveBinaryName(explicitType, configType) {
  const type = nonEmpty(explicitType) ?? nonEmpty(configType);
  if (!type) {
    return { error: `no agent type given and none is configured — pass --type <${SUPPORTED_TYPES}>` };
  }
  const binary = TYPE_TO_BINARY[type];
  if (!binary) {
    const reason =
      type === "offline"
        ? `agent is configured as "offline" (the daemon does not auto-wake it, so its concrete backend is not stored)`
        : `unknown agent type "${type}"`;
    return { error: `${reason} — pass an explicit --type <${SUPPORTED_TYPES}>` };
  }
  return { type, binary };
}

/**
 * Resolve an executable base name to a full path WITHOUT a shell, walking PATH.
 * On Windows, tries `.cmd` / `.exe` / bare (npm shims are `.cmd`); on POSIX just
 * the bare name. Mirrors resolveClaudePath's shape. Returns null when not found.
 * @param {string} binName
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, isFile?: (p: string) => boolean }} [deps]
 * @returns {string | null}
 */
export function resolveBinaryPath(binName, deps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const isFile =
    deps.isFile ??
    ((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
  const isWin = platform === "win32";
  const p = isWin ? pathWin32 : pathPosix;
  const names = isWin ? [`${binName}.cmd`, `${binName}.exe`, binName] : [binName];
  const pathVar = env.PATH || env.Path || "";
  const dirs = pathVar.split(p.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = p.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve the actual command + argv to spawn. A Windows `.cmd`/`.bat` shim is not
 * a PE executable, so it must run via `cmd.exe /d /s /c <path> …args`; keep
 * shell:false and pass argv as an array (no shell word-splitting/injection). On
 * POSIX (and a real `.exe`) spawn the path directly.
 * @param {string} binPath @param {string[]} args
 * @param {NodeJS.Platform} [platform] @param {NodeJS.ProcessEnv} [env]
 * @returns {{ command: string, argv: string[] }}
 */
export function resolveSpawnCommand(binPath, args, platform = process.platform, env = process.env) {
  const isWin = platform === "win32";
  const lower = binPath.toLowerCase();
  if (isWin && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
    return { command: comspec, argv: ["/d", "/s", "/c", binPath, ...args] };
  }
  return { command: binPath, argv: args };
}

/**
 * Build the child environment: the inherited env plus the selected agent's Chorus
 * connection + identity. NO CHORUS_DAEMON_HEADLESS — this is an interactive run;
 * a leaked value from a daemon-run parent is cleared so the agent does not adopt
 * headless behavior. Only non-empty fields are set.
 * @param {import("./credentials.mjs").LaunchAgent} agent
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildChildEnv(agent, baseEnv = process.env) {
  const childEnv = { ...baseEnv };
  if (agent.url) childEnv.CHORUS_URL = agent.url;
  if (agent.apiKey) childEnv.CHORUS_API_KEY = agent.apiKey;
  const profile = agent.agentUuid || agent.agentName;
  if (profile) childEnv.CHORUS_AGENT_PROFILE = profile;
  delete childEnv.CHORUS_DAEMON_HEADLESS;
  return childEnv;
}

/** Usage text for `chorus agents run`. */
export function runHelpText(version = "") {
  const v = version ? ` v${version}` : "";
  return `\
Chorus${v} — launch a configured agent

USAGE
  chorus agents run --name <name|uuid> [--type <type>] [--] [agent args…]

Launches the agent's binary in the FOREGROUND with this agent's Chorus connection
injected into the child (CHORUS_URL / CHORUS_API_KEY / CHORUS_AGENT_PROFILE).
Everything after \`--\` is passed to the agent verbatim — the agent's full flag
surface is available and is never inspected by chorus.

FLAGS
  --name <name|uuid>   Which configured agent to launch (default: the only one).
  --type <type>        Override the agent's backend: ${SUPPORTED_TYPES}.
  -h, --help           Show this help.

Notes
  • Agents added as opencode / openclaw / dsh are stored as "offline"; pass
    --type explicitly to launch them.
  • The API key is injected into the launched process only — never printed.
`;
}

/**
 * Run `chorus agents run …`. Selects the agent, resolves its binary, injects the
 * Chorus env, and spawns it in the foreground. Resolves with an exit code (never
 * calls process.exit): the launched agent's code, `128 + signum` on signal death,
 * `1` on any launch failure, `2` on a usage error, `0` on --help.
 *
 * @param {string[]} argv  argv AFTER the `run` sub-verb.
 * @param {{ stdout?: {write:(s:string)=>void}, stderr?: {write:(s:string)=>void},
 *   env?: NodeJS.ProcessEnv, readJson?: (p:string)=>any, loginPath?: string,
 *   platform?: NodeJS.Platform, cwd?: string, version?: string,
 *   spawnImpl?: Function, isFile?: (p:string)=>boolean }} [opts]
 * @returns {Promise<number>}
 */
export async function runAgentLaunch(argv = [], opts = {}) {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const spawnImpl = opts.spawnImpl ?? spawn;
  const version = opts.version ?? "";

  const parsed = parseRunArgs(argv);
  if (parsed.help) {
    out.write(runHelpText(version));
    return 0;
  }
  if (parsed.error) {
    err.write(`error: ${parsed.error}\n\n${runHelpText(version)}`);
    return 2;
  }

  // 1. Select which configured agent to launch.
  let agent;
  try {
    agent = resolveLaunchAgent({ name: parsed.name }, opts);
  } catch (e) {
    err.write(`error: ${e.message}\n`);
    return 1;
  }

  // 2. Resolve the type → binary (explicit --type wins over stored agentType).
  const typeRes = resolveBinaryName(parsed.type, agent.agentType);
  if (typeRes.error) {
    err.write(`error: ${agent.label}: ${typeRes.error}\n`);
    return 1;
  }

  // 3. Locate the binary on PATH.
  const binPath = resolveBinaryPath(typeRes.binary, { env, platform, isFile: opts.isFile });
  if (!binPath) {
    err.write(
      `error: could not find the \`${typeRes.binary}\` executable on PATH ` +
        `(agent "${agent.label}", type "${typeRes.type}"). Is it installed?\n`,
    );
    return 1;
  }

  // 4. Build the child env and the spawn command.
  const childEnv = buildChildEnv(agent, env);
  const { command, argv: spawnArgv } = resolveSpawnCommand(binPath, parsed.passthrough, platform, env);

  // Diagnostic — agent name/uuid + binary ONLY. Never the key or url userinfo.
  out.write(`Launching ${agent.label} (${agent.agentUuid ?? "no uuid"}) → ${typeRes.binary}\n`);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, spawnArgv, {
        cwd: opts.cwd ?? process.cwd(),
        stdio: "inherit",
        env: childEnv,
        shell: false,
      });
    } catch (e) {
      err.write(`error: failed to launch ${typeRes.binary}: ${e.message}\n`);
      resolve(1);
      return;
    }
    child.on("error", (e) => {
      err.write(`error: ${typeRes.binary} failed to start: ${e.message}\n`);
      resolve(1);
    });
    child.on("close", (code, signal) => {
      if (signal) {
        resolve(128 + (SIGNUM[signal] ?? 0));
        return;
      }
      resolve(typeof code === "number" ? code : 0);
    });
  });
}
