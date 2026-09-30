// cli/pi-spawner.mjs
// Cross-platform headless pi spawner — the `pi` counterpart to ClaudeSpawner /
// CodexSpawner, satisfying the SAME backend-agnostic Spawner.wake(...) contract so
// the daemon's wake pipeline (queue, waker, directed delivery, headless guard,
// reporters) stays backend-neutral.
//
// Transport: pi's native RPC mode (`pi --mode rpc`), one process per wake
// (OpenSpec change switch-pi-daemon-to-rpc). Verified against the pi 0.85.1 package
// (docs/rpc.md, dist/modes/rpc/rpc-mode.js, dist/main.js, dist/core/agent-session.js)
// and live probes — NOT guessed:
//   • stdin carries JSONL commands (`get_state`, `prompt`, `abort`,
//     `extension_ui_response`); stdout carries `response` frames, `extension_ui_request`
//     frames and the same AgentSessionEvents JSON mode printed (no `session` header).
//   • stdin EOF makes RPC mode shut down immediately (even mid-run), so stdin stays
//     open until the run is settled. `agent_settled` is the only "nothing more will
//     run" signal (`agent_end` may be followed by retry/compaction). A `prompt`
//     response only means "accepted".
//   • Some accepted prompts start no run (an extension slash command, or an
//     extension `input` handler returning "handled"): no `agent_start` /
//     `agent_settled` follows. A normal run sets `isStreaming` synchronously before
//     pi can read our next line, so a follow-up `get_state` reporting
//     `isStreaming:false` with no `agent_start` seen means "handled, nothing to wait for".
//   • SESSION MODEL — client-owned id. `--session-id <anchor>` is create-or-resume in
//     the cwd-scoped session dir; an unparseable session file counts as absent (pi
//     then creates a new session with the same id). `get_state.messageCount` tells us
//     which happened. We NEVER pass `--no-session`.
//   • pi has NO permission system, so `permissionMode` is a NO-OP. Blocking extension
//     dialogs are cancelled immediately (headless: nobody can answer them).
//   • pi has no native MCP: a woken pi reaches Chorus tools only via the chorus-pi
//     extension, which consumes CHORUS_URL / CHORUS_API_KEY / CHORUS_AGENT_PROFILE.
//
// Reuses claude-spawner's LF-only NDJSON parser (parseNdjsonChunk — pi requires
// LF-only framing, i.e. NOT readline) and the shared stop-hook / settlement seams.

import { spawn, execFile } from "node:child_process";
import { safeSpawnError } from "./launch-diagnostics.mjs";
import { validateAgentCliConfig, overlayAgentEnv, getAgentEnv, assertConfiguredShimArgs } from "./agent-cli-config.mjs";
import { statSync, readdirSync } from "node:fs";
import { win32 as pathWin32, posix as pathPosix } from "node:path";
import { parseNdjsonChunk } from "./claude-spawner.mjs";
import { awaitChildSettled } from "./child-exit.mjs";
import { registerProcessStopHook } from "./process-stop-hooks.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/** Oldest pi release the RPC wake path is verified against (owner decision q8). */
export const MIN_PI_VERSION = "0.85.0";

/** Upgrade command shown when the installed pi is too old. */
export const PI_UPGRADE_COMMAND = "npm install -g @earendil-works/pi-coding-agent@latest";

/** Transcript notice when pi could not restore an anchor's earlier session. */
export const PI_CONTINUITY_NOTICE =
  "Previous Pi history could not be restored; continuing in a new Pi session with Chorus context.";

/** Extension UI methods that block until the client answers. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// Request ids the spawner correlates responses by. One of each per wake.
const ID_STATE = "chorus-state-1";
const ID_PROMPT = "chorus-prompt-1";
const ID_IDLE_CHECK = "chorus-state-2";
const ID_ABORT = "chorus-abort-1";

/**
 * Build the argv for a headless pi RPC run. The prompt is NEVER here — it goes over
 * stdin as a `prompt` command. `--session-id <anchor>` is pi's create-or-resume flag,
 * so the SAME args serve the first wake and every resume.
 *
 * @param {{ sessionId: string }} o
 * @returns {string[]}
 */
