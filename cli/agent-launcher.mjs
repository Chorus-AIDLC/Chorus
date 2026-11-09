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
// SESSION SYNC (cli-agent-session-sync): by default the run is registered as a Chorus
// daemon session by cli/cli-session-sync.mjs, which runs beside the child (register →
// spawn → heartbeat + transcript → flush + release → exit code). `--no-sync` takes the
// historical path verbatim: zero Chorus session calls, no signal handlers.
//
// SECRET RULE: the `cho_` API key is injected into the child env only. It is NEVER
// written to stdout, stderr, or any log — diagnostics name the agent by
// name/UUID and the resolved binary, nothing else.

import { spawn } from "node:child_process";
import { safeSpawnError } from "./launch-diagnostics.mjs";
import { statSync } from "node:fs";
import { win32 as pathWin32, posix as pathPosix } from "node:path";
import { resolveLaunchAgent } from "./credentials.mjs";
import { validateAgentCliConfig, overlayAgentEnv, getAgentEnv, planAgentArgs, assertConfiguredShimArgs } from "./agent-cli-config.mjs";

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
  trae: "traecli",
  opencode: "opencode",
  openclaw: "openclaw",
  dsh: "dsh",
});

/** Human list of accepted --type values, for help + error text. */
export const SUPPORTED_TYPES = "claude-code, codex, kiro, pi, trae, opencode, openclaw, dsh";

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
 * `--name=<v>`, its `--agent` alias, `--type <v>` / `--type=<v>`, `--no-sync`,
 * `--idea <uuid>` / `--idea=<uuid>`, and `--help`/`-h`.
 * The first token that is NOT a recognized chorus flag also starts the
 * passthrough (lenient) — so `chorus agents run --name x foo --bar` treats
 * `foo --bar` as passthrough even without an explicit `--`.
 *
 * @param {string[]} argv  argv AFTER the `run` sub-verb.
 * @returns {{ name?: string, type?: string, idea?: string, noSync: boolean, help: boolean, passthrough: string[], error?: string }}
 */
