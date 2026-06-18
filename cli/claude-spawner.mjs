// cli/claude-spawner.mjs
// Cross-platform headless Claude Code spawner. This is the load-bearing
// engineering point of the daemon: parsing stream-json is plain JS and
// platform-neutral; the real work is spawning, and it is all Windows.
//
// Verified against Claude Code CLI 2.1.177:
//   • `-p/--print` + `--output-format stream-json` emits NDJSON (one JSON object
//     per line); every line carries `session_id`.
//   • `--session-id <uuid>` sets the session id for a fresh run, and
//     `--resume <uuid>` continues it. So we GENERATE the session id client-side
//     and pass it in, rather than scraping it from the init event — the id is
//     authoritative on our side. We still read `session_id` from the stream as
//     confirmation.
//   • `--mcp-config <file>` loads MCP servers from a JSON file.
//
// The flag list lives in ONE place (buildArgs) so a CLI flag change is a
// single-line edit.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { win32 as pathWin32, posix as pathPosix, join as pathJoin } from "node:path";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/** Matches a canonical lowercase UUID (any version). Chorus idea uuids are v4. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
 * Claude Code's transcript directory for a working directory. Verified against the
 * live install: claude escapes the ABSOLUTE cwd by replacing both `/` and `.` with
 * `-` (e.g. `/home/u/dev/ai-pm` → `-home-u-dev-ai-pm`,
 * `/home/u/.cfg/x` → `-home-u--cfg-x`). On Windows the separators/drive differ, so
 * we escape backslashes and colons too; the rule there is best-effort and must be
 * re-verified against a Windows claude before claiming Windows resume support.
 * @param {string} cwd  Absolute working directory.
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function escapeCwd(cwd, platform = process.platform) {
  // Replace path separators and dots with `-`. On POSIX that's `/` and `.`; on
  // Windows also `\` and the drive-colon. Collapsing both `/` and `.` is what
  // produces the verified double-dash on a leading-dot segment.
  const re = platform === "win32" ? /[\\/.:]/g : /[/.]/g;
  return cwd.replace(re, "-");
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
  const configDir = env.CLAUDE_CONFIG_DIR || pathJoin(deps.home ?? homedir(), ".claude");
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
  if (env.CHORUS_CLAUDE_PATH && isFile(env.CHORUS_CLAUDE_PATH)) {
    return env.CHORUS_CLAUDE_PATH;
  }

  // Use platform-correct path semantics so the resolver is testable for
  // Windows from a POSIX host (`;` delimiter + `\` join vs `:` + `/`).
  const isWin = platform === "win32";
  const p = isWin ? pathWin32 : pathPosix;
  const names = isWin ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];
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
 * Build the argv for a headless run. Prompt is NEVER here — it goes over stdin.
 * @param {{ sessionId: string, isNew: boolean, mcpConfigPath?: string, permissionMode?: PermissionMode }} o
 * @returns {string[]}
 */
