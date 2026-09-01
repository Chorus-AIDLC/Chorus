// cli/pi-spawner.mjs
// Cross-platform headless pi spawner — the `pi` counterpart to ClaudeSpawner /
// CodexSpawner, satisfying the SAME backend-agnostic Spawner.wake(...) contract so
// the daemon's wake pipeline (queue, waker, directed delivery, headless guard,
// reporters) stays backend-neutral and drives whichever spawner is injected purely
// through the shared wake(...) contract.
//
// Verified against the pi source (earendil-works/pi, packages/coding-agent) before
// coding — NOT guessed:
//   • `pi --mode json -p` runs headless and emits a JSONL event stream on stdout
//     (one JSON object per line): the session header first, then AgentSessionEvents
//     (`message_start` / `message_update` / `message_end` / `tool_execution_*` /
//     `turn_end` / `agent_end`). Verified against src/modes/print-mode.ts +
//     src/modes/json-event.ts + docs/json.md.
//   • The prompt is read from PIPED STDIN (never argv): main.ts `readPipedStdin()`
//     folds stdin into the initial message when stdin is not a TTY. We pipe the
//     prompt and close stdin, exactly like the Claude/Codex spawners.
//   • SESSION MODEL — client-owned id (like Claude, unlike Codex). pi accepts a
//     caller-provided `--session-id <id>` which is IDEMPOTENT create-or-resume:
//     main.ts createSessionManager() resumes the existing session when one with
//     that exact id already exists in the cwd-scoped session dir, otherwise creates
//     a fresh session WITH that id. (`--session <id>` is the resume-ONLY flag — it
//     hard-errors when the session is absent — so it is the wrong choice for a wake
//     that must create-if-missing.) So we pass `--session-id <anchor>` for BOTH the
//     first wake and every resume; pi owns the new-vs-resume decision from its own
//     on-disk state. No persisted anchor→id map is needed (that is only for Codex,
//     which generates its own id). We NEVER pass `--no-session` (that flag is for
//     ephemeral subagent children only).
//   • pi has NO permission system (no sandbox / no tool-approval prompt in headless
//     mode), so `permissionMode` is a NO-OP: we emit no sandbox / skip-permissions
//     flag. `chorus` and `yolo` modes run identically.
//   • pi has no native MCP: a woken pi reaches Chorus tools only via the chorus-pi
//     extension / pi-mcp-adapter installed in the woken environment. This spawner
//     does not inject MCP; it exports the daemon's creds into the child env, which
//     the extension consumes (CHORUS_URL / CHORUS_API_KEY / CHORUS_AGENT_PROFILE).
//
// Reuses claude-spawner's platform-neutral NDJSON parser (parseNdjsonChunk) and the
// PATH-walk / .cmd-shim shape of the other spawners' path resolution.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { win32 as pathWin32, posix as pathPosix } from "node:path";
import { parseNdjsonChunk } from "./claude-spawner.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/**
 * Build the argv for a headless pi run. The prompt is NEVER here — it goes over
 * stdin (`pi -p` folds piped stdin into the initial message).
 *
 * `--session-id <anchor>` is pi's idempotent create-or-resume flag (verified against
 * pi main.ts createSessionManager): it resumes the session with that exact id if one
 * exists in the cwd-scoped dir, else creates a new session with that id — so the SAME
 * args serve both the first wake and every resume, and pi owns the decision. `-p` is
 * placed LAST so pi's arg parser can never mistake a following token for a message
 * positional (its `-p` handler slurps the next bare, non-flag arg as a message).
 *
 * @param {{ sessionId: string }} o
 * @returns {string[]}
 */
export function buildPiArgs({ sessionId }) {
  return ["--mode", "json", "--session-id", sessionId, "-p"];
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

  if (env.CHORUS_PI_PATH && isFile(env.CHORUS_PI_PATH)) {
    return env.CHORUS_PI_PATH;
  }

  const isWin = platform === "win32";
  const p = isWin ? pathWin32 : pathPosix;
  const names = isWin ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
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
    const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
    return { command: comspec, argv: ["/d", "/s", "/c", piPath, ...args] };
  }
  return { command: piPath, argv: args };
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
 */

export class PiSpawner {
  /** @param {PiSpawnerOptions} [opts] */
  constructor(opts = {}) {
    // pi manages new-vs-resume internally from its own on-disk session state (the
    // `--session-id` anchor is idempotent create-or-resume), so the daemon's shared
    // Claude transcript probe is NOT authoritative for pi. Setting this false makes
    // the waker skip the Claude-specific "take over with `claude --resume`" log line
    // (mirrors CodexSpawner) — pi is not resumable via `claude --resume`.
    this.sessionDecision = { probeIsAuthoritative: false };
    this.piPath = opts.piPath ?? null;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.logger = opts.logger ?? NOOP_LOGGER;
    // Stored for a uniform construction shape, but never consulted when building
    // args — pi has no permission surface, so no sandbox / skip-permissions flag.
    this.permissionMode = opts.permissionMode ?? "chorus";
    this.creds = opts.creds ?? null;
    this.platform = opts.platform ?? process.platform;
    this.resolvePiPathFn = opts.resolvePiPathFn ?? resolvePiPath;
  }