export function parseRunArgs(argv = []) {
  const out = { help: false, noSync: false, passthrough: [] };
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
    if (tok === "--no-sync") {
      out.noSync = true;
      continue;
    }
    if (tok === "--idea") {
      const v = argv[i + 1];
      // A flag-looking next token (`--idea --no-sync`, `--idea --`) is a MISSING value,
      // never the idea: consuming it would silently drop the user's opt-out/separator.
      if (v === undefined || !v.trim() || v.trim().startsWith("-")) return { ...out, error: `flag --idea needs a value` };
      out.idea = v.trim();
      i += 1;
      continue;
    }
    if (tok.startsWith("--idea=")) {
      const v = tok.slice("--idea=".length).trim();
      if (!v || v.startsWith("-")) return { ...out, error: `flag --idea needs a value` };
      out.idea = v;
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
  const pathVar = getAgentEnv(env, "PATH", platform) || env.Path || "";
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
    const comspec = getAgentEnv(env, "COMSPEC", platform) || "cmd.exe";
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
export function buildChildEnv(agent, baseEnv = process.env, platform = process.platform) {
  const childEnv = overlayAgentEnv(baseEnv, agent.env, platform);
  if (agent.url) childEnv.CHORUS_URL = agent.url;
  if (agent.apiKey) childEnv.CHORUS_API_KEY = agent.apiKey;
  const profile = agent.agentUuid || agent.agentName;
  if (profile) childEnv.CHORUS_AGENT_PROFILE = profile;
  for (const key of Object.keys(childEnv)) {
    if (key.toUpperCase() === "CHORUS_DAEMON_HEADLESS") delete childEnv[key];
  }
  if (agent.agentType === "claude-code" || agent.agentType === "claude") {
    for (const key of Object.keys(childEnv)) {
      if (["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"].includes(key.toUpperCase())) delete childEnv[key];
    }
  }
  return childEnv;
}

/** Usage text for `chorus agents run`. */
export function runHelpText(version = "") {
  const v = version ? ` v${version}` : "";
  return `\
Chorus${v} — launch a configured agent

USAGE
  chorus agents run --name <name|uuid> [--type <type>] [--idea <uuid>] [--no-sync] [--] [agent args…]

Launches the agent's binary in the FOREGROUND with this agent's Chorus connection
injected into the child (CHORUS_URL / CHORUS_API_KEY / CHORUS_AGENT_PROFILE).
Everything after \`--\` is passed to the agent verbatim. Recognized explicit model/
reasoning options suppress configured equivalents in the selected command scope.
Configured args precede explicit options after known commands (Codex exec, exec
resume, resume; Kiro chat; OpenClaw agent), otherwise they go first. Unknown
command grammars are not inferred. Analysis stops at the first bare \`--\`.

FLAGS
  --name <name|uuid>   Which configured agent to launch (default: the only one).
  --type <type>        Override the agent's backend: ${SUPPORTED_TYPES}.
  --idea <uuid>        Anchor the synced Chorus session to this Idea.
  --no-sync            Do not register this run as a Chorus session.
  -h, --help           Show this help.

SESSION SYNC (default on)
  The run is registered as a Chorus daemon session: its transcript is shown live in
  Chorus, and messages sent from Chorus while it runs are queued and continued by
  the local daemon (same machine + directory) after you exit. Claude Code gets a
  derived --session-id; passing your own --session-id/--resume/--continue keeps the
  run visible but not continuable. Sync problems never stop the launch: at most one
  warning line is printed, details go to ~/.chorus/logs/cli-session-sync.log.

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
 *   spawnImpl?: Function, isFile?: (p:string)=>boolean,
 *   sessionSync?: false | Record<string, any> }} [opts]
 *   `sessionSync: false` disables sync exactly like `--no-sync`; an object is passed
 *   through to CliSessionSync (fetchImpl, logger, timers, processRef, … — test seams).
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

  // Validate before binary discovery or spawn, against the effective --type.
  let config;
  try {
    config = validateAgentCliConfig(agent, typeRes.type, agent.label);
  } catch (e) {
    err.write(`error: ${e.message}\n`);
    return 1;
  }
  const childEnv = buildChildEnv({ ...agent, agentType: typeRes.type, env: config.env }, env, platform);

  // 3. Locate the binary using this profile's effective PATH.
  const binPath = resolveBinaryPath(typeRes.binary, { env: childEnv, platform, isFile: opts.isFile });
  if (!binPath) {
    err.write(
      `error: could not find the \`${typeRes.binary}\` executable on PATH ` +
        `(agent "${agent.label}", type "${typeRes.type}"). Is it installed?\n`,
    );
    return 1;
  }

  // 4. Filter only configured recognized duplicates; explicit argv stays untouched.
  const { args, configuredArgs } = planAgentArgs(typeRes.type, config.args, parsed.passthrough);
  try {
    assertConfiguredShimArgs(binPath, configuredArgs, platform, agent.label);
  } catch (e) {
    err.write(`error: ${e.message}\n`);
    return 1;
  }
  const cwd = opts.cwd ?? process.cwd();

  // --no-sync (or the test-only `sessionSync: false` opt): exactly the pre-sync launch —
  // zero Chorus session calls, no signal handlers, identical argv/stdio/exit forwarding.
  if (parsed.noSync || opts.sessionSync === false) {
    const { command, argv: spawnArgv } = resolveSpawnCommand(binPath, args, platform, childEnv);
    // Diagnostic — agent name/uuid + binary ONLY. Never the key or url userinfo.
    out.write(`Launching ${agent.label} (${agent.agentUuid ?? "no uuid"}) → ${typeRes.binary}\n`);
    return spawnForeground({ spawnImpl, command, spawnArgv, cwd, childEnv, binary: typeRes.binary, err });
  }

  // 5. Session sync (default on): register BEFORE spawn; the adapter may inject the
  // resume identity into argv. Any failure → one warning line + unsynced launch.
  const syncOpts = opts.sessionSync && typeof opts.sessionSync === "object" ? opts.sessionSync : {};
  const SyncClass = syncOpts.SyncClass ?? (await import("./cli-session-sync.mjs")).CliSessionSync;
  const sync = new SyncClass({
    ...syncOpts,
    agent,
    agentType: typeRes.type,
    cwd,
    childEnv,
    platform,
    ideaUuid: parsed.idea ?? null,
    stderr: err,
  });
  const planned = await sync.register(args, parsed.passthrough);
  const { command, argv: spawnArgv } = resolveSpawnCommand(binPath, planned.args, platform, childEnv);

  // Diagnostic — agent name/uuid + binary ONLY. Never the key or url userinfo.
  out.write(`Launching ${agent.label} (${agent.agentUuid ?? "no uuid"}) → ${typeRes.binary}\n`);

  if (!planned.active) {
    return spawnForeground({ spawnImpl, command, spawnArgv, cwd, childEnv, binary: typeRes.binary, err });
  }
  return spawnForeground({
    spawnImpl, command, spawnArgv, cwd, childEnv, binary: typeRes.binary, err,
    sync, processRef: syncOpts.processRef ?? process, signalGraceMs: syncOpts.signalGraceMs,
  });
}

