// cli/kiro-spawner.mjs
// Cross-platform headless Amazon Kiro CLI spawner — the `kiro` counterpart to
// ClaudeSpawner / CodexSpawner, satisfying the SAME backend-agnostic
// Spawner.wake(...) contract so the daemon's wake pipeline (queue, waker,
// directed delivery, headless guard, reporters) stays backend-neutral.
//
// Kiro diverges from BOTH Claude and Codex (verified against kiro-cli 2.12.1 +
// the live CLI/store on this host):
//   • `kiro-cli chat --no-interactive` runs a headless turn; the prompt is read
//     from STDIN (never argv). It runs under the `chorus` agent profile
//     (`--agent chorus`) so the woken session loads the Kiro plugin's Chorus MCP
//     server + AI-DLC skills + steering (parity with an interactive plugin user).
//   • No `--mcp-config`: MCP comes from the plugin's .kiro/settings/mcp.json
//     (loaded via --agent chorus), which references ${env:CHORUS_API_KEY}; the
//     daemon key reaches it via that env var — never argv.
//   • Permission is a TOOL-TRUST posture (--trust-all-tools / --trust-tools=…),
//     not a sandbox mode and not a per-tool allowlist.
//
// Transcript capture (task 4) is layered on top: this spawner reads the session
// store for the run's sessionId post-run and, if a `reconstructTranscript` hook is
// injected, feeds the reconstructed entries to `onMessage`; otherwise it is a
// no-op here (this task owns spawn/resume/trust/interrupt + sessionId capture).

import { spawn } from "node:child_process";
import { backendSessionKey } from "./backend-session-identity.mjs";
import { safeSpawnError } from "./launch-diagnostics.mjs";
import { validateAgentCliConfig, overlayAgentEnv, getAgentEnv, assertConfiguredShimArgs } from "./agent-cli-config.mjs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { win32 as pathWin32, posix as pathPosix, join } from "node:path";
import { getSessionId as defaultGetSessionId } from "./kiro-session-map.mjs";
import { reconstructTranscript as defaultReconstructTranscript } from "./kiro-transcript.mjs";
import { awaitChildSettled } from "./child-exit.mjs";
import { createWakeErrorCollector } from "./wake-error.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/** Directory Kiro persists its CLI session store under (per-cwd conversations). */
export function kiroSessionsDir(env = process.env, platform = process.platform) {
  return join(getAgentEnv(env, "HOME", platform) || getAgentEnv(env, "USERPROFILE", platform) || homedir(), ".kiro", "sessions", "cli");
}

/**
 * Map the daemon's backend-agnostic permission mode to a Kiro tool-trust posture.
 * A headless turn can never answer an approval prompt, so trust must be granted
 * upfront:
 *   yolo   → --trust-all-tools               (full autonomy for code-writing work)
 *   chorus → --trust-tools=fs_read,@chorus   (read-only filesystem + the Chorus
 *            MCP server's tools; no shell exec / file writes). MCP tools are
 *            namespaced by server in Kiro, so `@chorus` trusts the whole Chorus
 *            server (verified against the plugin's agent def — matcher `@chorus`).
 * Anything other than yolo falls back to the restricted posture.
 * @param {"yolo"|"chorus"|undefined} permissionMode
 * @returns {string[]}
 */
export function trustFlags(permissionMode) {
  if (permissionMode === "yolo") return ["--trust-all-tools"];
  return ["--trust-tools=fs_read,@chorus"];
}

/**
 * Build the argv for a headless kiro-cli run. Prompt is NEVER here — it goes over
 * stdin. Runs under the `chorus` agent profile on the default v2 engine (no
 * `--v3`). A resume passes the recorded sessionId via `--resume-id`.
 * @param {{ isNew: boolean, sessionId?: string|null, permissionMode?: "yolo"|"chorus" }} o
 * @returns {string[]}
 */