  /**
   * Spawn a headless pi run. Resolves when the subprocess exits. The prompt is
   * written to stdin (never argv). `sessionId` is the Chorus anchor (direct idea
   * uuid, or the entity uuid for an ad-hoc session) and is passed straight through as
   * pi's client-owned `--session-id`, which pi resolves as create-or-resume from its
   * own on-disk session dir — so the passed `isNew` (derived by the waker's
   * Claude-specific transcript probe, which never matches a pi session) does NOT
   * drive the flag; it is only echoed back for the waker's log line.
   *
   * @param {{ prompt: string, sessionId: string|null, isNew?: boolean, cwd?: string,
   *           onMessage?: (obj: any) => void,
   *           onChild?: (child: import("node:child_process").ChildProcess) => void }} params
   * @returns {Promise<{ sessionId: string, backendSessionId: string|null, exitCode: number|null, isNew: boolean }>}
   *   `backendSessionId` is the resumable anchor (the input `sessionId`) after a spawn,
   *   so the conversation UI can offer a resumable id — mirrors the other spawners.
   *   `null` on the pre-spawn failure paths (no run started, nothing to resume).
   */
  async wake({ prompt, sessionId, isNew, cwd, onMessage, onChild }) {
    const anchor = typeof sessionId === "string" ? sessionId : "";
    const isNewFlag = Boolean(isNew);

    const piPath = this.piPath ?? this.resolvePiPathFn();
    if (!piPath) {
      // No crash — surface visibly and resolve with a failure result (matches the
      // other spawners' "skipping wake" convention: exitCode null, no throw).
      this.logger.error("[Chorus] cannot locate the `pi` executable on PATH; skipping wake");
      return { sessionId: anchor, backendSessionId: null, exitCode: null, isNew: isNewFlag };
    }

    const args = buildPiArgs({ sessionId: anchor });
    const { command, argv } = resolveSpawnCommand(piPath, args, this.platform);

    // POSIX: detached process group so the interrupt path can group-kill the tree
    // (pi may fork child shells / subagents). Windows uses taskkill /T. stdio stays
    // piped — prompt over stdin + NDJSON stdout parse are unaffected.
    const detached = this.platform !== "win32";

    // Export the daemon's resolved connection pair for the chorus-pi extension's
    // Chorus tooling. Explicitly overwrite inherited values so the extension and the
    // daemon cannot disagree about which Chorus instance this wake belongs to.
    const childEnv = { ...process.env, CHORUS_DAEMON_HEADLESS: "1" };
    if (this.creds) {
      if (this.creds.url) childEnv.CHORUS_URL = this.creds.url;
      if (this.creds.apiKey) childEnv.CHORUS_API_KEY = this.creds.apiKey;
      // Identity profile for the woken session — its extension/skills pass this to
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
          env: childEnv,
          shell: false,
          detached,
          windowsHide: true,
        });
      } catch (err) {
        this.logger.error(`[Chorus] failed to spawn pi: ${err}`);
        resolve({ sessionId: anchor, backendSessionId: null, exitCode: null, isNew: isNewFlag });
        return;
      }

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
        if (text) this.logger.warn(`[Chorus] pi stderr: ${text}`);
      });

      child.on("error", (err) => {
        this.logger.error(`[Chorus] pi process error: ${err}`);
        resolve({ sessionId: anchor, backendSessionId: anchor || null, exitCode: null, isNew: isNewFlag });
      });

      child.on("close", (code) => {
        if (code !== 0) {
          this.logger.warn(`[Chorus] pi exited with code ${code}`);
        }
        resolve({ sessionId: anchor, backendSessionId: anchor || null, exitCode: code, isNew: isNewFlag });
      });

      // Guard against an ASYNC stdin error (EPIPE) so it never becomes an
      // uncaughtException that kills the daemon.
      child.stdin?.on?.("error", (err) => {
        this.logger.warn(`[Chorus] pi stdin error (ignored): ${err}`);
      });

      // Feed the prompt over stdin, then close it so the model runs.
      try {
        child.stdin?.write(prompt);
        child.stdin?.end();
      } catch (err) {
        this.logger.warn(`[Chorus] failed writing prompt to pi stdin: ${err}`);
      }
    });
  }
}
