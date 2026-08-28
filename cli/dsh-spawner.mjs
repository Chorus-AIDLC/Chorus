// External DeepSeek Harness SDK runtime bridge. One fresh JSON-RPC runtime and
// session are created per wake; no dsh session state is persisted by Chorus.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { win32 as pathWin32, posix as pathPosix } from "node:path";
import { prepareManagedDshConfig } from "./dsh-managed-config.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };
export const DEFAULT_DSH_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_DSH_SHUTDOWN_TIMEOUT_MS = 5_000;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve the external SDK runtime. CHORUS_DSH_PATH overrides PATH. */
export function resolveDshPath(deps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const fileProbe = deps.isFile ?? isFile;
  const override = nonEmpty(env.CHORUS_DSH_PATH);
  if (override && fileProbe(override)) return override;

  const windows = platform === "win32";
  const path = windows ? pathWin32 : pathPosix;
  const names = windows
    ? ["dsh-jsonrpc-agent.cmd", "dsh-jsonrpc-agent.exe", "dsh-jsonrpc-agent"]
    : ["dsh-jsonrpc-agent"];
  const dirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fileProbe(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve the required Cordis composition without placing it in argv. */
export function resolveDshConfig(env = process.env) {
  return nonEmpty(env.CHORUS_DSH_CONFIG) ?? nonEmpty(env.DSH_CORDIS_CONFIG);
}

/** Windows npm command shims need cmd.exe while retaining argv isolation. */
export function resolveDshSpawnCommand(dshPath, platform = process.platform, env = process.env) {
  const lower = dshPath.toLowerCase();
  if (platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    return {
      command: env.ComSpec || env.COMSPEC || "cmd.exe",
      argv: ["/d", "/s", "/c", dshPath],
    };
  }
  return { command: dshPath, argv: [] };
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Add one upstream TokenUsage object into the per-wake disjoint totals. */
export function addDshUsage(total, usage) {
  if (!usage || typeof usage !== "object") return total;
  for (const [source, target] of [
    ["inputTokens", "inputTokens"],
    ["outputTokens", "outputTokens"],
    ["cacheWriteTokens", "cacheCreationTokens"],
    ["cacheReadTokens", "cacheReadTokens"],
  ]) {
    const count = tokenCount(usage[source]);
    if (count === null) continue;
    total[target] = (total[target] ?? 0) + count;
  }
  return total;
}

function hasVisibleAssistantContent(data) {
  const content = data?.message?.content;
  return Array.isArray(content) && content.length > 0;
}

function containsReceipt(event, messageId) {
  if (event?.type !== "agent/inbox/spliced" || !Array.isArray(event?.data?.inserted)) return false;
  return event.data.inserted.some((message) => message && message.id === messageId);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export class DshSpawner {
  constructor(opts = {}) {
    this.sessionDecision = { probeIsAuthoritative: false };
    this.dshPath = opts.dshPath ?? null;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.resolveDshPathFn = opts.resolveDshPathFn ?? resolveDshPath;
    this.uuidFn = opts.uuidFn ?? randomUUID;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.creds = opts.creds ?? null;
    this.platform = opts.platform ?? process.platform;
    this.env = opts.env ?? process.env;
    this.bundleVersion = opts.bundleVersion ?? null;
    this.prepareManagedConfigFn = opts.prepareManagedConfigFn ?? prepareManagedDshConfig;
    this.timeoutMs = opts.timeoutMs ?? positiveInt(this.env.CHORUS_DSH_TIMEOUT_MS, DEFAULT_DSH_TIMEOUT_MS);
    this.shutdownTimeoutMs =
      opts.shutdownTimeoutMs ??
      positiveInt(this.env.CHORUS_DSH_SHUTDOWN_TIMEOUT_MS, DEFAULT_DSH_SHUTDOWN_TIMEOUT_MS);
  }

  async wake({ prompt, sessionId: anchor, cwd, onMessage, onChild }) {
    let dshPath = this.dshPath ?? this.resolveDshPathFn({ env: this.env, platform: this.platform });
    let config = resolveDshConfig(this.env);
    const result = (backendSessionId, exitCode) => ({
      sessionId: backendSessionId || anchor || "",
      backendSessionId: backendSessionId || null,
      exitCode,
      isNew: true,
    });

    if (!dshPath) {
      this.logger.error(
        "[Chorus] cannot locate `dsh-jsonrpc-agent`; install it or set CHORUS_DSH_PATH",
      );
      return result(null, null);
    }
    if (!config) {
      try {
        const managed = await this.prepareManagedConfigFn({
          env: this.env,
          bundleVersion: this.bundleVersion,
          dshPath,
          creds: this.creds,
        });
        config = managed.configPath;
        dshPath = managed.runtimePath ?? dshPath;
      } catch (error) {
        this.logger.error(`[Chorus] cannot prepare managed dsh config: ${errorText(error)}`);
        return result(null, null);
      }
    }

    const dshSessionId = `chorus-${this.uuidFn().replaceAll("-", "")}`;
    const provider =
      nonEmpty(this.env.CHORUS_DSH_PROVIDER) ?? nonEmpty(this.env.DSH_PROVIDER) ?? "deepseek-official";
    const model =
      nonEmpty(this.env.CHORUS_DSH_MODEL) ?? nonEmpty(this.env.DSH_MODEL) ?? "deepseek-v4-flash";
    const childEnv = {
      ...this.env,
      CHORUS_DAEMON_HEADLESS: "1",
      DSH_CORDIS_CONFIG: config,
      DSH_CWD: cwd || process.cwd(),
    };
    if (this.creds?.url) childEnv.CHORUS_URL = this.creds.url;
    if (this.creds?.apiKey) childEnv.CHORUS_API_KEY = this.creds.apiKey;
    // Identity profile — the dsh doc-mirror wrapper passes this to `chorus mcp
    // --agent` (resolving the key from ~/.chorus/daemon.json). dsh scrubs
    // credential-shaped env from tool subprocesses; the profile is not a secret,
    // and the wrapper also reads it from $DSH_HOME/.env, so url/apiKey remain the
    // reliable fallback when it doesn't survive.
    if (this.creds?.agentUuid || this.creds?.agentName)
      childEnv.CHORUS_AGENT_PROFILE = this.creds.agentUuid || this.creds.agentName;

    const { command, argv } = resolveDshSpawnCommand(dshPath, this.platform, childEnv);
    let child;
    try {
      child = this.spawnImpl(command, argv, {
        cwd: cwd || undefined,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: this.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      this.logger.error(`[Chorus] failed to start dsh runtime: ${errorText(error)}`);
      return result(dshSessionId, null);
    }

    try {
      onChild?.(child);
    } catch (error) {
      this.logger.warn(`[Chorus] onChild handler threw: ${errorText(error)}`);
    }

    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdin?.on?.("error", () => {});

    const closed = deferred();
    const failed = deferred();
    // A rejected failure promise is raced below; attaching this handler prevents
    // a process-exit rejection from becoming unhandled during successful setup.
    failed.promise.catch(() => {});
    let exitCode;
    let closeSeen = false;
    let protocolDone = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let serial = 0;
    const pending = new Map();
    const notifications = [];
    let notificationCursor = 0;
    let messageId = null;
    let receiptSeen = false;
    const idle = deferred();
    idle.promise.catch(() => {});
    const usage = {
      inputTokens: null,
      outputTokens: null,
      cacheCreationTokens: null,
      cacheReadTokens: null,
    };

    const fail = (message) => {
      if (protocolDone) return;
      protocolDone = true;
      const error = message instanceof Error ? message : new Error(String(message));
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      idle.reject(error);
      failed.reject(error);
    };

    const emit = (frame) => {
      try {
        onMessage?.(frame);
      } catch (error) {
        this.logger.warn(`[Chorus] onMessage handler threw: ${errorText(error)}`);
      }
    };

    const processNotifications = () => {
      if (!messageId || protocolDone) return;
      while (notificationCursor < notifications.length) {
        const notification = notifications[notificationCursor++];
        const params = notification.params;
        if (params?.sessionId !== dshSessionId) continue;
        if (!receiptSeen) {
          if (notification.method === "session.event" && containsReceipt(params.event, messageId)) {
            receiptSeen = true;
          }
          continue;
        }
        if (notification.method === "session.event") {
          const event = params.event;
          if (!event || typeof event !== "object" || typeof event.type !== "string") {
            fail("dsh session.event carried a malformed event envelope");
            return;
          }
          if (event.type === "assistant/message") addDshUsage(usage, event.data?.usage);
          if (event.type === "user/message" || (event.type === "assistant/message" && hasVisibleAssistantContent(event.data))) {
            emit({ type: event.type, session_id: dshSessionId, data: event.data });
          }
        } else if (notification.method === "session.status" && params.status === "idle") {
          idle.resolve();
          return;
        }
      }
    };

    const handleFrame = (frame) => {
      if (!frame || typeof frame !== "object" || frame.jsonrpc !== "2.0") {
        fail("dsh runtime emitted a malformed JSON-RPC frame");
        return;
      }
      if ((typeof frame.id === "string" || typeof frame.id === "number") && !frame.method) {
        const waiter = pending.get(frame.id);
        if (!waiter) return;
        pending.delete(frame.id);
        if (frame.error && typeof frame.error === "object") {
          waiter.reject(
            new Error(
              `dsh JSON-RPC error ${frame.error.code ?? ""}: ${frame.error.message ?? "unknown error"}`,
            ),
          );
        } else {
          waiter.resolve(frame.result);
        }
        return;
      }
      if (typeof frame.method === "string" && frame.id === undefined) {
        notifications.push({
          method: frame.method,
          params: frame.params && typeof frame.params === "object" && !Array.isArray(frame.params)
            ? frame.params
            : {},
        });
        processNotifications();
      }
    };

    child.stdout?.on?.("data", (chunk) => {
      stdoutBuffer += String(chunk);
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          handleFrame(JSON.parse(line));
        } catch {
          fail("dsh runtime emitted malformed JSON on stdout");
        }
      }
    });
    child.stderr?.on?.("data", (chunk) => {
      stderrBuffer += String(chunk);
      for (;;) {
        const newline = stderrBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stderrBuffer.slice(0, newline).trim();
        stderrBuffer = stderrBuffer.slice(newline + 1);
        if (line) this.logger.warn(`[dsh] ${line}`);
      }
    });
    child.on?.("error", (error) => fail(`dsh runtime process error: ${errorText(error)}`));
    child.on?.("close", (code) => {
      closeSeen = true;
      exitCode = code;
      if (stderrBuffer.trim()) this.logger.warn(`[dsh] ${stderrBuffer.trim()}`);
      if (!protocolDone) fail(`dsh runtime exited before protocol completion (code ${code})`);
      closed.resolve(code);
    });

    const request = (method, params = {}) => {
      const id = `chorus_${++serial}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    };

    const stopRuntime = async () => {
      if (closeSeen) return;
      try {
        child.stdin?.end?.();
      } catch {}
      try {
        await withTimeout(closed.promise, this.shutdownTimeoutMs, "dsh runtime did not exit after stdin closed");
      } catch {
        try {
          child.kill?.("SIGTERM");
        } catch {}
      }
    };

    try {
      const initialize = await withTimeout(
        Promise.race([
          request("initialize", { cwd: cwd || process.cwd(), provider, model }),
          failed.promise,
        ]),
        this.shutdownTimeoutMs,
        "dsh initialize timed out",
      );
      if (initialize?.serverInfo?.name !== "deepseek-harness-sdk-runtime") {
        throw new Error("dsh initialize returned an unexpected server identity");
      }

      const promptResult = await withTimeout(
        Promise.race([
          request("session/prompt", {
            sessionId: dshSessionId,
            contentBlocks: [{ type: "text", text: String(prompt ?? "") }],
          }),
          failed.promise,
        ]),
        this.shutdownTimeoutMs,
        "dsh session/prompt timed out",
      );
      if (!nonEmpty(promptResult?.messageId)) {
        throw new Error("dsh session/prompt returned no messageId");
      }
      messageId = promptResult.messageId;
      processNotifications();

      await withTimeout(
        Promise.race([idle.promise, failed.promise]),
        this.timeoutMs,
        `dsh turn timed out after ${this.timeoutMs}ms waiting for root idle`,
      );
      emit({
        type: "dsh.turn.completed",
        session_id: dshSessionId,
        usage: { ...usage, model, source: "dsh" },
      });

      await withTimeout(
        Promise.race([request("shutdown"), failed.promise]),
        this.shutdownTimeoutMs,
        "dsh shutdown timed out",
      );
      protocolDone = true;
      child.stdin?.end?.();
      await withTimeout(closed.promise, this.shutdownTimeoutMs, "dsh runtime did not exit after shutdown");
      return result(dshSessionId, exitCode);
    } catch (error) {
      this.logger.error(`[Chorus] dsh wake failed: ${errorText(error)}`);
      protocolDone = true;
      await stopRuntime();
      return result(dshSessionId, typeof exitCode === "number" && exitCode !== 0 ? exitCode : null);
    }
  }
}
