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
//   • Kiro GENERATES its own per-cwd `sessionId` (like Codex's thread_id, unlike
//     Claude's client-supplied --session-id) — BUT there is NO id-bearing stream
//     event (Kiro emits plain text/markdown on stdout; `--format json` is
//     list-commands-only). So we capture the id POST-RUN by diffing the session
//     store, and persist anchor→sessionId (kiro-session-map.mjs) so a later wake
//     can `--resume-id <sessionId>`.
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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { win32 as pathWin32, posix as pathPosix, join } from "node:path";
import { getSessionId as defaultGetSessionId, setSessionId as defaultSetSessionId } from "./kiro-session-map.mjs";
import { reconstructTranscript as defaultReconstructTranscript } from "./kiro-transcript.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/** Directory Kiro persists its CLI session store under (per-cwd conversations). */
export function kiroSessionsDir() {
  return join(homedir(), ".kiro", "sessions", "cli");
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

  if (env.CHORUS_KIRO_PATH && isFile(env.CHORUS_KIRO_PATH)) {
    return env.CHORUS_KIRO_PATH;
  }

  const isWin = platform === "win32";
  const p = isWin ? pathWin32 : pathPosix;
  const names = isWin ? ["kiro-cli.cmd", "kiro-cli.exe", "kiro-cli"] : ["kiro-cli"];
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
 * @param {string} kiroPath @param {string[]} args
 * @param {NodeJS.Platform} [platform] @param {NodeJS.ProcessEnv} [env]
 * @returns {{ command: string, argv: string[] }}
 */
export function resolveSpawnCommand(kiroPath, args, platform = process.platform, env = process.env) {
  const isWin = platform === "win32";
  const lower = kiroPath.toLowerCase();
  if (isWin && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
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
 * Decide the run's sessionId by diffing a before/after store snapshot, UNAMBIGUOUSLY.
 *
 * Concurrency (reviewer N1): the WakeQueue serializes wakes per idea-key but runs
 * DIFFERENT keys concurrently (default maxConcurrency 4), and all keys share the
 * daemon's single repo cwd — so two fresh Kiro runs can be in flight in the same
 * cwd at once. A "newest new id wins" heuristic would then mis-attribute one run's
 * sessionId to the other's anchor. To stay correct we require the id to be
 * UNAMBIGUOUS: return the new id ONLY when EXACTLY ONE brand-new id appeared in the
 * window (present in `after`, absent in `before`). If zero or several new ids
 * appeared, return null — the caller degrades to "not resumable this time" (a
 * missed resume is a minor efficiency loss; a wrong resume would cross-wire two
 * ideas' conversations, which is a correctness bug). No "updated_at advanced"
 * fallback: on a fresh run the id is always new-to-the-store; on a resume the
 * caller already knows the id and never calls this.
 * @param {Map<string, number>} before @param {Map<string, number>} after
 * @returns {string|null}
 */
export function pickNewSessionId(before, after) {
  const fresh = [];
  for (const sid of after.keys()) {
    if (!before.has(sid)) fresh.push(sid);
  }
  // Exactly one new session created in this run's window → unambiguous.
  return fresh.length === 1 ? fresh[0] : null;
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
 * @property {(anchor: string, id: string) => void} [setSessionIdFn]  Injectable session-map write.
 * @property {(cwd: string) => Map<string, number>} [snapshotSessionsFn]  Injectable store snapshot.
 * @property {(o: {sessionId: string, cwd: string, onMessage?: Function, stdout: string, logger: any}) => void} [reconstructTranscript]
 *   Injectable transcript reconstruction (task 4) — invoked post-run; a no-op if absent.
 */

export class KiroSpawner {
  /** @param {KiroSpawnerOptions} [opts] */
  constructor(opts = {}) {
    this.kiroPath = opts.kiroPath ?? null;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.permissionMode = opts.permissionMode ?? "chorus";
    this.creds = opts.creds ?? null;
    this.platform = opts.platform ?? process.platform;
    this.getSessionIdFn = opts.getSessionIdFn ?? defaultGetSessionId;
    this.setSessionIdFn = opts.setSessionIdFn ?? defaultSetSessionId;
    this.resolveKiroPathFn = opts.resolveKiroPathFn ?? resolveKiroPath;
    this.snapshotSessionsFn = opts.snapshotSessionsFn ?? snapshotSessions;
    // Post-run transcript reconstruction from Kiro's on-disk session store (task 4).
    // Defaults to the real reader; injectable/nullable for tests.
    this.reconstructTranscript =
      opts.reconstructTranscript === undefined ? defaultReconstructTranscript : opts.reconstructTranscript;
  }

  /**
   * Spawn a headless Kiro run. Resolves when the subprocess exits. The prompt is
   * written to stdin (never argv). `sessionId` is the Chorus anchor (direct idea
   * uuid, or entity uuid). Kiro owns its session id, so we IGNORE the passed
   * `isNew`/`mcpConfigPath` and decide new-vs-resume from the persisted
   * anchor→sessionId map: a recorded id → `--resume-id`, otherwise a fresh run.
   *
   * @param {{ prompt: string, sessionId: string|null, isNew?: boolean, mcpConfigPath?: string,
   *           cwd?: string, onMessage?: (obj: any) => void,
   *           onChild?: (child: import("node:child_process").ChildProcess) => void }} params
   * @returns {Promise<{ sessionId: string, exitCode: number|null, isNew: boolean }>}
   */
  async wake({ prompt, sessionId, cwd, onMessage, onChild }) {
    const anchor = typeof sessionId === "string" ? sessionId : "";
    const runCwd = cwd ?? process.cwd();

    // new-vs-resume is OWNED by this backend (Kiro session model), not the waker's
    // Claude transcript probe: a recorded sessionId means resume via --resume-id.
    const knownSessionId = anchor ? this.getSessionIdFn(anchor) : null;
    const isNew = !knownSessionId;

    const kiroPath = this.kiroPath ?? this.resolveKiroPathFn();
    if (!kiroPath) {
      // No crash — surface visibly and resolve with a failure result.
      this.logger.error("[Chorus] cannot locate the `kiro-cli` executable on PATH; skipping wake");
      return { sessionId: anchor, exitCode: null, isNew };
    }

    const args = buildKiroArgs({ isNew, sessionId: knownSessionId, permissionMode: this.permissionMode });
    const { command, argv } = resolveSpawnCommand(kiroPath, args, this.platform);

    // POSIX: detached process group so the interrupt path can group-kill the tree
    // (kiro-cli forks child shells for tools). Windows uses taskkill /T. stdio
    // stays piped — prompt over stdin + stdout capture are unaffected.
    const detached = this.platform !== "win32";

    // Export the daemon's authoritative connection pair. CHORUS_API_KEY is also
    // referenced by the plugin's MCP config; neither value is placed in argv.
    const childEnv = { ...process.env, CHORUS_DAEMON_HEADLESS: "1" };
    if (this.creds) {
      if (this.creds.url) childEnv.CHORUS_URL = this.creds.url;
      if (this.creds.apiKey) childEnv.CHORUS_API_KEY = this.creds.apiKey;
    }

    // Snapshot the session store BEFORE the run so we can identify the sessionId
    // this run creates (Kiro has no id-bearing stream event). On resume we already
    // know the id, so the snapshot is only needed for a fresh run.
    const before = isNew ? this.#safeSnapshot(runCwd) : new Map();

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
      } catch (err) {
        this.logger.error(`[Chorus] failed to spawn kiro-cli: ${err}`);
        resolve({ sessionId: anchor, exitCode: null, isNew });
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
        stdoutBuf += String(chunk);
      });

      child.stderr?.setEncoding?.("utf8");
      child.stderr?.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (text) this.logger.warn(`[Chorus] kiro-cli stderr: ${text}`);
      });

      child.on("error", (err) => {
        this.logger.error(`[Chorus] kiro-cli process error: ${err}`);
        resolve({ sessionId: knownSessionId || anchor, exitCode: null, isNew });
      });

      child.on("close", (code) => {
        if (code !== 0) {
          this.logger.warn(`[Chorus] kiro-cli exited with code ${code}`);
        }

        // Resolve the run's sessionId. On resume it's the id we passed; on a fresh
        // run, diff the store snapshot to find the newly-created conversation.
        let observedSessionId = knownSessionId || null;
        if (isNew && code === 0) {
          const after = this.#safeSnapshot(runCwd);
          const found = pickNewSessionId(before, after);
          if (found) {
            observedSessionId = found;
            if (anchor) this.setSessionIdFn(anchor, found);
          } else {
            // Zero or MULTIPLE new sessions in the window (e.g. a concurrent wake
            // in the same cwd — reviewer N1). We refuse to guess: not persisting
            // means a missed resume next time (minor), whereas guessing could
            // cross-wire two ideas' conversations (a correctness bug).
            this.logger.warn(
              "[Chorus] kiro wake: run sessionId ambiguous or absent in the store " +
                "(0 or >1 new sessions this window) — not persisting; next wake starts fresh"
            );
          }
        }

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
              onMessage,
              stdout: stdoutBuf,
              logger: this.logger,
            });
          } catch (err) {
            this.logger.warn(`[Chorus] kiro transcript reconstruction threw (ignored): ${err}`);
          }
        }

        resolve({ sessionId: observedSessionId || anchor, exitCode: code, isNew });
      });

      // Guard against an ASYNC stdin error (EPIPE) so it never becomes an
      // uncaughtException that kills the daemon.
      child.stdin?.on?.("error", (err) => {
        this.logger.warn(`[Chorus] kiro-cli stdin error (ignored): ${err}`);
      });

      // Feed the prompt over stdin, then close it so the model runs.
      try {
        child.stdin?.write(prompt);
        child.stdin?.end();
      } catch (err) {
        this.logger.warn(`[Chorus] failed writing prompt to kiro-cli stdin: ${err}`);
      }
    });
  }

  /** Snapshot the store, swallowing any failure (best-effort id capture). */
  #safeSnapshot(cwd) {
    try {
      return this.snapshotSessionsFn(cwd, { logger: this.logger });
    } catch (err) {
      this.logger.warn(`[Chorus] kiro session snapshot failed (${err}) — id capture degraded`);
      return new Map();
    }
  }
}
