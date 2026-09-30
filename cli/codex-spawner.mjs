// One isolated Codex App Server stdio connection per daemon wake.
import { spawn } from "node:child_process";
import { safeSpawnError } from "./launch-diagnostics.mjs";
import { validateAgentCliConfig, codexAppServerArgs, overlayAgentEnv, getAgentEnv, assertConfiguredShimArgs } from "./agent-cli-config.mjs";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 as pathWin32, posix as pathPosix } from "node:path";
import { CodexAppServerClient, CodexAppServerError, isHistoryUnavailableError } from "./codex-app-server-client.mjs";
import { CodexAppServerEvents } from "./codex-app-server-events.mjs";
import { registerProcessStopHook } from "./process-stop-hooks.mjs";
import { killProcessTree } from "./process-killer.mjs";
import { awaitChildSettled } from "./child-exit.mjs";
import { getThreadId as defaultGetThreadId, setThreadId as defaultSetThreadId } from "./codex-session-map.mjs";
import {
  getCodexUsageSnapshot as defaultGetUsageSnapshot,
  setCodexUsageSnapshot as defaultSetUsageSnapshot,
} from "./codex-usage-map.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };
const CLIENT_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * Check whether the user's Codex config declares the Chorus MCP server.
 * This is diagnostic only: a missing or unreadable config must never block a wake.
 * @param {{ env?: NodeJS.ProcessEnv, readFile?: typeof readFileSync, home?: string }} [deps]
 * @returns {boolean}
 */