export function buildPiArgs({ sessionId }) {
  return ["--mode", "rpc", "--session-id", sessionId];
}

/**
 * Parse the first `x.y.z` out of `pi --version` output.
 * @param {unknown} text @returns {[number, number, number] | null}
 */
export function parsePiVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** @param {[number,number,number]} a @param {[number,number,number]} b */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Default `pi --version` probe. Resolves the raw stdout, or rejects on failure.
 * @param {{ command: string, argv: string[], env: NodeJS.ProcessEnv }} o
 * @returns {Promise<string>}
 */
function defaultVersionProbe({ command, argv, env }) {
  return new Promise((resolve, reject) => {
    execFile(command, argv, { env, shell: false, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

/**
 * Resolve the real `pi` executable WITHOUT a shell — same approach as
 * resolveClaudePath / resolveCodexPath. On Windows the bin may be `pi.cmd` (npm
 * shim), which `spawn` can't exec directly without shell:true; we walk PATH for the
 * platform candidates. `CHORUS_PI_PATH` overrides.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, isFile?: (p: string) => boolean }} [deps]
 * @returns {string | null}
 */
export function resolvePiPath(deps = {}) {
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

  const override = getAgentEnv(env, "CHORUS_PI_PATH", platform);
  if (override && isFile(override)) {
    return override;
  }

  const isWin = platform === "win32";
  const p = isWin ? pathWin32 : pathPosix;
  const names = isWin ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
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
 * not a PE executable, so it must run via `cmd.exe /d /s /c <path> ...args`; we keep
 * shell:false and pass argv as an array (no shell word-splitting/injection).
 * @param {string} piPath @param {string[]} args
 * @param {NodeJS.Platform} [platform] @param {NodeJS.ProcessEnv} [env]
 * @returns {{ command: string, argv: string[] }}
 */
export function resolveSpawnCommand(piPath, args, platform = process.platform, env = process.env) {
  const isWin = platform === "win32";
  const lower = piPath.toLowerCase();
  if (isWin && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    const comspec = getAgentEnv(env, "COMSPEC", platform) || "cmd.exe";
    return { command: comspec, argv: ["/d", "/s", "/c", piPath, ...args] };
  }
  return { command: piPath, argv: args };
}


/**
 * Per-wake stdin side of the pi RPC protocol: safe JSONL writes, the one stdin
 * close, correlation of our own command responses, extension-dialog answers, the
 * continuity check and the protocol stop. Kept as its own unit so the stop hook
 * builds on the same write/close/settled state (mirrors ClaudeControlChannel).
 */
export class PiRpcChannel {
  /**
   * @param {{ stdin: any, logger: {info(m:string):void,warn(m:string):void,error(m:string):void},
   *           prompt: string, anchor: string, isNew: boolean, platform?: NodeJS.Platform,
   *           forward?: (obj: any) => void, readdirImpl?: (dir: string) => string[] }} o
   */
  constructor({ stdin, logger, prompt, anchor, isNew, platform = process.platform, forward, readdirImpl }) {
    this.stdin = stdin ?? null;
    this.logger = logger;
    this.prompt = prompt;
    this.anchor = anchor;
    this.platform = platform;
    this.forward = forward ?? (() => {});
    this.readdirImpl = readdirImpl ?? ((dir) => readdirSync(dir));
    /** Result `isNew`: the caller's value until get_state says otherwise. */
    this.isNew = Boolean(isNew);
    /** True once we called end() (or the child is gone and stdin is unusable). */
    this.stdinClosed = false;
    /** True once the child exited or errored. */
    this.exited = false;
    /** True once the `prompt` command was written (a run may be in progress). */
    this.promptSent = false;
    /** True once `agent_start` / `agent_settled` were seen after the prompt. */
    this.agentStarted = false;
    this.settled = false;
    /** True when the prompt was rejected or could not be delivered (D6). */
    this.failed = false;
    /** True when a protocol stop cut the wake short (before or during the run). */
    this.cancelled = false;
  }

  /** In-flight protocol stop (shared by repeated stop-hook invocations). */
  #stopWork = null;
  /** Resolver for the pending abort wait, or null. */
  #abortWait = null;

  /** @returns {boolean} whether stdin can still take a write. */
  get writable() {
    const s = this.stdin;
    if (this.stdinClosed || !s || typeof s.write !== "function") return false;
    if (s.destroyed || s.writableEnded || s.writable === false) return false;
    return true;
  }

  /**
   * Write one JSONL command. Never throws: a closed/destroyed stdin or a
   * synchronous write error is logged and reported as `false` (async EPIPE is
   * caught by the stdin 'error' listener the spawner installs).
   * @param {object} frame @param {string} what  Log label.
   * @returns {boolean}
   */
  write(frame, what) {
    if (!this.writable) {
      this.logger.warn(`[Chorus] pi stdin is closed; dropped ${what}`);
      return false;
    }
    try {
      this.stdin.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch (err) {
      this.logger.warn(`[Chorus] failed writing ${what} to pi stdin: ${err}`);
      return false;
    }
  }

  /** Open the exchange: ask for the session state before sending the prompt. */
  start() {
    // A stop that already started (from inside onChild) owns the outcome.
    if (!this.write({ id: ID_STATE, type: "get_state" }, "get_state") && !this.#stopWork) this.failed = true;
  }

  /**
   * Write the wake's single prompt, unless a protocol stop already started (the
   * waker's cancel-before-spawn branch stops the child from inside `onChild`, or
   * an interrupt can land while get_state is in flight). A cancelled wake must
   * never deliver its prompt.
   */
  #sendPrompt() {
    if (this.#stopWork) {
      this.logger.info("[Chorus] pi stop started before the prompt was written; prompt not delivered");
      return;
    }
    this.promptSent = this.write({ id: ID_PROMPT, type: "prompt", message: this.prompt }, "prompt");
    if (!this.promptSent) this.failed = true;
  }

  /** Close stdin once; idempotent and never throws. pi exits on EOF. */
  closeStdin() {
    if (this.stdinClosed) return;
    this.stdinClosed = true;
    const s = this.stdin;
    if (!s || typeof s.end !== "function" || s.destroyed || s.writableEnded) return;
    try {
      s.end();
    } catch (err) {
      this.logger.warn(`[Chorus] failed closing pi stdin: ${err}`);
    }
  }

  /** Normal completion closes stdin — unless a stop owns the close (beforeClose first). */
  #finish() {
    if (!this.#stopWork) this.closeStdin();
  }

  /** The child is gone or its stdin errored (EPIPE): no further writes. */
  markStdinUnusable() {
    this.stdinClosed = true;
  }

  /** The child exited or errored: stdin is unusable and a pending abort wait ends. */
  markExited() {
    this.exited = true;
    this.markStdinUnusable();
    this.#endAbortWait();
  }

  #endAbortWait() {
    const wait = this.#abortWait;
    this.#abortWait = null;
    wait?.();
  }

  /**
   * Protocol stop (design D4), invoked by the process killer through the stop hook.
   * Repeated calls share one promise.
   *  1. If the prompt was sent, the run has not settled and stdin is open: write ONE
   *     `abort` and wait for the first of agent_settled, the abort response, child
   *     exit, or the killer's `protocolDeadline` (the killer's own deadline — no
   *     other duration exists here, #569).
   *  2. On EVERY path: await `beforeClose` (Windows tree-identity capture needs the
   *     root alive), logging a failure without skipping step 3.
   *  3. Close stdin; pi exits on EOF.
   * @param {{ protocolDeadline: number, beforeClose?: () => unknown }} o
   * @returns {Promise<void>}
   */
  stop({ protocolDeadline, beforeClose }) {
    if (this.#stopWork) return this.#stopWork;
    // pi exits 0 on the EOF that ends a stop, so remember that this wake was cut
    // short: a run that had not settled (or never started) is not a clean finish.
    this.cancelled = !this.settled && !this.stdinClosed;
    this.#stopWork = (async () => {
      try {
        if (this.promptSent && !this.settled && !this.stdinClosed) {
          const outcome = new Promise((resolve) => { this.#abortWait = resolve; });
          if (this.write({ id: ID_ABORT, type: "abort" }, "abort")) {
            this.logger.info("[Chorus] interrupt: sent pi abort");
            let timer;
            try {
              await Promise.race([
                outcome,
                // The killer-supplied protocol deadline — not a new timeout.
                new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, protocolDeadline - Date.now())); }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          }
          this.#abortWait = null;
        }
      } finally {
        try {
          await beforeClose?.();
        } catch (err) {
          this.logger.warn(`[Chorus] pi stop: beforeClose failed (continuing to close stdin): ${err}`);
        }
        this.closeStdin();
      }
    })();
    return this.#stopWork;
  }

  /**
   * Observe one stdout frame. Returns true when the frame is protocol plumbing the
   * spawner consumed (so it must NOT be forwarded to `onMessage`).
   * @param {any} frame
   * @returns {boolean} consumed
   */
  handleFrame(frame) {
    const type = frame && typeof frame === "object" ? frame.type : undefined;
    if (type === "response") {
      this.#onResponse(frame);
      return true;
    }
    if (type === "extension_ui_request") {
      this.#onExtensionUiRequest(frame);
      return true;
    }
    if (type === "agent_start" && this.promptSent) this.agentStarted = true;
    if (type === "agent_settled" && this.promptSent && !this.settled) {
      this.settled = true;
      this.#finish();
      this.#endAbortWait();
    }
    if (type === "extension_error") {
      this.logger.warn(`[Chorus] pi extension error (${String(frame.event)}): ${String(frame.error)}`);
    }
    return false;
  }

  #onResponse(frame) {
    const ok = frame.success === true;
    switch (frame.id) {
      case ID_STATE:
        if (ok && frame.data && typeof frame.data === "object") this.#onInitialState(frame.data);
        else this.logger.warn(`[Chorus] pi get_state failed (continuity unknown): ${String(frame.error)}`);
        this.#sendPrompt();
        return;
      case ID_PROMPT:
        if (ok) {
          // Accepted is not done: check whether a run actually started (design D2 step 5).
          // A very short run can settle before this response is read; nothing to check then.
          if (this.settled) return;
          this.write({ id: ID_IDLE_CHECK, type: "get_state" }, "get_state (idle check)");
          return;
        }
        this.logger.error(`[Chorus] pi rejected the prompt: ${String(frame.error)}`);
        this.failed = true;
        this.#finish();
        return;
      case ID_IDLE_CHECK:
        if (!ok || !frame.data || typeof frame.data !== "object") {
          this.logger.warn(`[Chorus] pi idle check failed (waiting for agent_settled): ${String(frame.error)}`);
          return;
        }
        if (frame.data.isStreaming === false && !this.agentStarted && !this.settled) {
          this.logger.info("[Chorus] pi handled the prompt without an agent run");
          this.#finish();
        }
        return;
      case ID_ABORT:
        if (!ok) this.logger.warn(`[Chorus] pi rejected abort: ${String(frame.error)}`);
        this.#endAbortWait();
        return;
      default:
        if (!ok) this.logger.warn(`[Chorus] pi ${String(frame.command)} command failed: ${String(frame.error)}`);
    }
  }

  /** Cancel blocking dialogs at once; fire-and-forget requests need no reply. */
  #onExtensionUiRequest(frame) {
    const method = String(frame.method);
    if (!DIALOG_METHODS.has(method)) return;
    if (typeof frame.id !== "string" || !frame.id) {
      this.logger.warn(`[Chorus] pi extension ${method} dialog has no id; not answered`);
      return;
    }
    // Method only — the title/message/options are extension-controlled text.
    this.logger.warn(`[Chorus] cancelled pi extension ${method} dialog (headless daemon)`);
    this.write({ type: "extension_ui_response", id: frame.id, cancelled: true }, `extension ${method} cancel`);
  }

  /** get_state before the prompt: truthful isNew plus the lost-history notice (D5). */
  #onInitialState(data) {
    if (typeof data.messageCount !== "number") return;
    this.isNew = data.messageCount === 0;
    if (this.isNew && this.#historyWasLost(data.sessionFile)) {
      this.logger.warn(`[Chorus] ${PI_CONTINUITY_NOTICE} Session: ${this.anchor}.`);
      this.forward({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: PI_CONTINUITY_NOTICE }] } });
    }
  }

  /**
   * A new session whose directory already holds another `<timestamp>_<anchor>.jsonl`
   * means pi could not restore that file. Only a notice depends on this: a listing
   * error is logged and treated as "no evidence".
   * @param {unknown} sessionFile
   */
  #historyWasLost(sessionFile) {
    if (!UUID_RE.test(this.anchor) || typeof sessionFile !== "string" || !sessionFile) return false;
    const p = this.platform === "win32" ? pathWin32 : pathPosix;
    const dir = p.dirname(sessionFile);
    const own = p.basename(sessionFile);
    const suffix = `_${this.anchor}.jsonl`;
    try {
      return this.readdirImpl(dir).some((name) => name !== own && String(name).toLowerCase().endsWith(suffix.toLowerCase()));
    } catch (err) {
      this.logger.warn(`[Chorus] could not inspect pi session dir for continuity: ${err?.code ?? err}`);
      return false;
    }
  }
}

