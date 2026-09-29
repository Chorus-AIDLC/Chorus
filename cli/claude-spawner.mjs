// cli/claude-spawner.mjs
// Cross-platform headless Claude Code spawner. This is the load-bearing
// engineering point of the daemon: parsing stream-json is plain JS and
// platform-neutral; the real work is spawning, and it is all Windows.
//
// Verified against Claude Code CLI 2.1.283 (stream-json transport; frames pinned
// by cli/__tests__/fixtures/claude-stream-json/). Earlier facts first verified on
// 2.1.251 still hold:
//   • `-p/--print` + `--input-format stream-json --output-format stream-json`
//     is the bidirectional NDJSON protocol the Agent SDK's "Streaming Input Mode"
//     runs on. It is documented only at the SDK level, so the exact frames the
//     daemon relies on are pinned by live-captured fixtures. The prompt goes in as
//     ONE `{"type":"user",...}` frame; stdin stays open for control frames and is
//     closed after the turn's first `result` frame, after which the CLI drains its
//     Stop hooks and exits (one process per wake, never reused).
//   • stdout frames of type `control_request` / `control_response` /
//     `control_cancel_request` are protocol plumbing: the spawner answers them and
//     never forwards them to `onMessage`. `--permission-prompt-tool stdio` routes
//     every non-allowlisted tool request to us as `control_request{can_use_tool}`,
//     which we deny explicitly.
//   • interrupt is `control_request{subtype:"interrupt"}`: the CLI acks it and
//     ends the turn with `result:error_during_execution`. The spawner sends it from
//     a process stop hook, so the shared killer's deadline bounds it (no SIGINT).
//   • every output line carries `session_id`.
//   • `--session-id <uuid>` sets the session id for a fresh run, and
//     `--resume <uuid>` continues it. So we GENERATE the session id client-side
//     and pass it in, rather than scraping it from the init event — the id is
//     authoritative on our side. We still read `session_id` from the stream as
//     confirmation.
//   • `--mcp-config <file>` loads MCP servers from a JSON file.
//
// The flag list lives in ONE place (buildArgs) so a CLI flag change is a
// single-line edit.
//
// HEADLESS SIGNAL (add-daemon-headless-interaction-guard): wake() spawns the child
// with CHORUS_DAEMON_HEADLESS=1 merged over the inherited env — a machine-checkable
// marker that this is a daemon-woken, no-human-at-the-terminal run. buildArgs adds
// no --append-system-prompt: the headless behavior rule is carried per-turn by the
// wake-prompt preamble in prompts.mjs, not at the system level. It does block
// AskUserQuestion at the tool layer (`--disallowedTools AskUserQuestion`), since no
// human can answer it in a daemon wake.

import { spawn } from "node:child_process";
import { safeSpawnError } from "./launch-diagnostics.mjs";
import { validateAgentCliConfig, overlayAgentEnv, getAgentEnv, assertConfiguredShimArgs } from "./agent-cli-config.mjs";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { win32 as pathWin32, posix as pathPosix, join as pathJoin } from "node:path";
import { awaitChildSettled } from "./child-exit.mjs";
import { registerProcessStopHook } from "./process-stop-hooks.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/** Matches a canonical lowercase UUID (any version). Chorus idea uuids are v4. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Backend-neutral failure classification consumed by the wake orchestrator. */
export const SESSION_CONFLICT_FAILURE = "session_conflict";

const STDERR_BUFFER_LIMIT = 64 * 1024;
const SESSION_CONFLICT_RE = /\bsession id\b[^\r\n]{0,200}\bis already in use\b/i;
const CLAUDE_PROJECT_KEY_CAP = 200;

/**
 * Claude Code 2.1.251's Java-style signed 32-bit string hash, rendered as the
 * absolute value in base36. Iterating by index intentionally hashes UTF-16 code
 * units (including each surrogate in an astral character) rather than code points.
 * @param {string} value
 * @returns {string}
 */