export function buildArgs({ sessionId, isNew, mcpConfigPath, permissionMode = "chorus" }) {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (isNew) args.push("--session-id", sessionId);
  else args.push("--resume", sessionId);
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
  if (permissionMode === "yolo") {
    args.push("--dangerously-skip-permissions");
  } else {
    // Default: allow only this daemon's Chorus MCP tools through, nothing else.
    args.push("--allowedTools", `mcp__${CHORUS_MCP_SERVER_NAME}__*`);
  }
  return args;
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
    const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
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
 * @property {NodeJS.Platform} [platform]  Injectable for tests; gates `detached` (POSIX-only).
 */

export class ClaudeSpawner {
  /** @param {ClaudeSpawnerOptions} [opts] */
  constructor(opts = {}) {
    this.claudePath = opts.claudePath ?? null;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.permissionMode = opts.permissionMode ?? "chorus";
    // POSIX spawns `detached: true` (process-group leader) so the interrupt path
    // can group-kill the tree; Windows does not. Injectable so a POSIX test host
    // can exercise the Windows branch and vice versa.
    this.platform = opts.platform ?? process.platform;
  }

  /**
   * Spawn a headless Claude run. Resolves when the subprocess exits. The prompt
   * is written to stdin (never argv) — this is what keeps long prompts off the
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
   * @returns {Promise<{ sessionId: string, exitCode: number|null, isNew: boolean }>}
   */
  async wake({ prompt, sessionId, isNew, mcpConfigPath, cwd, onMessage, onChild }) {
    const id = sessionId;

    // Pre-validate the session id BEFORE locating claude or spawning: a malformed
    // id (not a lowercase UUID) is refused visibly with no subprocess started.
    if (!isValidSessionId(id)) {
      this.logger.error(
        `[Chorus] refusing to spawn: session id is not a valid lowercase UUID: ${id}`
      );
      return { sessionId: typeof id === "string" ? id : "", exitCode: null, isNew: Boolean(isNew) };
    }

    const claudePath = this.claudePath ?? resolveClaudePath();
    if (!claudePath) {
      // No crash — surface visibly and resolve with a failure result.
      this.logger.error("[Chorus] cannot locate the `claude` executable on PATH; skipping wake");
      return { sessionId: id, exitCode: null, isNew };
    }

    const args = buildArgs({ sessionId: id, isNew, mcpConfigPath, permissionMode: this.permissionMode });
    // On Windows, a .cmd/.bat shim must be run via cmd.exe /c (CreateProcess
    // can't exec a script directly). resolveSpawnCommand keeps shell:false and
    // passes argv as an array — no shell injection surface either way.
    const { command, argv } = resolveSpawnCommand(claudePath, args);

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

    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnImpl(command, argv, {
          cwd: cwd ?? process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
          // No shell:true — command is either the real executable or cmd.exe
          // with the script as an argv element. Avoids shell word-splitting /
          // injection; .cmd is handled explicitly via cmd.exe above.
          shell: false,
          detached,
          windowsHide: true,
        });
      } catch (err) {
        this.logger.error(`[Chorus] failed to spawn claude: ${err}`);
        resolve({ sessionId: id, exitCode: null, isNew });
        return;
      }

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
      let observedSessionId = id;

      child.stdout?.setEncoding?.("utf8");
      child.stdout?.on("data", (chunk) => {
        stdoutBuf = parseNdjsonChunk(
          stdoutBuf,
          String(chunk),
          (obj) => {
            if (obj && typeof obj.session_id === "string") observedSessionId = obj.session_id;
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
        const text = String(chunk).trim();
        if (text) this.logger.warn(`[Chorus] claude stderr: ${text}`);
      });

      child.on("error", (err) => {
        // e.g. ENOENT if the resolved path vanished — log, don't throw.
        this.logger.error(`[Chorus] claude process error: ${err}`);
        resolve({ sessionId: observedSessionId, exitCode: null, isNew });
      });

      child.on("close", (code) => {
        if (code !== 0) {
          this.logger.warn(`[Chorus] claude exited with code ${code}`);
        }
        resolve({ sessionId: observedSessionId, exitCode: code, isNew });
      });

      // Guard against an ASYNC stdin error (EPIPE): if claude exits/closes
      // stdin before the prompt finishes flushing, the writable emits an
      // 'error' event. Without this listener it becomes an uncaughtException
      // and crashes the daemon — violating "one failed wake does not kill the
      // daemon". The try/catch below only catches a synchronous throw.
      child.stdin?.on?.("error", (err) => {
        this.logger.warn(`[Chorus] claude stdin error (ignored): ${err}`);
      });

      // Feed the prompt over stdin, then close it so the model runs.
      try {
        child.stdin?.write(prompt);
        child.stdin?.end();
      } catch (err) {
        this.logger.warn(`[Chorus] failed writing prompt to claude stdin: ${err}`);
      }
    });
  }
}
