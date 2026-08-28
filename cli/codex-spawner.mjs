// cli/codex-spawner.mjs
// Cross-platform headless Codex spawner — the `codex` counterpart to
// ClaudeSpawner, satisfying the SAME backend-agnostic Spawner.wake(...) contract
// so the daemon's wake pipeline (queue, waker, directed delivery, headless guard,
// reporters) stays backend-neutral.
//
// Codex diverges structurally from Claude (verified against codex-cli 0.142.3 +
// the ../codex source + a live `codex exec --json` run):
//   • `codex exec --json` emits JSONL (one event per line); the prompt is read
//     from STDIN (never argv). `codex exec resume <id> --json` continues a run.
//   • The FIRST event is `{"type":"thread.started","thread_id":"<uuid>"}` — Codex
//     GENERATES its own id (it does NOT accept a client `--session-id`). We capture
//     it and persist anchor→thread_id (codex-session-map.mjs) so a later wake can
//     `resume <thread_id>`. (serde: ThreadEvent tag="type", rename="thread.started";
//     ThreadStartedEvent.thread_id: String — codex-rs/exec/src/exec_events.rs.)
//   • No `--mcp-config`: Codex reads MCP servers from the user's ~/.codex/config.toml.
//     `chorus agents add` writes [mcp_servers.chorus] with bearer_token_env_var =
//     "CHORUS_API_KEY" — a KEYLESS reference (no literal key in config.toml), and Codex
//     resolves that env var into `Authorization: Bearer <key>` at connect. So the
//     CHORUS_API_KEY the daemon exports into the child env below DOES reach Codex's MCP
//     auth (as well as the plugin's shell tooling — chorus-api.sh / SessionStart hooks);
//     never argv. (Multi-agent: two Codex agents with different keys each need their own
//     CODEX_HOME so their config.toml + ~/.codex/.env don't collide.)
//   • Permission is a SANDBOX mode, not a tool allowlist.
//
// Reuses claude-spawner's platform-neutral helpers: parseNdjsonChunk (NDJSON
// stream parse) and the PATH-walk shape of resolveClaudePath.

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 as pathWin32, posix as pathPosix } from "node:path";
import { parseNdjsonChunk } from "./claude-spawner.mjs";
import { getThreadId as defaultGetThreadId, setThreadId as defaultSetThreadId } from "./codex-session-map.mjs";
import {
  getCodexUsageSnapshot as defaultGetUsageSnapshot,
  normalizeCodexUsageEvent,
  setCodexUsageSnapshot as defaultSetUsageSnapshot,
} from "./codex-usage-map.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/**
 * Check whether the user's Codex config declares the Chorus MCP server.
 * This is diagnostic only: a missing or unreadable config must never block a wake.
 * @param {{ env?: NodeJS.ProcessEnv, readFile?: typeof readFileSync, home?: string }} [deps]
 * @returns {boolean}
 */