function projectKeyHash(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * True iff `id` is a well-formed, lowercase UUID. The daemon anchors the Claude
 * session id on a Chorus idea uuid (already lowercase v4); we validate before
 * spawn as a cheap guardrail so a malformed id surfaces visibly instead of
 * failing opaquely inside claude (no-silent-errors).
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidSessionId(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

/**
 * Claude Code's transcript directory for a working directory. Verified against
 * Claude Code 2.1.251's live Linux install and on-disk transcripts: every
 * non-ASCII-alphanumeric UTF-16 code unit becomes `-`. That includes separators,
 * dots, spaces, underscores, and non-ASCII characters; existing hyphens remain
 * byte-identical because replacing `-` with `-` is a no-op. Escaped keys longer
 * than 200 characters use the first 200 characters plus `-` and the base36
 * Java-style signed 32-bit hash of the original cwd. The same expression produces
 * the established Windows fixture, though the Windows on-disk layout remains
 * best-effort until verified on a Windows Claude installation.
 * @param {string} cwd  Absolute working directory.
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function escapeCwd(cwd, platform = process.platform) {
  // `platform` remains in the signature for fixture/API compatibility. Claude's
  // observed sanitizer is platform-independent; platform path syntax supplies
  // the differing separator/drive characters that this expression normalizes.
  void platform;
  const escaped = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (escaped.length <= CLAUDE_PROJECT_KEY_CAP) return escaped;
  return `${escaped.slice(0, CLAUDE_PROJECT_KEY_CAP)}-${projectKeyHash(cwd)}`;
}

/**
 * The on-disk transcript path for a session id under a given cwd:
 *   <configDir>/projects/<cwd-escaped>/<sessionId>.jsonl
 * `<configDir>` honors CLAUDE_CONFIG_DIR (falling back to ~/.claude), matching
 * Claude Code. Used to decide --session-id (absent) vs --resume (present).
 * @param {string} sessionId @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string }} [deps]
 * @returns {string}
 */
export function transcriptPath(sessionId, cwd, deps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const configDir = getAgentEnv(env, "CLAUDE_CONFIG_DIR", platform) || pathJoin(deps.home ?? getAgentEnv(env, "HOME", platform) ?? getAgentEnv(env, "USERPROFILE", platform) ?? homedir(), ".claude");
  return pathJoin(configDir, "projects", escapeCwd(cwd, platform), `${sessionId}.jsonl`);
}

/**
 * Decide whether a wake for `sessionId` in `cwd` is a NEW session (`--session-id`)
 * or a RESUME (`--resume`), by probing whether the transcript file already exists.
 * The disk is the source of truth `claude --resume` itself consults, so the probe
 * is stateless and survives daemon restarts. This layout is Claude Code-specific.
 * @param {string} sessionId @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string, exists?: (p: string) => boolean }} [deps]
 * @returns {boolean}  true → new session; false → resume an existing one.
 */
export function isNewSession(sessionId, cwd, deps = {}) {
  const exists = deps.exists ?? existsSync;
  return !exists(transcriptPath(sessionId, cwd, deps));
}

/**
 * Resolve the real `claude` executable path WITHOUT a shell. On Windows the bin
 * is `claude.cmd` (npm shim); `spawn("claude")` without `shell:true` throws
 * ENOENT because it won't resolve `.cmd`. We walk PATH for the platform's
 * candidate names and return the first that exists. `shell:true` is avoided
 * deliberately — it re-introduces the escaping/injection surface.
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, isFile?: (p: string) => boolean }} [deps]
 * @returns {string | null}
 */
export function resolveClaudePath(deps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const isFile =
    deps.isFile ??
    ((p) => {
      // isFile (not just exists): a directory named `claude` on PATH would
      // otherwise be "found" and then fail at spawn time.
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });

  // An explicit override always wins (set by the daemon if the user configured it).
  const override = getAgentEnv(env, "CHORUS_CLAUDE_PATH", platform);
  if (override && isFile(override)) {
    return override;
  }

  // Use platform-correct path semantics so the resolver is testable for
  // Windows from a POSIX host (`;` delimiter + `\` join vs `:` + `/`).
  const isWin = platform === "win32";
  const p = isWin ? pathWin32 : pathPosix;
  const names = isWin ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];
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
 * The MCP server name the daemon writes into --mcp-config (see mcp-config.mjs).
 * Claude namespaces its tools as `mcp__<serverName>__<tool>`, so this drives the
 * default allowlist below. Keep in sync with mcp-config.mjs's `mcpServers` key.
 */
export const CHORUS_MCP_SERVER_NAME = "chorus";

/**
 * Permission posture for the spawned headless Claude. Headless `claude -p`
 * auto-DENIES any tool that isn't pre-approved (there's no interactive prompt to
 * answer), so without one of these the woken agent can't call a single chorus_*
 * tool and exits having done nothing. Verified against Claude Code 2.1.177.
 *
 * - "chorus" (default): `--allowedTools "mcp__chorus__*"` — the woken agent may
 *   use Chorus MCP tools (comment, claim, report, status) but NOT Bash / file
 *   edits. Safe default: covers comment/assign/elaboration wakes out of the box,
 *   minimal blast radius.
 * - "yolo": `--dangerously-skip-permissions` — full autonomy (Bash, file writes,
 *   everything). Needed for real code-writing AI-DLC work. Dangerous: the woken
 *   agent gets a full shell under the daemon's key, with a prompt that embeds
 *   server-supplied strings. Use only in a trusted/sandboxed environment.
 * @typedef {"chorus"|"yolo"} PermissionMode
 */

/**
 * Build the argv for a headless run. Prompt is NEVER here — it goes over stdin as
 * a stream-json user frame.
 *
 * `--disallowedTools` is variadic, so it is emitted BEFORE the permission flags
 * (never last) and operator `cliConfig.args` are appended after this whole list by
 * the caller — nothing can be swallowed as an extra tool name.
 * `--permission-prompt-tool stdio` (chorus mode) makes the CLI ask us, over the
 * control protocol, about every tool outside the allowlist; the spawner denies it
 * explicitly and visibly instead of the CLI denying it silently.
 * @param {{ sessionId: string, isNew: boolean, mcpConfigPath?: string, permissionMode?: PermissionMode }} o
 * @returns {string[]}
 */
export function buildArgs({ sessionId, isNew, mcpConfigPath, permissionMode = "chorus" }) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  if (isNew) args.push("--session-id", sessionId);
  else args.push("--resume", sessionId);
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
  // Headless wakes have no human to answer AskUserQuestion — block it at the tool
  // layer in every mode (daemon-headless-interaction-guard).
  args.push("--disallowedTools", "AskUserQuestion");
  if (permissionMode === "yolo") {
    args.push("--dangerously-skip-permissions");
  } else {
    // Default: allow only this daemon's Chorus MCP tools through, and route every
    // other tool's permission request to the spawner (which denies it explicitly).
    args.push("--allowedTools", `mcp__${CHORUS_MCP_SERVER_NAME}__*`, "--permission-prompt-tool", "stdio");
  }
  return args;
}

/** stdout frame types the spawner consumes itself and never forwards to `onMessage`. */
export const CONTROL_FRAME_TYPES = new Set(["control_request", "control_response", "control_cancel_request"]);

/**
 * Model-facing message for a denied `can_use_tool` request. It reaches the model
 * as the tool_result of the blocked call (and is listed in result.permission_denials).
 */
export const CHORUS_TOOL_DENY_MESSAGE =
  "This tool is blocked by the Chorus daemon's --chorus-only permission policy: this headless " +
  "wake may only use Chorus MCP tools (mcp__chorus__*). Use the Chorus MCP tools to do the work, " +
  "or ask the human for what you need in a Chorus comment.";

/** Error text for any control request subtype the daemon does not implement. */
export const UNSUPPORTED_CONTROL_ERROR = "unsupported by Chorus daemon";

/**
 * The one stream-json user frame that carries the wake prompt.
 * @param {string} prompt
 */
export function buildUserFrame(prompt) {
  return { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null };
}

/**
 * Per-wake stdin side of the stream-json protocol: safe NDJSON writes, the one
 * stdin close, and answers to incoming control frames. Kept as its own unit so the
 * protocol interrupt (stop hook) can build on the same write/close/result state.
 */
export class ClaudeControlChannel {
  /**
   * @param {{ stdin: any, logger: {info(m:string):void,warn(m:string):void,error(m:string):void},
   *           permissionMode: PermissionMode }} o
   */
  constructor({ stdin, logger, permissionMode }) {
    this.stdin = stdin ?? null;
    this.logger = logger;
    this.permissionMode = permissionMode;
    /** True once the first `result` frame was observed. */
    this.resultSeen = false;
    /** True once we called end() (or the child is gone and stdin is unusable). */
    this.stdinClosed = false;
    /** True once the child exited or errored (no further protocol progress possible). */
    this.exited = false;
    /** True once the user prompt frame was written (a turn may be running). */
    this.promptSent = false;
  }

  /** In-flight protocol stop (shared by repeated stop-hook invocations). */
  #stopWork = null;
  /** Per-channel interrupt request counter → `chorus-interrupt-<n>`. */
  #interruptSeq = 0;
  /** Resolver for the pending interrupt wait: `{ requestId, resolve }` or null. */
  #interruptWait = null;

  /** @returns {boolean} whether stdin can still take a write. */
  get writable() {
    const s = this.stdin;
    if (this.stdinClosed || !s || typeof s.write !== "function") return false;
    if (s.destroyed || s.writableEnded || s.writable === false) return false;
    return true;
  }

  /**
   * Write one NDJSON frame. Never throws: a closed/destroyed stdin or a synchronous
   * write error is logged and reported as `false` (async EPIPE is caught by the
   * stdin 'error' listener the spawner installs).
   * @param {object} frame @param {string} what  Log label.
   * @returns {boolean}
   */
  write(frame, what) {
    if (!this.writable) {
      this.logger.warn(`[Chorus] claude stdin is closed; dropped ${what}`);
      return false;
    }
    try {
      this.stdin.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch (err) {
      this.logger.warn(`[Chorus] failed writing ${what} to claude stdin: ${err}`);
      return false;
    }
  }

  /**
   * Write the wake's single user prompt frame, unless a protocol stop has already
   * started (code-review B1). The waker's cancel-before-spawn branch calls the
   * killer from inside `onChild`, i.e. BEFORE `wake()` reaches this write; sending
   * the prompt after that would make the CLI run the whole cancelled turn (model
   * calls, Chorus MCP side effects) until the forced deadline. Chosen fix (a):
   * `#stopWork` is latched synchronously by `stop()`, so this check sees it, and
   * with no prompt sent `stop()` skips the interrupt and goes straight to
   * beforeClose → close stdin; the CLI then reads EOF with no input and exits
   * without starting a turn. (Writing the frame before `onChild` was rejected:
   * it would deliver the prompt a cancelled wake must never deliver.)
   * @param {object} frame @returns {boolean} whether the prompt was written.
   */
  sendPrompt(frame) {
    if (this.#stopWork) {
      this.logger.info("[Chorus] claude stop started before the prompt was written; prompt not delivered");
      return false;
    }
    this.promptSent = this.write(frame, "prompt");
    return this.promptSent;
  }

  /** Close stdin once; idempotent and never throws. */
  closeStdin() {
    if (this.stdinClosed) return;
    this.stdinClosed = true;
    const s = this.stdin;
    if (!s || typeof s.end !== "function" || s.destroyed || s.writableEnded) return;
    try {
      s.end();
    } catch (err) {
      this.logger.warn(`[Chorus] failed closing claude stdin: ${err}`);
    }
  }

  /** The child is gone or its stdin errored (EPIPE): no further writes may be attempted. */
  markStdinUnusable() {
    this.stdinClosed = true;
  }

  /** The child exited or errored: stdin is unusable and a pending interrupt wait ends. */
  markExited() {
    this.exited = true;
    this.markStdinUnusable();
    this.#endInterruptWait();
  }

  #endInterruptWait() {
    const wait = this.#interruptWait;
    this.#interruptWait = null;
    wait?.resolve();
  }

  /**
   * Protocol stop (design D4), invoked by the process killer through the
   * registered stop hook. Repeated calls share one promise.
   *  1. Unless the prompt was never written (nothing to interrupt — see
   *     sendPrompt), a result was already seen, or stdin is already closed, write ONE
   *     `interrupt` control_request and wait for the first of: a result frame, an
   *     error control_response for that request id, child exit, or the killer's
   *     `protocolDeadline`. The deadline is the killer's own (derived from the
   *     existing sigintTimeoutMs); no other duration exists here (#569).
   *  2. On EVERY path, including a skipped step 1: await `beforeClose` (the
   *     killer's Windows tree-identity capture, which needs the root alive and
   *     stdin open). A failure is logged and never skips step 3.
   *  3. Close stdin if it is still open.
   * @param {{ protocolDeadline: number, beforeClose?: () => unknown }} o
   * @returns {Promise<void>}
   */
  stop({ protocolDeadline, beforeClose }) {
    if (this.#stopWork) return this.#stopWork;
    this.#stopWork = (async () => {
      try {
        if (this.promptSent && !this.resultSeen && !this.stdinClosed) {
          const requestId = `chorus-interrupt-${++this.#interruptSeq}`;
          const outcome = new Promise((resolve) => { this.#interruptWait = { requestId, resolve }; });
          if (this.write({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } }, "interrupt request")) {
            this.logger.info(`[Chorus] interrupt: sent claude control_request ${requestId}`);
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
          this.#interruptWait = null;
        }
      } finally {
        try {
          await beforeClose?.();
        } catch (err) {
          this.logger.warn(`[Chorus] claude stop: beforeClose failed (continuing to close stdin): ${err}`);
        }
        this.closeStdin();
      }
    })();
    return this.#stopWork;
  }

  /**
   * Observe one stdout frame. Returns true when the frame is protocol plumbing the
   * spawner consumed (so it must NOT be forwarded to `onMessage`). A `result`
   * frame is forwarded, and closes stdin the first time one is seen.
   * @param {any} frame
   * @returns {boolean} consumed
   */
  handleFrame(frame) {
    const type = frame && typeof frame === "object" ? frame.type : undefined;
    if (type === "result") {
      if (!this.resultSeen) {
        this.resultSeen = true;
        // During a protocol stop the stop hook owns the close: it must await the
        // killer's beforeClose (Windows tree capture) BEFORE stdin closes.
        if (!this.#stopWork) this.closeStdin();
        this.#endInterruptWait();
      }
      return false;
    }
    if (!CONTROL_FRAME_TYPES.has(type)) return false;
    if (type === "control_request") this.#answerControlRequest(frame);
    else if (type === "control_response") this.#observeControlResponse(frame);
    // control_cancel_request: nothing pending on our side to cancel. All control
    // frames are consumed so the transcript stream is unchanged.
    return true;
  }

  /** Correlate a control_response with the pending interrupt; others are ignored. */
  #observeControlResponse(frame) {
    const wait = this.#interruptWait;
    const response = frame.response;
    if (!wait || response?.request_id !== wait.requestId) return;
    if (response.subtype === "error") {
      this.logger.warn(`[Chorus] claude rejected interrupt ${wait.requestId}: ${String(response.error)}`);
      this.#endInterruptWait();
    }
    // A success ack keeps waiting: the interrupted turn still ends with a result
    // (or, if it landed before the turn started, the killer's deadline decides).
  }

  #answerControlRequest(frame) {
    const requestId = frame.request_id;
    const subtype = frame.request?.subtype;
    if (typeof requestId !== "string" || !requestId) {
      // Nothing to correlate an answer with; surface it instead of replying blind.
      this.logger.warn(`[Chorus] claude control request ${String(subtype)} has no request_id; not answered`);
      return;
    }
    if (subtype === "can_use_tool") {
      // Log the tool NAME only — the tool input can carry secrets.
      const toolName = typeof frame.request.tool_name === "string" ? frame.request.tool_name : "<unknown>";
      const why = this.permissionMode === "yolo" ? "unexpected permission prompt in yolo mode" : "--chorus-only permission mode";
      if (!this.writable) {
        // One coherent line: the deny could not be delivered (child finishing/gone).
        this.logger.warn(`[Chorus] tool ${toolName} permission request arrived after claude stdin closed (${why}); no deny sent`);
        return;
      }
      this.logger.warn(`[Chorus] denied tool ${toolName} (${why})`);
      this.write(
        {
          type: "control_response",
          response: { subtype: "success", request_id: requestId, response: { behavior: "deny", message: CHORUS_TOOL_DENY_MESSAGE } },
        },
        `permission deny for ${toolName}`
      );
      return;
    }
    if (!this.writable) {
      this.logger.warn(`[Chorus] unsupported claude control request subtype ${String(subtype)} arrived after claude stdin closed; not answered`);
      return;
    }
    this.logger.warn(`[Chorus] unsupported claude control request subtype ${String(subtype)}; answered with an error`);
    this.write(
      { type: "control_response", response: { subtype: "error", request_id: requestId, error: UNSUPPORTED_CONTROL_ERROR } },
      `control error response (${String(subtype)})`
    );
  }
}

/**
 * Resolve the actual command + argv to spawn, given the resolved claude path
 * and the headless args. On Windows a `.cmd`/`.bat` shim is NOT a PE executable,
 * so `CreateProcess` (i.e. spawn with shell:false) cannot run it directly — it
 * must be invoked through `cmd.exe /d /s /c <path> ...args`. We keep shell:false
 * and pass argv as an array (no string concatenation), so there is no shell
 * word-splitting / injection surface. On POSIX, and for a real `.exe`, we spawn
 * the path directly.
 *
 * @param {string} claudePath
 * @param {string[]} args
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ command: string, argv: string[] }}
 */
export function resolveSpawnCommand(claudePath, args, platform = process.platform, env = process.env) {
  const isWin = platform === "win32";
  const lower = claudePath.toLowerCase();
  if (isWin && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    const comspec = getAgentEnv(env, "COMSPEC", platform) || "cmd.exe";
    // /d skip AutoRun, /s treat everything after /c literally, /c run then exit.
    return { command: comspec, argv: ["/d", "/s", "/c", claudePath, ...args] };
  }
  return { command: claudePath, argv: args };
}

/**
 * Parse a chunk of NDJSON, appending to a line buffer. Strips trailing CR
 * (Windows \r\n) and ignores blank lines. Returns parsed objects; malformed
 * lines are reported to `onWarn` and skipped (never throw).
 *
 * @param {string} buffer  Carry-over from previous chunk.
 * @param {string} chunk
 * @param {(obj: any) => void} onObject
 * @param {(msg: string) => void} [onWarn]
 * @returns {string}  New carry-over buffer (incomplete trailing line).
 */
export function parseNdjsonChunk(buffer, chunk, onObject, onWarn = () => {}) {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).replace(/\r$/, "");
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      onObject(JSON.parse(line));
    } catch (err) {
      onWarn(`stream-json parse error: ${err} — line: ${line}`);
    }
  }
  return buffer;
}