export function buildKiroArgs({ isNew, sessionId, permissionMode }) {
  const trust = trustFlags(permissionMode);
  const base = ["chat", "--no-interactive", "--agent", "chorus", ...trust];
  if (!isNew && sessionId) {
    return ["chat", "--no-interactive", "--resume-id", sessionId, "--agent", "chorus", ...trust];
  }
  return base;
}

/**
 * Resolve the real `kiro-cli` executable WITHOUT a shell — same approach as
 * resolveCodexPath. On Windows the bin may be `kiro-cli.cmd` (npm shim), which
 * `spawn` can't exec directly without shell:true; we walk PATH for the platform
 * candidates. `CHORUS_KIRO_PATH` overrides.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, isFile?: (p: string) => boolean }} [deps]
 * @returns {string | null}
 */
export function resolveKiroPath(deps = {}) {
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

  const override = getAgentEnv(env, "CHORUS_KIRO_PATH", platform);
  if (override && isFile(override)) {
    return override;
  }

  const isWin = platform === "win32";
  const p = isWin ? pathWin32 : pathPosix;
  const names = isWin ? ["kiro-cli.cmd", "kiro-cli.exe", "kiro-cli"] : ["kiro-cli"];
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
 * Resolve the actual command + argv to spawn. On Windows a `.cmd`/`.bat` shim is
 * not a PE executable, so it must run via `cmd.exe /d /s /c <path> ...args`; we
 * keep shell:false and pass argv as an array (no shell word-splitting/injection).
 * @param {string} kiroPath @param {string[]} args
 * @param {NodeJS.Platform} [platform] @param {NodeJS.ProcessEnv} [env]
 * @returns {{ command: string, argv: string[] }}
 */
export function resolveSpawnCommand(kiroPath, args, platform = process.platform, env = process.env) {
  const isWin = platform === "win32";
  const lower = kiroPath.toLowerCase();
  if (isWin && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    const comspec = getAgentEnv(env, "COMSPEC", platform) || "cmd.exe";
    return { command: comspec, argv: ["/d", "/s", "/c", kiroPath, ...args] };
  }
  return { command: kiroPath, argv: args };
}

/**
 * Snapshot the session store as a map of `sessionId → updatedAtMillis` for the
 * given cwd. Kiro writes `<sessionsDir>/<sessionId>.json` metadata files carrying
 * `{ session_id, cwd, updated_at, ... }`. Best-effort: any IO/parse failure yields
 * an empty map (never throws) — a missed capture just means the run isn't
 * resumable, logged by the caller.
 * @param {string} cwd
 * @param {{ dir?: string, readdir?: (d: string) => string[], read?: (p: string) => string, logger?: any }} [deps]
 * @returns {Map<string, number>}
 */
export function snapshotSessions(cwd, deps = {}) {
  const dir = deps.dir ?? kiroSessionsDir();
  const readdir = deps.readdir ?? ((d) => readdirSync(d));
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const logger = deps.logger ?? NOOP_LOGGER;
  const out = new Map();
  let files;
  try {
    files = readdir(dir);
  } catch (err) {
    if (!(err && err.code === "ENOENT")) {
      logger.warn(`[Chorus] kiro session snapshot: readdir failed (${err}) — treating as empty`);
    }
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue; // .jsonl / .history are not the metadata file
    let meta;
    try {
      meta = JSON.parse(read(join(dir, f)));
    } catch {
      continue; // skip an unreadable/partial metadata file
    }
    if (!meta || typeof meta !== "object") continue;
    const sid = typeof meta.session_id === "string" ? meta.session_id : f.replace(/\.json$/, "");
    // Scope to this daemon's cwd so a concurrent run in a different cwd can't be
    // mis-attributed. When cwd is unknown, accept all (single-path daemon).
    if (cwd && typeof meta.cwd === "string" && meta.cwd !== cwd) continue;
    const updated = Date.parse(meta.updated_at ?? meta.updatedAt ?? "") || 0;
    out.set(sid, updated);
  }
  return out;
}

/**
 * @typedef {Object} KiroSpawnerOptions
 * @property {string} [kiroPath]   Resolved kiro-cli path (resolved lazily if omitted).
 * @property {(o: object) => any} [spawnImpl]   Injectable spawn (tests).
 * @property {{info(m:string):void,warn(m:string):void,error(m:string):void}} [logger]
 * @property {"chorus"|"yolo"} [permissionMode]  Maps to a Kiro tool-trust posture.
 * @property {{ url: string, apiKey: string }} [creds] Daemon credentials exported
 *   into the child env for plugin hooks, shell tooling, and MCP authentication.
 * @property {NodeJS.Platform} [platform]  Injectable for tests; gates POSIX `detached`.
 * @property {(anchor: string) => string|null} [getSessionIdFn]  Injectable session-map read.
 * @property {(o: {sessionId: string, cwd: string, onMessage?: Function, stdout: string, logger: any}) => void} [reconstructTranscript]
 *   Injectable transcript reconstruction (task 4) — invoked post-run; a no-op if absent.
 */

export class KiroSpawner {
  /** @param {KiroSpawnerOptions} [opts] */
  constructor(opts = {}) {
    /** Backend source for generic reporting of exceptions before child launch. */
    this.wakeErrorSource = "kiro";
    this.sessionDecision = { probeIsAuthoritative: false };
    this.kiroPath = opts.kiroPath ?? null;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.permissionMode = opts.permissionMode ?? "chorus";
    this.creds = opts.creds ?? null;
    this.platform = opts.platform ?? process.platform;
    this.cliConfig = validateAgentCliConfig(opts.cliConfig, "kiro", opts.label);
    this.env = overlayAgentEnv(opts.env ?? process.env, this.cliConfig.env, this.platform);
    this.getSessionIdFn = opts.getSessionIdFn ?? defaultGetSessionId;
    this.verifySessionOwnershipFn = opts.verifySessionOwnershipFn ?? (() => false);
    this.resolveKiroPathFn = opts.resolveKiroPathFn ?? resolveKiroPath;
    // Post-run transcript reconstruction from Kiro's on-disk session store (task 4).
    // Defaults to the real reader; injectable/nullable for tests.
    this.reconstructTranscript =
      opts.reconstructTranscript === undefined ? defaultReconstructTranscript : opts.reconstructTranscript;
  }

  /**
   * @param {{ prompt: string, sessionId: string|null, isNew?: boolean, mcpConfigPath?: string,
   *           cwd?: string, onMessage?: (obj: any) => void,
   *           onChild?: (child: import("node:child_process").ChildProcess) => void }} params
   * @returns {Promise<{ sessionId: string, exitCode: number|null, isNew: boolean }>}
   */
  async wake(params) {
    const diagnostics = createWakeErrorCollector({ source: this.wakeErrorSource, env: this.env, creds: this.creds });
    const startupResult = { sessionId: typeof params.sessionId === "string" ? params.sessionId : "", backendSessionId: null, exitCode: null, isNew: true };
    try {
      return await this.#wake(params, diagnostics, startupResult);
    } catch (error) {
      diagnostics.fail(error, "startup");
      return { ...startupResult, wakeError: diagnostics.build() };
    }
  }

  async #wake({ prompt, sessionId, cwd, onMessage, onChild }, diagnostics, startupResult) {
    const anchor = typeof sessionId === "string" ? sessionId : "";
    const sessionKey = backendSessionKey(anchor, this.creds?.agentUuid);
    const runCwd = cwd ?? process.cwd();

    const candidateSessionId = sessionKey ? this.getSessionIdFn(sessionKey) : null;
    let knownSessionId = null;
    if (typeof candidateSessionId === "string" && candidateSessionId) {
      try {
        if (anchor && this.creds?.agentUuid && this.verifySessionOwnershipFn({
          agentUuid: this.creds.agentUuid,
          anchor,
          sessionKey,
          sessionId: candidateSessionId,
          cwd: runCwd,
          dir: kiroSessionsDir(this.env, this.platform),
        }) === true) knownSessionId = candidateSessionId;
      } catch (error) {
        this.logger.warn(`[Chorus] Kiro session ownership verification failed; refusing resume: ${error}`);
      }
      if (!knownSessionId) {
        this.logger.warn(`[Chorus] Kiro session mapping has unverified ownership (including older agent-scoped captures); refusing automatic resume/reconstruction. Entry preserved; native manual resume handle: ${JSON.stringify(candidateSessionId)} (kiro-cli chat --resume-id).`);
      }
    }
    if (!knownSessionId && sessionKey !== anchor) {
      const legacySessionId = this.getSessionIdFn(anchor);
      if (legacySessionId) {
        this.logger.warn(`[Chorus] Kiro legacy session mapping has unknown ownership; starting a new isolated session without copying old context. Legacy entry preserved; native manual resume handle: ${JSON.stringify(legacySessionId)} (kiro-cli chat --resume-id).`);
      }
    }
    const isNew = !knownSessionId;
    startupResult.isNew = isNew;

    const kiroPath = this.kiroPath ?? this.resolveKiroPathFn({ env: this.env, platform: this.platform });
    if (!kiroPath) {
      // No crash — surface visibly and resolve with a failure result.
      this.logger.error("[Chorus] cannot locate the `kiro-cli` executable on PATH; skipping wake");
      return { sessionId: anchor, backendSessionId: null, exitCode: null, isNew,
        wakeError: diagnostics.build({ kind: "startup", message: "Cannot locate kiro-cli executable; check installation and PATH" }) };
    }

    assertConfiguredShimArgs(kiroPath, this.cliConfig.args, this.platform);
    const args = [...buildKiroArgs({ isNew, sessionId: knownSessionId, permissionMode: this.permissionMode }), ...this.cliConfig.args];
    const { command, argv } = resolveSpawnCommand(kiroPath, args, this.platform, this.env);

    // POSIX: detached process group so the interrupt path can group-kill the tree
    // (kiro-cli forks child shells for tools). Windows uses taskkill /T. stdio
    // stays piped — prompt over stdin + stdout capture are unaffected.
    const detached = this.platform !== "win32";

    // Export the daemon's authoritative connection pair. CHORUS_API_KEY is also
    // referenced by the plugin's MCP config; neither value is placed in argv.
    const childEnv = { ...this.env, CHORUS_DAEMON_HEADLESS: "1" };
    if (this.creds) {
      if (this.creds.url) childEnv.CHORUS_URL = this.creds.url;
      if (this.creds.apiKey) childEnv.CHORUS_API_KEY = this.creds.apiKey;
      // Identity profile for the woken session — its hooks/skills pass this to
      // `chorus mcp --agent`, which resolves the key from ~/.chorus/daemon.json.
      if (this.creds.agentUuid || this.creds.agentName)
        childEnv.CHORUS_AGENT_PROFILE = this.creds.agentUuid || this.creds.agentName;
    }

    if (isNew) {
      this.logger.warn("[Chorus] Kiro native session ownership is unavailable; shared-store changes (even a singleton) cannot identify this process. No session capture or store reconstruction; using this process's stdout only. Next wake starts fresh unless ownership is independently verified.");
    }

    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnImpl(command, argv, {
          cwd: runCwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: childEnv,
          shell: false,
          detached,
          windowsHide: true,
        });
      } catch (error) {
        this.logger.error(`[Chorus] failed to spawn kiro-cli: ${safeSpawnError(error)}`);
        resolve({ sessionId: anchor, backendSessionId: null, exitCode: null, isNew,
          wakeError: diagnostics.build({ kind: "startup", message: `Cannot spawn kiro-cli: ${safeSpawnError(error)}` }) });
        return;
      }

      diagnostics.observeChild(child);
      // Hand the live child to the caller (interrupt registry) before resolving.
      // Never let a throwing callback escape into the spawn path.
      if (onChild) {
        try {
          onChild(child);
        } catch (err) {
          this.logger.warn(`[Chorus] onChild handler threw: ${err}`);
        }
      }

      let stdoutBuf = "";

      child.stdout?.setEncoding?.("utf8");
      child.stdout?.on("data", (chunk) => {
        stdoutBuf += String(chunk);
      });

      child.stderr?.setEncoding?.("utf8");
      child.stderr?.on("data", (chunk) => {
        diagnostics.appendStderr(chunk);
        const text = String(chunk).trim();
        if (text) this.logger.warn(`[Chorus] kiro-cli stderr: ${text}`);
      });

      child.on("error", (error) => {
        this.logger.error(`[Chorus] kiro-cli process error: ${safeSpawnError(error)}`);
        resolve({ sessionId: knownSessionId || anchor, backendSessionId: knownSessionId || null, exitCode: null, isNew,
          wakeError: diagnostics.build({ kind: "startup", message: `Kiro process error: ${safeSpawnError(error)}` }) });
      });

      // Settle on process exit, not only on stdio close: a detached descendant can
      // inherit the pipes and keep `close` from ever firing (see cli/child-exit.mjs).
      awaitChildSettled(child, { logger: this.logger, label: "kiro-cli" }).then((rawCode) => {
        const code = rawCode === 0 && diagnostics.hasFailure ? 1 : rawCode;
        if (code !== 0) {
          this.logger.warn(`[Chorus] kiro-cli exited with code ${code}`);
        }

        const observedSessionId = knownSessionId;

        // Transcript reconstruction (task 4) — post-run, best-effort. Runs even
        // when no sessionId was captured: `kiro-cli chat --no-interactive` does NOT
        // persist a session to the cli store (verified live on 2.12.1 — only
        // interactive/TUI runs do), so the store path finds nothing and the
        // reconstructor falls back to the raw `stdout` blob (the authorized option-1
        // fallback). Gating this on `observedSessionId` would suppress that fallback
        // and leave headless turns with an empty transcript. Never throws into the
        // wake path (the reconstructor is also internally wrapped).
        if (this.reconstructTranscript) {
          try {
            this.reconstructTranscript({
              sessionId: observedSessionId ?? "",
              cwd: runCwd,
              dir: kiroSessionsDir(this.env, this.platform),
              onMessage,
              stdout: stdoutBuf,
              logger: this.logger,
            });
          } catch (err) {
            this.logger.warn(`[Chorus] kiro transcript reconstruction threw (ignored): ${err}`);
          }
        }

        const result = { sessionId: observedSessionId || anchor, backendSessionId: observedSessionId, exitCode: code, isNew };
        if (code !== 0) result.wakeError = diagnostics.build({ exitCode: rawCode });
        resolve(result);
      });

      // Guard against an ASYNC stdin error (EPIPE) so it never becomes an
      // uncaughtException that kills the daemon.
      child.stdin?.on?.("error", (err) => {
        this.logger.warn(`[Chorus] kiro-cli stdin error (ignored): ${err}`);
        diagnostics.failFallback("Kiro prompt delivery failed: stdin closed", "protocol");
      });

      // Feed the prompt over stdin, then close it so the model runs.
      try {
        if (typeof child.stdin?.write !== "function") throw new Error("Kiro prompt stdin is unavailable");
        child.stdin?.write(prompt);
        child.stdin?.end();
      } catch (err) {
        this.logger.warn(`[Chorus] failed writing prompt to kiro-cli stdin: ${err}`);
        diagnostics.failFallback("Kiro prompt could not be delivered over stdin", "protocol");
        try { child.stdin?.end?.(); } catch {}
      }
    });
  }
}