/** Signals that, delivered to THIS process, end the run (and release the CLI lease). */
const SYNC_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
export const DEFAULT_SIGNAL_GRACE_MS = 5_000;

/**
 * Spawn the agent in the foreground and resolve with its forwarded exit code. Without
 * `sync` this is byte-for-byte the historical launch (no signal handlers). With `sync`:
 *   • after spawn → `sync.started()` (heartbeat + transcript pump);
 *   • on child close → `await sync.finish()` (bounded flush + release), then the code;
 *   • SIGINT is NOT forwarded (the TTY already delivered it to the child's process
 *     group; forwarding would double it) — this process just stays alive so it can
 *     release when the child exits. A SECOND SIGINT, and any SIGTERM/SIGHUP, is
 *     forwarded to the child; if the child has not exited within `signalGraceMs` the
 *     lease is released anyway and the run resolves `128 + signum`.
 * @returns {Promise<number>}
 */
function spawnForeground({ spawnImpl, command, spawnArgv, cwd, childEnv, binary, err, sync, processRef, signalGraceMs }) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const handlers = [];
    let graceTimer = null;
    let sigintCount = 0;
    const cleanupSignals = () => {
      for (const [sig, fn] of handlers) {
        try {
          processRef.removeListener(sig, fn);
        } catch {
          /* ignore */
        }
      }
      handlers.length = 0;
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = null;
    };
    const settle = async (code, reason) => {
      if (settled) return;
      settled = true;
      cleanupSignals();
      if (sync) await sync.finish(reason ? { reason } : {});
      resolve(code);
    };

    try {
      child = spawnImpl(command, spawnArgv, {
        cwd,
        stdio: "inherit",
        env: childEnv,
        shell: false,
      });
    } catch (error) {
      err.write(`error: failed to launch ${binary}: ${safeSpawnError(error)}\n`);
      void settle(1, "spawn_failed");
      return;
    }

    if (sync) {
      sync.started();
      for (const sig of SYNC_SIGNALS) {
        const fn = () => {
          sync.noteSignal(sig);
          if (sig === "SIGINT" && (sigintCount += 1) === 1) return;
          try {
            child.kill?.(sig);
          } catch {
            /* child may already be gone */
          }
          if (!graceTimer) {
            graceTimer = setTimeout(() => {
              void settle(128 + (SIGNUM[sig] ?? 0), `signal:${sig}`);
            }, signalGraceMs ?? DEFAULT_SIGNAL_GRACE_MS);
            graceTimer.unref?.();
          }
        };
        processRef.on(sig, fn);
        handlers.push([sig, fn]);
      }
    }

    child.on("error", (error) => {
      err.write(`error: ${binary} failed to start: ${safeSpawnError(error)}\n`);
      void settle(1, "spawn_failed");
    });
    child.on("close", (code, signal) => {
      if (signal) {
        void settle(128 + (SIGNUM[signal] ?? 0));
        return;
      }
      void settle(typeof code === "number" ? code : 0);
    });
  });
}