/**
 * @typedef {Object} ClaudeSpawnerOptions
 * @property {string} [claudePath]   Resolved claude path (resolved lazily if omitted).
 * @property {(o: object) => { stdin: any, stdout: any, stderr: any, on: Function, kill?: Function }} [spawnImpl]
 * @property {{info(m:string):void,warn(m:string):void,error(m:string):void}} [logger]
 * @property {PermissionMode} [permissionMode]  How much the woken Claude may do (default "chorus").
 * @property {{ url: string, apiKey: string }} [creds] Daemon credentials exported
 *   to the child for plugin hooks and shell-based Chorus tooling.
 * @property {NodeJS.Platform} [platform]  Injectable for tests; gates `detached` (POSIX-only).
 */

export class ClaudeSpawner {
  /** @param {ClaudeSpawnerOptions} [opts] */
  constructor(opts = {}) {
    this.sessionDecision = {
      probeIsAuthoritative: true,
      takeoverCommand: "claude --resume",
    };
    this.claudePath = opts.claudePath ?? null;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.permissionMode = opts.permissionMode ?? "chorus";
    this.creds = opts.creds ?? null;
    // POSIX spawns `detached: true` (process-group leader) so the interrupt path
    // can group-kill the tree; Windows does not. Injectable so a POSIX test host
    // can exercise the Windows branch and vice versa.
    this.platform = opts.platform ?? process.platform;
    this.cliConfig = validateAgentCliConfig(opts.cliConfig, "claude-code", opts.label);
    this.env = overlayAgentEnv(opts.env ?? process.env, this.cliConfig.env, this.platform);
  }