/**
 * @typedef {Object} PiSpawnerOptions
 * @property {string} [piPath]   Resolved pi path (resolved lazily if omitted).
 * @property {(o: object) => any} [spawnImpl]   Injectable spawn (tests).
 * @property {{info(m:string):void,warn(m:string):void,error(m:string):void}} [logger]
 * @property {"chorus"|"yolo"} [permissionMode]  Accepted for a uniform selectSpawner
 *   call, but a NO-OP: pi has no permission system, so no flag is emitted either way.
 * @property {{ url: string, apiKey: string, agentUuid?: string, agentName?: string }} [creds]
 *   Daemon creds exported into the child env for the chorus-pi extension's MCP-over-HTTP
 *   tooling and SessionStart bookkeeping.
 * @property {NodeJS.Platform} [platform]  Injectable for tests; gates POSIX `detached`.
 * @property {(deps?: object) => (string|null)} [resolvePiPathFn]  Injectable resolver.
 * @property {(o: { command: string, argv: string[], env: NodeJS.ProcessEnv }) => Promise<string>} [versionProbeFn]
 *   Injectable `pi --version` probe (resolves stdout, rejects on failure).
 * @property {(dir: string) => string[]} [readdirImpl]  Injectable session-dir listing.
 */

export class PiSpawner {
  /** @param {PiSpawnerOptions} [opts] */
  constructor(opts = {}) {
    // pi manages new-vs-resume internally (the `--session-id` anchor is
    // create-or-resume), so the daemon's shared Claude transcript probe is NOT
    // authoritative for pi. The waker then logs the spawner's own isNew instead of
    // the Claude-specific "take over with `claude --resume`" line.
    this.sessionDecision = { probeIsAuthoritative: false };
    this.piPath = opts.piPath ?? null;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.logger = opts.logger ?? NOOP_LOGGER;
    // Stored for a uniform construction shape, but never consulted when building
    // args — pi has no permission surface, so no sandbox / skip-permissions flag.
    this.permissionMode = opts.permissionMode ?? "chorus";
    this.creds = opts.creds ?? null;
    this.platform = opts.platform ?? process.platform;
    this.cliConfig = validateAgentCliConfig(opts.cliConfig, "pi", opts.label);
    this.env = overlayAgentEnv(opts.env ?? process.env, this.cliConfig.env, this.platform);
    this.resolvePiPathFn = opts.resolvePiPathFn ?? resolvePiPath;
    this.versionProbeFn = opts.versionProbeFn ?? defaultVersionProbe;
    this.readdirImpl = opts.readdirImpl;
    /** @type {Map<string, Promise<boolean>>} resolved path → "may wake" */
    this.versionChecks = new Map();
  }