export function hasChorusMcpServer(deps = {}) {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? readFileSync;
  const home = deps.home ?? homedir();
  const configPath = join(env.CODEX_HOME || join(home, ".codex"), "config.toml");
  try {
    const config = readFile(configPath, "utf8");
    return /^\s*\[mcp_servers\.chorus\]\s*(?:#.*)?$/m.test(config);
  } catch {
    return false;
  }
}

/**
 * @typedef {Object} Spawner
 * @property {(params: {
 *   prompt: string, sessionId: string|null, isNew: boolean,
 *   mcpConfigPath?: string, cwd?: string,
 *   onMessage?: (obj: any) => void,
 *   onChild?: (child: import("node:child_process").ChildProcess) => void
 * }) => Promise<{ sessionId: string, exitCode: number|null, isNew: boolean }>} wake
 *   The backend-agnostic wake contract. ClaudeSpawner and CodexSpawner both
 *   implement it; the daemon injects one based on the resolved agent type.
 */

/**
 * Map the daemon's backend-agnostic permission mode to a Codex sandbox posture.
 * The expression is SUBCOMMAND-AWARE because the two surfaces differ (verified
 * against codex 0.142.3): the top-level `codex exec` accepts `--sandbox <mode>`,
 * but `codex exec resume` does NOT — passing `--sandbox` there errors with exit 2.
 *   yolo   → --dangerously-bypass-approvals-and-sandbox  (valid on BOTH exec and
 *            resume; full autonomy)
 *   chorus → exec:   --sandbox read-only
 *            resume: -c sandbox_mode="read-only"  (the `-c` config override is how
 *            `codex exec resume` accepts a sandbox mode; `sandbox_mode` is a real
 *            config key, value spelled `read-only` per protocol/src/config_types.rs,
 *            confirmed via `--strict-config`).
 * Anything other than yolo falls back to the restricted read-only posture.
 * @param {"yolo"|"chorus"|undefined} permissionMode
 * @param {{ resume?: boolean }} [opts]  resume:true selects the `codex exec resume` surface.
 * @returns {string[]}
 */
export function sandboxFlags(permissionMode, opts = {}) {
  if (permissionMode === "yolo") return ["--dangerously-bypass-approvals-and-sandbox"];
  // restricted read-only posture, expressed per subcommand:
  return opts.resume ? ["-c", 'sandbox_mode="read-only"'] : ["--sandbox", "read-only"];
}

/**
 * Build the argv for a headless codex run. Prompt is NEVER here — it goes over
 * stdin. `--skip-git-repo-check` lets a non-repo cwd still run.
 * @param {{ isNew: boolean, threadId?: string|null, permissionMode?: "yolo"|"chorus" }} o
 * @returns {string[]}
 */
export function buildCodexArgs({ isNew, threadId, permissionMode }) {
  if (!isNew && threadId) {
    const sandbox = sandboxFlags(permissionMode, { resume: true });
    return ["exec", "resume", threadId, "--json", ...sandbox, "--skip-git-repo-check"];
  }
  const sandbox = sandboxFlags(permissionMode);
  return ["exec", "--json", ...sandbox, "--skip-git-repo-check"];
}

/**
 * Extract the Codex thread id from a stream event, or null. Accepts the live
 * `thread.started` shape (authoritative) and the on-disk rollout `session_meta`
 * shape as a defensive fallback.
 * @param {any} obj
 * @returns {string|null}
 */
export function extractThreadId(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.type === "thread.started" && typeof obj.thread_id === "string") {
    return obj.thread_id.trim() || null;
  }
  if (obj.type === "session_meta" && obj.payload && typeof obj.payload.id === "string") {
    return obj.payload.id.trim() || null;
  }
  return null;
}

/**
 * Resolve the real `codex` executable WITHOUT a shell — same approach as
 * resolveClaudePath. On Windows the bin may be `codex.cmd` (npm shim), which
 * `spawn` can't exec directly without shell:true; we walk PATH for the platform
 * candidates. `CHORUS_CODEX_PATH` overrides.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, isFile?: (p: string) => boolean }} [deps]
 * @returns {string | null}
 */