  /**
   * Spawn a headless Claude run. Resolves when the subprocess exits. The prompt
   * is written to stdin as one stream-json user frame (never argv) — this is what keeps long prompts off the
   * Windows command line and out of shell escaping/injection.
   *
   * The session id is supplied by the caller (the daemon passes the dispatched
   * entity's DIRECT idea uuid, so the session is human-resumable by idea uuid) and
   * MUST be a well-formed lowercase UUID — an invalid id is refused with a visible
   * log and NO spawn (no-silent-errors). `isNew` (decided by the caller via a disk
   * probe — see isNewSession) selects --session-id (new) vs --resume (continue).
   * `cwd` is the spawn working directory; it MUST match the cwd the caller probed,
   * since claude scopes transcripts (and --resume) to it.
   *
   * @param {{ prompt: string, sessionId: string, isNew: boolean, mcpConfigPath?: string,
   *           cwd?: string, onMessage?: (obj: any) => void,
   *           onChild?: (child: import("node:child_process").ChildProcess) => void }} params
   *   `onChild` (子3) hands the live ChildProcess to the caller the moment it spawns,
   *   so the waker can store the handle in its execution registry for the interrupt
   *   path BEFORE this promise resolves. It is invoked once, synchronously, only on a
   *   successful spawn; a spawn failure never calls it.
   * @returns {Promise<{ sessionId: string, backendSessionId: string|null, exitCode: number|null, isNew: boolean,
   *                     failureClassification?: "session_conflict" }>}
   *   `backendSessionId` is the Claude `--resume` anchor (the input `sessionId`) on a
   *   terminal resolution after a spawn, so the conversation UI can offer a resumable
   *   id — mirrors codex-spawner's shape. `null` on the pre-spawn failure paths (no
   *   turn ran, nothing to resume).
   */
  async wake({ prompt, sessionId, isNew, mcpConfigPath, cwd, onMessage, onChild }) {
    const id = sessionId;

    // Pre-validate the session id BEFORE locating claude or spawning: a malformed
    // id (not a lowercase UUID) is refused visibly with no subprocess started.
    if (!isValidSessionId(id)) {
      this.logger.error(
        `[Chorus] refusing to spawn: session id is not a valid lowercase UUID: ${id}`
      );
      return { sessionId: typeof id === "string" ? id : "", backendSessionId: null, exitCode: null, isNew: Boolean(isNew) };
    }

    const claudePath = this.claudePath ?? resolveClaudePath({ env: this.env, platform: this.platform });
    if (!claudePath) {
      // No crash — surface visibly and resolve with a failure result.
      this.logger.error("[Chorus] cannot locate the `claude` executable on PATH; skipping wake");
      return { sessionId: id, backendSessionId: null, exitCode: null, isNew };
    }

    assertConfiguredShimArgs(claudePath, this.cliConfig.args, this.platform);
    const args = [...buildArgs({ sessionId: id, isNew, mcpConfigPath, permissionMode: this.permissionMode }), ...this.cliConfig.args];
    // On Windows, a .cmd/.bat shim must be run via cmd.exe /c (CreateProcess
    // can't exec a script directly). resolveSpawnCommand keeps shell:false and
    // passes argv as an array — no shell injection surface either way.
    const { command, argv } = resolveSpawnCommand(claudePath, args, this.platform, this.env);

    // POSIX: spawn `detached: true` so the child becomes a PROCESS GROUP LEADER
    // (its pgid === its pid). The interrupt path then signals the whole group via
    // `process.kill(-pid, sig)` so a forceful kill reaches grandchildren Claude may
    // have spawned (子3 — daemon-interrupt-resume). This changes ONLY the process
    // group: stdin/stdout/stderr stay piped exactly as before (stdio is unchanged),
    // so prompt delivery over stdin and NDJSON stdout parsing are unaffected. We do
    // NOT call `subprocess.unref()` — the daemon must stay attached to read the
    // stream and observe the exit. On Windows `detached` is NOT used: taskkill /T
    // walks the tree by pid, and detached there only spawns a new console window.
    const detached = (this.platform ?? process.platform) !== "win32";
    const childEnv = { ...this.env, CHORUS_DAEMON_HEADLESS: "1" };
    for (const key of Object.keys(childEnv)) {
      if (["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"].includes(key.toUpperCase())) delete childEnv[key];
    }
    if (this.creds) {
      if (this.creds.url) childEnv.CHORUS_URL = this.creds.url;
      if (this.creds.apiKey) childEnv.CHORUS_API_KEY = this.creds.apiKey;
      // Identity profile for the woken session — its hooks/skills pass this to
      // `chorus mcp --agent`, which resolves the key from ~/.chorus/daemon.json.
      if (this.creds.agentUuid || this.creds.agentName)
        childEnv.CHORUS_AGENT_PROFILE = this.creds.agentUuid || this.creds.agentName;
    }

    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnImpl(command, argv, {
          cwd: cwd ?? process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
          // Preserve the inherited runtime environment while giving hooks and
          // shell-based Chorus tooling the daemon's authoritative connection pair.
          env: childEnv,
          // No shell:true — command is either the real executable or cmd.exe
          // with the script as an argv element. Avoids shell word-splitting /
          // injection; .cmd is handled explicitly via cmd.exe above.
          shell: false,
          detached,
          windowsHide: true,
        });
      } catch (error) {
        this.logger.error(`[Chorus] failed to spawn claude: ${safeSpawnError(error)}`);
        resolve({ sessionId: id, backendSessionId: null, exitCode: null, isNew });
        return;
      }