  /**
   * Version gate (design D7): read `pi --version` once per resolved executable. Too
   * old → visible error and no wake; an unreadable version never blocks a wake.
   * @param {string} piPath @returns {Promise<boolean>} whether the wake may proceed
   */
  checkVersion(piPath) {
    let check = this.versionChecks.get(piPath);
    if (!check) {
      const { command, argv } = resolveSpawnCommand(piPath, ["--version"], this.platform, this.env);
      check = Promise.resolve()
        .then(() => this.versionProbeFn({ command, argv, env: this.env }))
        .then(
          (out) => {
            const found = parsePiVersion(out);
            if (!found) {
              this.logger.warn(`[Chorus] could not read the pi version from \`pi --version\`; continuing (RPC wakes need pi >= ${MIN_PI_VERSION})`);
              return true;
            }
            if (compareVersions(found, parsePiVersion(MIN_PI_VERSION)) < 0) {
              this.logger.error(
                `[Chorus] pi ${found.join(".")} is too old for RPC daemon wakes (need >= ${MIN_PI_VERSION}). Upgrade: ${PI_UPGRADE_COMMAND}`
              );
              return false;
            }
            return true;
          },
          (err) => {
            this.logger.warn(`[Chorus] \`pi --version\` failed (${safeSpawnError(err)}); continuing (RPC wakes need pi >= ${MIN_PI_VERSION})`);
            return true;
          }
        );
      this.versionChecks.set(piPath, check);
    }
    return check;
  }