export function resolveCodexPath(deps = {}) {
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

  if (env.CHORUS_CODEX_PATH && isFile(env.CHORUS_CODEX_PATH)) {
    return env.CHORUS_CODEX_PATH;
  }

  const isWin = platform === "win32";
  const p = isWin ? pathWin32 : pathPosix;
  const names = isWin ? ["codex.cmd", "codex.exe", "codex"] : ["codex"];
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
 * not a PE executable, so it must run via `cmd.exe /d /s /c <path> ...args`; we
 * keep shell:false and pass argv as an array (no shell word-splitting/injection).
 * @param {string} codexPath @param {string[]} args
 * @param {NodeJS.Platform} [platform] @param {NodeJS.ProcessEnv} [env]
 * @returns {{ command: string, argv: string[] }}
 */
export function resolveSpawnCommand(codexPath, args, platform = process.platform, env = process.env) {
  const isWin = platform === "win32";
  const lower = codexPath.toLowerCase();
  if (isWin && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
    return { command: comspec, argv: ["/d", "/s", "/c", codexPath, ...args] };
  }
  return { command: codexPath, argv: args };
}

/**
 * @typedef {Object} CodexSpawnerOptions
 * @property {string} [codexPath]   Resolved codex path (resolved lazily if omitted).
 * @property {(o: object) => any} [spawnImpl]   Injectable spawn (tests).
 * @property {{info(m:string):void,warn(m:string):void,error(m:string):void}} [logger]
 * @property {"chorus"|"yolo"} [permissionMode]  Maps to a Codex sandbox posture.
 * @property {{ url: string, apiKey: string }} [creds] Daemon creds exported into
 *   the child env for SessionStart hooks and the user-configured MCP bearer token.
 * @property {NodeJS.Platform} [platform]  Injectable for tests; gates POSIX `detached`.
 * @property {(anchor: string) => string|null} [getThreadIdFn]  Injectable session-map read.
 * @property {(anchor: string, threadId: string) => void} [setThreadIdFn]  Injectable session-map write.
 * @property {(anchor: string, threadId: string) => object|null} [getUsageSnapshotFn]
 * @property {(anchor: string, threadId: string, usage: object) => void} [setUsageSnapshotFn]
 * @property {() => boolean} [hasChorusMcpServerFn] Injectable config probe.
 */

export class CodexSpawner {
  /** @param {CodexSpawnerOptions} [opts] */
  constructor(opts = {}) {
    this.sessionDecision = { probeIsAuthoritative: false };
    this.codexPath = opts.codexPath ?? null;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.permissionMode = opts.permissionMode ?? "chorus";
    this.creds = opts.creds ?? null;
    this.platform = opts.platform ?? process.platform;
    this.getThreadIdFn = opts.getThreadIdFn ?? defaultGetThreadId;
    this.setThreadIdFn = opts.setThreadIdFn ?? defaultSetThreadId;
    this.getUsageSnapshotFn = opts.getUsageSnapshotFn ?? defaultGetUsageSnapshot;
    this.setUsageSnapshotFn = opts.setUsageSnapshotFn ?? defaultSetUsageSnapshot;
    this.resolveCodexPathFn = opts.resolveCodexPathFn ?? resolveCodexPath;
    this.hasChorusMcpServerFn = opts.hasChorusMcpServerFn ?? hasChorusMcpServer;
    this.mcpConfigChecked = false;
  }

  /**
   * Spawn a headless Codex run. Resolves when the subprocess exits. The prompt is
   * written to stdin (never argv). `sessionId` is the Chorus anchor (direct idea
   * uuid, or entity uuid). Codex owns its session id, so we IGNORE the passed
   * `isNew`/`mcpConfigPath` and decide new-vs-resume from the persisted
   * anchor→thread_id map: a recorded thread id → `resume`, otherwise a fresh run.
   *
   * @param {{ prompt: string, sessionId: string|null, isNew?: boolean, mcpConfigPath?: string,
   *           cwd?: string, onMessage?: (obj: any) => void,
   *           onChild?: (child: import("node:child_process").ChildProcess) => void }} params
   * @returns {Promise<{ sessionId: string, backendSessionId: string|null, exitCode: number|null, isNew: boolean }>}
   */
  async wake({ prompt, sessionId, cwd, onMessage, onChild }) {
    const anchor = typeof sessionId === "string" ? sessionId : "";

    // new-vs-resume is OWNED by this backend (Codex session model), not the
    // waker's Claude transcript probe: a recorded thread id means resume.
    const knownThreadId = anchor ? this.getThreadIdFn(anchor) : null;
    const isNew = !knownThreadId;
    let previousUsage = knownThreadId
      ? this.getUsageSnapshotFn(anchor, knownThreadId)
      : null;
    // Existing threads created before this baseline store was introduced cannot
    // yield a trustworthy first delta. Seed once and omit that turn's usage
    // instead of publishing the entire historical cumulative total.
    let needsUsageSeed = Boolean(knownThreadId && !previousUsage);

    const codexPath = this.codexPath ?? this.resolveCodexPathFn();
    if (!codexPath) {
      // No crash — surface visibly and resolve with a failure result.
      this.logger.error("[Chorus] cannot locate the `codex` executable on PATH; skipping wake");
      return { sessionId: anchor, backendSessionId: knownThreadId, exitCode: null, isNew };
    }

    if (!this.mcpConfigChecked) {
      this.mcpConfigChecked = true;
      if (!this.hasChorusMcpServerFn()) {
        this.logger.warn(
          "[Chorus] Codex config has no [mcp_servers.chorus] entry; wake will continue without Chorus MCP tools",
        );
      }
    }

    const args = buildCodexArgs({ isNew, threadId: knownThreadId, permissionMode: this.permissionMode });
    const { command, argv } = resolveSpawnCommand(codexPath, args, this.platform);

    // POSIX: detached process group so the interrupt path can group-kill the tree
    // (codex exec forks child shells for tools). Windows uses taskkill /T. stdio
    // stays piped — prompt over stdin + NDJSON stdout parse are unaffected.
    const detached = this.platform !== "win32";

    // Export the daemon's resolved connection pair for both Codex MCP auth and
    // SessionStart hooks. Explicitly overwrite inherited values so the hook and
    // daemon cannot disagree about which Chorus instance this wake belongs to.
    const childEnv = { ...process.env, CHORUS_DAEMON_HEADLESS: "1" };
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
          env: childEnv,
          shell: false,
          detached,
          windowsHide: true,
        });
      } catch (err) {
        this.logger.error(`[Chorus] failed to spawn codex: ${err}`);
        resolve({ sessionId: anchor, backendSessionId: knownThreadId, exitCode: null, isNew });
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
      let observedThreadId = knownThreadId || null;
      let threadIdPersisted = false;

      child.stdout?.setEncoding?.("utf8");
      child.stdout?.on("data", (chunk) => {
        stdoutBuf = parseNdjsonChunk(
          stdoutBuf,
          String(chunk),
          (obj) => {
            const tid = extractThreadId(obj);
            if (tid) {
              observedThreadId = tid;
              if (isNew && anchor && !threadIdPersisted) {
                threadIdPersisted = true;
                this.setThreadIdFn(anchor, tid);
              }
            }
            let delivered = obj;
            if (obj?.type === "turn.completed" && obj.usage) {
              delivered = needsUsageSeed
                ? { ...obj, usage: null }
                : normalizeCodexUsageEvent(obj, previousUsage);
              if (anchor && observedThreadId) {
                this.setUsageSnapshotFn(anchor, observedThreadId, obj.usage);
              }
              previousUsage = obj.usage;
              needsUsageSeed = false;
            }
            if (onMessage) {
              try {
                onMessage(delivered);
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
        if (text) this.logger.warn(`[Chorus] codex stderr: ${text}`);
      });

      child.on("error", (err) => {
        this.logger.error(`[Chorus] codex process error: ${err}`);
        resolve({ sessionId: anchor, backendSessionId: observedThreadId, exitCode: null, isNew });
      });

      child.on("close", (code) => {
        if (code !== 0) {
          this.logger.warn(`[Chorus] codex exited with code ${code}`);
        }
        resolve({ sessionId: anchor, backendSessionId: observedThreadId, exitCode: code, isNew });
      });

      // Guard against an ASYNC stdin error (EPIPE) so it never becomes an
      // uncaughtException that kills the daemon.
      child.stdin?.on?.("error", (err) => {
        this.logger.warn(`[Chorus] codex stdin error (ignored): ${err}`);
      });

      // Feed the prompt over stdin, then close it so the model runs.
      try {
        child.stdin?.write(prompt);
        child.stdin?.end();
      } catch (err) {
        this.logger.warn(`[Chorus] failed writing prompt to codex stdin: ${err}`);
      }
    });
  }
}