      const channel = new ClaudeControlChannel({ stdin: child.stdin, logger: this.logger, permissionMode: this.permissionMode });
      // Protocol interrupt (design D4): the shared killer calls this instead of
      // SIGINT and then force-cleans within the same deadline if the child remains.
      // Registered before onChild so an interrupt can never see an unhooked child.
      const unregisterStopHook = registerProcessStopHook(child, ({ deadline, protocolDeadline = deadline, beforeClose }) =>
        channel.stop({ protocolDeadline, beforeClose })
      );

      // Hand the live child to the caller (子3) so the waker can register the handle
      // for the interrupt path before this promise resolves. Never let a throwing
      // callback escape into the spawn path.
      if (onChild) {
        try {
          onChild(child);
        } catch (err) {
          this.logger.warn(`[Chorus] onChild handler threw: ${err}`);
        }
      }

      let stdoutBuf = "";
      let stderrBuf = "";
      let sessionConflictSeen = false;
      let observedSessionId = id;

      child.stdout?.setEncoding?.("utf8");
      child.stdout?.on("data", (chunk) => {
        stdoutBuf = parseNdjsonChunk(
          stdoutBuf,
          String(chunk),
          (obj) => {
            if (obj && typeof obj.session_id === "string") observedSessionId = obj.session_id;
            if (channel.handleFrame(obj)) return; // control plumbing — never forwarded
            if (onMessage) {
              try {
                onMessage(obj);
              } catch (err) {
                this.logger.warn(`[Chorus] onMessage handler threw: ${err}`);
              }
            }
          },
          (msg) => this.logger.warn(`[Chorus] ${msg}`)
        );
      });