  /**
   * Run one headless pi RPC wake. Resolves when the subprocess exits. The prompt is
   * sent as the `prompt` command (never argv). `sessionId` is the Chorus anchor,
   * passed straight through as pi's client-owned `--session-id`; the result's
   * `isNew` comes from pi's own `get_state` (the passed value is only a fallback).
   *
   * @param {{ prompt: string, sessionId: string|null, isNew?: boolean, cwd?: string,
   *           onMessage?: (obj: any) => void,
   *           onChild?: (child: import("node:child_process").ChildProcess) => void }} params
   * @returns {Promise<{ sessionId: string, backendSessionId: string|null, exitCode: number|null, isNew: boolean }>}
   *   `backendSessionId` is the resumable anchor after a spawn; `null` on the
   *   pre-spawn failure paths (no run started, nothing to resume).
   */
  async wake({ prompt, sessionId, isNew, cwd, onMessage, onChild }) {
    const anchor = typeof sessionId === "string" ? sessionId : "";
    const isNewFlag = Boolean(isNew);

    const piPath = this.piPath ?? this.resolvePiPathFn({ env: this.env, platform: this.platform });
    if (!piPath) {
      // No crash — surface visibly and resolve with a failure result (matches the
      // other spawners' "skipping wake" convention: exitCode null, no throw).
      this.logger.error("[Chorus] cannot locate the `pi` executable on PATH; skipping wake");
      return { sessionId: anchor, backendSessionId: null, exitCode: null, isNew: isNewFlag };
    }

    assertConfiguredShimArgs(piPath, this.cliConfig.args, this.platform);
    if (!(await this.checkVersion(piPath))) {
      return { sessionId: anchor, backendSessionId: null, exitCode: null, isNew: isNewFlag };
    }
    const args = [...buildPiArgs({ sessionId: anchor }), ...this.cliConfig.args];
    const { command, argv } = resolveSpawnCommand(piPath, args, this.platform, this.env);

    // POSIX: detached process group so the interrupt path can group-kill the tree
    // (pi may fork child shells / subagents). Windows uses taskkill /T. stdio stays
    // piped — JSONL commands over stdin + JSONL stdout parse are unaffected.
    const detached = this.platform !== "win32";

    // Export the daemon's resolved connection pair for the chorus-pi extension's
    // Chorus tooling. Explicitly overwrite inherited values so the extension and the
    // daemon cannot disagree about which Chorus instance this wake belongs to.
    const childEnv = { ...this.env, CHORUS_DAEMON_HEADLESS: "1" };
    if (this.creds) {
      if (this.creds.url) childEnv.CHORUS_URL = this.creds.url;
      if (this.creds.apiKey) childEnv.CHORUS_API_KEY = this.creds.apiKey;
      // Identity profile for the woken session — its extension/skills pass this to
      // `chorus mcp --agent`, which resolves the key from ~/.chorus/daemon.json.
      if (this.creds.agentUuid || this.creds.agentName)
        childEnv.CHORUS_AGENT_PROFILE = this.creds.agentUuid || this.creds.agentName;
    }

    const forward = (obj) => {
      if (!onMessage) return;
      try {
        onMessage(obj);
      } catch (err) {
        this.logger.warn(`[Chorus] onMessage handler threw: ${err}`);
      }
    };

    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnImpl(command, argv, {
          cwd: cwd ?? process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
          env: childEnv,
          shell: false,
          detached,
          windowsHide: true,
        });
      } catch (error) {
        this.logger.error(`[Chorus] failed to spawn pi: ${safeSpawnError(error)}`);
        resolve({ sessionId: anchor, backendSessionId: null, exitCode: null, isNew: isNewFlag });
        return;
      }