export function hasChorusMcpServer(deps = {}) {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? readFileSync;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? getAgentEnv(env, "HOME", platform) ?? getAgentEnv(env, "USERPROFILE", platform) ?? homedir();
  const configPath = join(getAgentEnv(env, "CODEX_HOME", platform) || join(home, ".codex"), "config.toml");
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

/** App Server transport is daemon-owned; policy is applied by RPC. */
export function buildCodexArgs({ args = [] } = {}) {
  return ["app-server", "--listen", "stdio://", ...codexAppServerArgs(args)];
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

  const override = getAgentEnv(env, "CHORUS_CODEX_PATH", platform);
  if (override && isFile(override)) {
    return override;
  }

  const isWin = platform === "win32";
  const p = isWin ? pathWin32 : pathPosix;
  const names = isWin ? ["codex.cmd", "codex.exe", "codex"] : ["codex"];
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
 * @param {string} codexPath @param {string[]} args
 * @param {NodeJS.Platform} [platform] @param {NodeJS.ProcessEnv} [env]
 * @returns {{ command: string, argv: string[] }}
 */
export function resolveSpawnCommand(codexPath, args, platform = process.platform, env = process.env) {
  const isWin = platform === "win32";
  const lower = codexPath.toLowerCase();
  if (isWin && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    const comspec = getAgentEnv(env, "COMSPEC", platform) || "cmd.exe";
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
    this.cliConfig = validateAgentCliConfig(opts.cliConfig, "codex", opts.label);
    this.env = overlayAgentEnv(opts.env ?? process.env, this.cliConfig.env, this.platform);
    const storeLogger = { warn: () => { throw new CodexAppServerError("STORE_IO_ERROR", "Codex local storage failed"); } };
    this.getThreadIdFn = opts.getThreadIdFn ?? ((anchor) => defaultGetThreadId(anchor, { logger: storeLogger }));
    this.setThreadIdFn = opts.setThreadIdFn ?? ((anchor, id) => defaultSetThreadId(anchor, id, { logger: storeLogger }));
    this.getUsageSnapshotFn = opts.getUsageSnapshotFn ?? ((anchor, id) => defaultGetUsageSnapshot(anchor, id, { logger: storeLogger }));
    this.setUsageSnapshotFn = opts.setUsageSnapshotFn ?? ((anchor, id, usage) => defaultSetUsageSnapshot(anchor, id, usage, { logger: storeLogger }));
    this.resolveCodexPathFn = opts.resolveCodexPathFn ?? resolveCodexPath;
    this.hasChorusMcpServerFn = opts.hasChorusMcpServerFn ?? hasChorusMcpServer;
    this.mcpConfigChecked = false;
    this.rpcLimits = opts.rpcLimits;
    this.cleanupTimeoutMs = opts.cleanupTimeoutMs ?? 10_000;
    this.stdioGraceMs = opts.stdioGraceMs ?? 2_000;
    this.maxBufferedBytes = opts.maxBufferedBytes;
    this.killProcessTreeFn = opts.killProcessTreeFn ?? killProcessTree;
    this.killOptions = opts.killOptions ?? {};
  }

  /** One real stdio child and one authoritative turn per wake. */
  async wake({ prompt, sessionId, cwd = process.cwd(), onMessage, onChild }) {
    const anchor = typeof sessionId === "string" ? sessionId : "";
    let threadId = null;
    let isNew = true;
    let child, client, adapter, unsubscribe, unregister, onProcessError;
    let cancelled = false;
    let stopWork;
    let stopDeadline;
    let rawSettled;
    let rawDone = false;
    let rawCode = null;
    let wakeFault = null;
    const fault = (code) => new CodexAppServerError(code, `Codex App Server: ${code}`);
    // Diagnostic text is fixed, never provider errors, callbacks, paths or values.
    const log = (level, text) => { try { this.logger[level]?.(text); } catch {} };
    const result = (exitCode) => ({ sessionId: anchor, backendSessionId: threadId, exitCode, isNew });
    const ensureRunning = () => {
      if (cancelled) throw fault("CANCELLED");
      if (client?.closed) throw client.error;
    };
    try {
      try { threadId = anchor ? this.getThreadIdFn(anchor) : null; }
      catch {
        threadId = null;
        log("warn", "[Chorus] Codex session mapping could not be read; starting a fresh thread with Chorus context.");
      }
      isNew = !threadId;
      const previousThreadId = threadId;
      const previousUsage = threadId ? this.getUsageSnapshotFn(anchor, threadId) : null;
      let activeSetup = null;
      const captureThread = (id) => {
        activeSetup.observedId = id;
        isNew = activeSetup.method === "thread/start";
        // Latch before best-effort IO so duplicate notifications/responses never
        // retry a failed write or lose the in-memory identity on interruption.
        if (threadId === id) return;
        threadId = id;
        if (anchor) {
          try { this.setThreadIdFn(anchor, id); }
          catch {
            log("warn", "[Chorus] Codex session mapping could not be saved; continuing this thread, but future wake continuity may be reduced.");
          }
        }
      };
      const establishThread = async (method, params) => {
        activeSetup = { method, expectedId: params.threadId, observedId: null };
        try {
          const established = await client.request(method, params);
          const id = established?.thread?.id;
          if (typeof id !== "string" || !id.trim()) throw fault("INVALID_THREAD_ID");
          if (activeSetup.expectedId && id !== activeSetup.expectedId) throw fault("MISMATCHED_THREAD_ID");
          if (activeSetup.observedId && activeSetup.observedId !== id) throw fault("MISMATCHED_THREAD_ID");
          // Keep a response already received even if cancellation won this await.
          captureThread(id);
        } finally { activeSetup = null; }
      };
      const codexPath = this.codexPath ?? this.resolveCodexPathFn({ env: this.env, platform: this.platform });
      if (!codexPath) throw fault("EXECUTABLE_MISSING");
      if (!this.mcpConfigChecked) {
        this.mcpConfigChecked = true;
        if (!this.hasChorusMcpServerFn({ env: this.env, platform: this.platform }))
          log("warn", "[Chorus] Codex config has no [mcp_servers.chorus] entry; wake will continue without Chorus MCP tools");
      }
      try { assertConfiguredShimArgs(codexPath, this.cliConfig.args, this.platform); }
      catch {
        log("error", "[Chorus] Codex Windows shim cannot safely carry configured arguments; configure a native executable.");
        throw fault("UNSAFE_WINDOWS_SHIM_ARGS");
      }
      let args;
      try { args = buildCodexArgs({ args: this.cliConfig.args }); }
      catch { throw fault("UNSUPPORTED_DAEMON_ARGS"); }
      const { command, argv } = resolveSpawnCommand(codexPath, args, this.platform, this.env);
      const childEnv = { ...this.env, CHORUS_DAEMON_HEADLESS: "1" };
      if (this.creds) {
        if (this.creds.url) childEnv.CHORUS_URL = this.creds.url;
        if (this.creds.apiKey) childEnv.CHORUS_API_KEY = this.creds.apiKey;
        if (this.creds.agentUuid || this.creds.agentName)
          childEnv.CHORUS_AGENT_PROFILE = this.creds.agentUuid || this.creds.agentName;
      }
      try {
        child = this.spawnImpl(command, argv, {
          cwd, stdio: ["pipe", "pipe", "pipe"], env: childEnv,
          shell: false, detached: this.platform !== "win32", windowsHide: true,
        });
      } catch (error) {
        log("error", `[Chorus] Codex startup: ${safeSpawnError(error)}`);
        throw fault("SPAWN_FAILED");
      }
      onProcessError = (error) => log("error", `[Chorus] Codex process: ${safeSpawnError(error)}`);
      child.on("error", onProcessError);
      rawSettled = awaitChildSettled(child, { logger: this.logger, label: "codex", stdioGraceMs: this.stdioGraceMs })
        .then((code) => { rawDone = true; rawCode = code; return code; });
      client = new CodexAppServerClient(child, {
        limits: this.rpcLimits,
        // CLOSED is emitted only by our explicit close(), including normal
        // completion. Keep real transport faults visible at warning severity.
        onDiagnostic: (text) => log(text === "Codex App Server: CLOSED" ? "info" : "warn", `[Chorus] ${text}`),
      });
      // Subscribe before setup, but don't feed setup/history snapshots to T3.
      unsubscribe = client.subscribe((message) => {
        if (activeSetup && !cancelled && message.method === "thread/started" && !Object.hasOwn(message, "id")) {
          const id = message.params?.thread?.id;
          // This process has only one setup request at a time. A fresh start's
          // first ID is authoritative; resume must match its requested ID, and
          // fallback must not accept a late notification for the old thread.
          if (typeof id === "string" && id.trim()
            && (!activeSetup.expectedId || id === activeSetup.expectedId)
            && (activeSetup.method !== "thread/start" || id !== previousThreadId)
            && (!activeSetup.observedId || id === activeSetup.observedId)) captureThread(id);
        }
        adapter?.accept(message);
      });
      unregister = registerProcessStopHook(child, ({ deadline, protocolDeadline = deadline, reason, beforeClose }) => {
        stopDeadline = Math.min(stopDeadline ?? Infinity, deadline);
        if (reason !== "cleanup") cancelled = true;
        if (reason === "cleanup") {
          return (async () => { try { await beforeClose?.(); } finally { client.close(); } })();
        }
        if (stopWork) return stopWork;
        stopWork = (async () => {
          try {
            const turnId = adapter?.turnId ?? adapter?.observedTurnId;
            if (turnId && !adapter.outcome && !client.closed) {
              await client.request("turn/interrupt", { threadId, turnId }, {
                timeoutMs: Math.max(1, protocolDeadline - Date.now()),
              });
              let timer;
              try {
                await Promise.race([
                  adapter.completion, client.failure,
                  new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, protocolDeadline - Date.now())); }),
                ]);
              } finally { clearTimeout(timer); }
            }
          } finally {
            try { await beforeClose?.(); } finally { client.close(); }
          }
        })();
        return stopWork;
      });
      try { onChild?.(child); } catch { log("warn", "[Chorus] Codex onChild callback failed"); }
      ensureRunning();
      await client.request("initialize", {
        clientInfo: { name: "chorus", version: CLIENT_VERSION }, capabilities: { experimentalApi: false },
      });
      ensureRunning();
      await client.notify("initialized");
      ensureRunning();
      const fullAccess = this.permissionMode === "yolo";
      const setup = { cwd, approvalPolicy: "never", sandbox: fullAccess ? "danger-full-access" : "read-only" };
      let fallback = false;
      if (threadId) {
        try {
          await establishThread("thread/resume", { ...setup, threadId, excludeTurns: true });
        } catch (error) {
          ensureRunning();
          if (!isHistoryUnavailableError(error, threadId)) throw error;
          fallback = true;
          await establishThread("thread/start", setup);
        }
      } else await establishThread("thread/start", setup);
      ensureRunning();
      adapter = new CodexAppServerEvents({
        threadId, isNew, previousUsage: threadId === previousThreadId ? previousUsage : null,
        maxBufferedBytes: this.maxBufferedBytes,
        onMessage: (message) => {
          try { onMessage?.(message); } catch { log("warn", "[Chorus] Codex onMessage callback failed"); }
        },
        onUsageSnapshot: (snapshot) => {
          if (anchor) this.setUsageSnapshotFn(anchor, threadId, snapshot);
        },
      });
      if (fallback) {
        const notice = "Previous Codex history could not be restored; continuing in a new thread with Chorus context.";
        // Native IDs are UUIDs. Do not echo arbitrary provider-controlled strings.
        const displayId = (id) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
          ? id : "(unavailable)";
        log("warn", `[Chorus] ${notice} Old thread: ${displayId(previousThreadId)}; new thread: ${displayId(threadId)}.`);
        adapter.notice(notice);
      }
      ensureRunning();
      const started = await client.request("turn/start", {
        threadId, cwd, approvalPolicy: "never",
        sandboxPolicy: fullAccess ? { type: "dangerFullAccess" } : { type: "readOnly", networkAccess: false },
        input: [{ type: "text", text: prompt, text_elements: [] }],
      });
      adapter.confirmTurn(started?.turn?.id);
      await Promise.race([
        adapter.completion,
        client.failure.then((error) => {
          if (adapter.outcome && ["CLOSED", "EOF"].includes(error.code)) return;
          throw error;
        }),
        rawSettled.then(() => { if (!adapter.outcome) throw fault("MISSING_TERMINAL"); }),
      ]);
    } catch (error) {
      wakeFault = error;
      const code = error instanceof CodexAppServerError ? error.code : "SETUP_OR_STORE_ERROR";
      log("error", `[Chorus] Codex App Server wake failed (${code}); check Codex 0.157.1+ installation, login, model/config and local session storage. Unsupported args must use model or permitted -c settings.`);
    } finally {
      try { adapter?.finish(); } catch {
        wakeFault ??= fault("USAGE_STORE_ERROR");
        log("error", "[Chorus] Codex usage persistence failed; check local session storage.");
      }
      if (child) {
        // Normal close never marks a user interrupt. Concurrent authorized stops
        // still invoke the registered hook and latch cancellation synchronously.
        const deadline = stopDeadline ?? Date.now() + this.cleanupTimeoutMs;
        try {
          const cleanup = await this.killProcessTreeFn(child, {
            ...this.killOptions, platform: this.platform, logger: this.logger,
            sigintTimeoutMs: Math.max(0, deadline - Date.now()), reason: "cleanup",
          });
          if (cleanup?.cleanupFailed) throw fault("CLEANUP_ERROR");
          if (!rawDone && rawSettled) {
            let timer;
            try {
              await Promise.race([rawSettled, new Promise((resolve) => {
                timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
              })]);
            } finally { clearTimeout(timer); }
          }
        } catch {
          wakeFault ??= fault("CLEANUP_ERROR");
          log("error", "[Chorus] Codex process-tree cleanup failed; check process termination permissions.");
        }
        client?.close();
        // Release descendant-held pipes after the bounded shared drain/cleanup.
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy?.();
      }
      unsubscribe?.();
      unregister?.();
      if (onProcessError) child?.removeListener("error", onProcessError);
    }
    // CLOSED/EOF is expected only after a confirmed valid terminal. All other
    // protocol faults stay failures even if completion arrived in the same chunk.
    const transportFault = client?.error && !["CLOSED", "EOF"].includes(client.error.code);
    if (cancelled) return result(130);
    if (wakeFault || transportFault || !adapter?.outcome) return result(null);
    if (adapter.outcome.status !== "completed") return result(1);
    return result(rawDone && rawCode === 0 ? 0 : null);
  }
}