      child.stderr?.setEncoding?.("utf8");
      child.stderr?.on("data", (chunk) => {
        const rawText = String(chunk);
        stderrBuf = (stderrBuf + rawText).slice(-STDERR_BUFFER_LIMIT);
        if (SESSION_CONFLICT_RE.test(stderrBuf)) sessionConflictSeen = true;
        const text = rawText.trim();
        if (text) this.logger.warn(`[Chorus] claude stderr: ${text}`);
      });

      child.on("error", (error) => {
        // e.g. ENOENT if the resolved path vanished — log, don't throw.
        this.logger.error(`[Chorus] claude process error: ${safeSpawnError(error)}`);
        channel.markExited();
        unregisterStopHook();
        // backendSessionId is the `--resume` anchor (`id`), NOT observedSessionId:
        // a fork-on-resume claude can emit a new stream session_id, but the daemon
        // resumes and files the transcript under `id`, so `id` is the resumable value.
        resolve({ sessionId: observedSessionId, backendSessionId: id, exitCode: null, isNew });
      });

      // Settle on process exit, not only on stdio close: a detached descendant can
      // inherit the pipes and keep `close` from ever firing (see cli/child-exit.mjs).
      // A dead child's stdin must never be written again (late control answers).
      child.on?.("exit", () => channel.markExited());