      const channel = new PiRpcChannel({
        stdin: child.stdin, logger: this.logger, prompt, anchor, isNew: isNewFlag,
        platform: this.platform, forward, readdirImpl: this.readdirImpl,
      });
      // Protocol interrupt (design D4): the shared killer calls this instead of
      // SIGINT and then force-cleans within the same deadline if the child remains.
      // Registered before onChild so an interrupt can never see an unhooked child.
      const unregisterStopHook = registerProcessStopHook(child, ({ deadline, protocolDeadline = deadline, beforeClose }) =>
        channel.stop({ protocolDeadline, beforeClose })
      );

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
        stdoutBuf = parseNdjsonChunk(
          stdoutBuf,
          String(chunk),
          (obj) => {
            if (channel.handleFrame(obj)) return; // RPC plumbing — never forwarded
            forward(obj);
          },
          (msg) => this.logger.warn(`[Chorus] ${msg}`)
        );
      });

      child.stderr?.setEncoding?.("utf8");
      child.stderr?.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (text) this.logger.warn(`[Chorus] pi stderr: ${text}`);
      });

      child.on("error", (error) => {
        this.logger.error(`[Chorus] pi process error: ${safeSpawnError(error)}`);
        channel.markExited();
        unregisterStopHook();
        resolve({ sessionId: anchor, backendSessionId: anchor || null, exitCode: null, isNew: channel.isNew });
      });

      // A dead child's stdin must never be written again (late dialog answers).
      child.on?.("exit", () => channel.markExited());

      // Settle on process exit, not only on stdio close: a detached descendant can
      // inherit the pipes and keep `close` from ever firing (see cli/child-exit.mjs).
      awaitChildSettled(child, { logger: this.logger, label: "pi" }).then((raw) => {
        channel.markExited();
        unregisterStopHook();
        // pi RPC exits 0 on stdin EOF, so neither a cancelled wake (130, like the Codex
        // backend) nor a rejected/undelivered prompt (1) may read as a clean finish
        // (design D6) — the waker records a clean exit as an `ended` turn. A non-zero
        // raw code is always kept.
        const code = raw !== 0 ? raw : channel.cancelled ? 130 : channel.failed ? 1 : 0;
        if (code !== 0) {
          this.logger.warn(`[Chorus] pi exited with code ${code}`);
        }
        resolve({ sessionId: anchor, backendSessionId: anchor || null, exitCode: code, isNew: channel.isNew });
      });

      // Guard against an ASYNC stdin error (EPIPE) so it never becomes an
      // uncaughtException that kills the daemon.
      child.stdin?.on?.("error", (err) => {
        this.logger.warn(`[Chorus] pi stdin error (ignored): ${err}`);
        channel.markStdinUnusable();
      });

      // get_state first; its response sends the one prompt (skipped when a stop
      // already started, e.g. from inside onChild above). stdin stays open until
      // agent_settled, a handled-without-run idle check, or a rejected prompt.
      channel.start();
    });
  }
}