      awaitChildSettled(child, { logger: this.logger, label: "claude" }).then((code) => {
        channel.markExited();
        unregisterStopHook();
        if (code !== 0) {
          this.logger.warn(`[Chorus] claude exited with code ${code}`);
        }
        // backendSessionId is the `--resume` anchor (`id`), NOT observedSessionId (see
        // the process-error handler above for why the anchor is the resumable value).
        const result = { sessionId: observedSessionId, backendSessionId: id, exitCode: code, isNew };
        if (code !== null && code !== 0 && sessionConflictSeen) {
          result.failureClassification = SESSION_CONFLICT_FAILURE;
        }
        resolve(result);
      });

      // Guard against an ASYNC stdin error (EPIPE): if claude exits/closes
      // stdin before the prompt finishes flushing, the writable emits an
      // 'error' event. Without this listener it becomes an uncaughtException
      // and crashes the daemon — violating "one failed wake does not kill the
      // daemon". The try/catch below only catches a synchronous throw.
      child.stdin?.on?.("error", (err) => {
        this.logger.warn(`[Chorus] claude stdin error (ignored): ${err}`);
        channel.markStdinUnusable();
      });

      // Feed the prompt as ONE stream-json user frame and keep stdin OPEN: control
      // frames flow over it until the first `result` frame, when handleFrame()
      // closes it and the CLI exits. No result before exit → the raw exit code
      // settles the wake (never a synthetic success). Skipped when a stop already
      // started (e.g. from inside onChild above) — see ClaudeControlChannel.sendPrompt.
      channel.sendPrompt(buildUserFrame(prompt));
    });
  }
}
