// cli/cli-session-sync.mjs
// `chorus agents run` session sync core (OpenSpec change cli-agent-session-sync, D2/D3/D6).
//
// Runs IN-PROCESS beside the foreground agent child:
//   register (before spawn) → adapter.prepareArgs (resume identity) → spawn →
//   heartbeat the CLI lease + pump the transcript → on child exit / signal: flush
//   (bounded, ≤ 5 s) → release { continuable } → the launcher forwards the exit code.
// Everything backend-specific is behind the adapter contract
// (cli/cli-session-sync/contract.mjs, registry in cli/cli-session-sync/index.mjs).
//
// FAILURE POSTURE: sync must never hurt the interactive agent. Every error is caught and
// written to ~/.chorus/logs/cli-session-sync.log; the agent's TTY sees at most ONE
// warning line before launch (registration failure / server too old / no daemon / own
// session flag) and at most ONE after exit (transcript upload incomplete). Nothing is
// written while the child owns the terminal.
//
// SECRET RULE: the `cho_` API key is only ever placed in the Authorization header. Log
// lines are redacted (the configured key and any `cho_…` token) and never include the
// server URL (which could carry userinfo).
//
// Server contract (src/app/api/daemon-sessions/cli/**, src/app/api/daemon/transcript):
//   POST /api/daemon-sessions/cli                      {agentType,host,cwd,ideaUuid?,backendSessionId?,title?,continuable?}
//   POST /api/daemon-sessions/cli/:uuid/heartbeat      {leaseHolder, backendSessionId?}   409 stale holder
//   POST /api/daemon-sessions/cli/:uuid/release        {leaseHolder, continuable, reason?} 409 already released
//   POST /api/daemon/transcript                        {turnUuid, messages:[{role,text}]}
// A 404 on registration means the server predates this feature → warn + launch unsynced.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { getSessionSyncAdapter } from "./cli-session-sync/index.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

export const SYNC_LOG_FILE = "cli-session-sync.log";
export const DEFAULT_FLUSH_BUDGET_MS = 5_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const TRANSCRIPT_BATCH = 100;

/** The single pre-launch warning when no daemon serves the launch cwd (design D5). */
export const NO_DAEMON_WARNING =
  "warning: no daemon running here; session can be continued once a daemon runs in this directory\n";

/** @param {string} [home] */
export function syncLogPath(home = homedir()) {
  return join(home, ".chorus", "logs", SYNC_LOG_FILE);
}

/**
 * Strip secrets from a log line: the configured key verbatim plus any `cho_` token.
 * @param {unknown} text @param {string} [apiKey]
 */
export function redactSecrets(text, apiKey) {
  let s = String(text);
  if (apiKey) s = s.split(apiKey).join("cho_***");
  return s.replace(/cho_[A-Za-z0-9_\-]+/g, "cho_***");
}

/**
 * File-only logger under ~/.chorus/logs. Never throws, never writes to stdout/stderr.
 * @param {{ home?: string, apiKey?: string, appendFile?: (p: string, s: string) => void,
 *   mkdir?: (p: string) => void, now?: () => Date }} [opts]
 */
export function createSyncLogger(opts = {}) {
  const path = syncLogPath(opts.home);
  const append = opts.appendFile ?? ((p, s) => appendFileSync(p, s, "utf8"));
  const mkdir = opts.mkdir ?? ((p) => mkdirSync(p, { recursive: true }));
  const now = opts.now ?? (() => new Date());
  let dirReady = false;
  const write = (level, msg) => {
    try {
      if (!dirReady) {
        mkdir(join(path, ".."));
        dirReady = true;
      }
      append(path, `${now().toISOString()} [${level}] pid=${process.pid} ${redactSecrets(msg, opts.apiKey)}\n`);
    } catch {
      /* logging must never break the launch */
    }
  };
  return { path, info: (m) => write("info", m), warn: (m) => write("warn", m), error: (m) => write("error", m) };
}

/** A safe, secret-free description of a fetch failure (no URL, no key). */
function describeFetchError(err) {
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return "request timed out";
  const code = err?.cause?.code ?? err?.code;
  return code ? `network error (${code})` : `network error (${err?.name ?? "Error"})`;
}

/**
 * Minimal REST client for the CLI session routes. Every method RESOLVES (never rejects)
 * with `{ ok, status, data?, error? }`.
 * @param {{ url: string, apiKey: string, fetchImpl?: typeof fetch, timeoutMs?: number,
 *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void } }} opts
 */
export function createCliSessionClient(opts) {
  const base = String(opts.url).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const defaultTimeout = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const logger = opts.logger ?? NOOP_LOGGER;

  async function post(path, body, label, timeoutMs = defaultTimeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    timer.unref?.();
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      if (!res.ok || !json || json.success !== true) {
        const message = json?.error?.message ?? json?.error ?? null;
        const error = `HTTP ${res.status}${typeof message === "string" && message ? `: ${message}` : ""}`;
        logger.warn(`[sync] ${label} failed: ${error}`);
        return { ok: false, status: res.status, error };
      }
      return { ok: true, status: res.status, data: json.data };
    } catch (err) {
      const error = describeFetchError(err);
      logger.warn(`[sync] ${label} failed: ${error}`);
      return { ok: false, status: null, error };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    register: (body, t) => post("/api/daemon-sessions/cli", body, "register", t),
    heartbeat: (sessionUuid, body, t) =>
      post(`/api/daemon-sessions/cli/${encodeURIComponent(sessionUuid)}/heartbeat`, body, "heartbeat", t),
    release: (sessionUuid, body, t) =>
      post(`/api/daemon-sessions/cli/${encodeURIComponent(sessionUuid)}/release`, body, "release", t),
    transcript: (body, t) => post("/api/daemon/transcript", body, "transcript upload", t),
  };
}

/** Pre-launch warning text for a failed registration result. */
function registrationWarning(res) {
  let reason;
  if (res.status === 404) reason = "the Chorus server is too old for terminal session sync";
  else if (res.status === 400) reason = "--idea does not reference an Idea this agent can access";
  else if (res.status === 401 || res.status === 403) reason = "the agent's API key was rejected";
  else if (res.status === null) reason = "could not reach Chorus";
  else reason = `Chorus returned HTTP ${res.status}`;
  return `warning: Chorus session sync unavailable (${reason}); launching unsynced\n`;
}

/** Resolve after `ms` (unref'd so it never holds the process open). */
function delay(ms, timers) {
  return new Promise((resolve) => {
    const t = timers.setTimeout(resolve, Math.max(0, ms));
    t?.unref?.();
  });
}

/**
 * One `chorus agents run` session-sync run. Construct, `await register(args)` BEFORE
 * spawning (use the returned args), call `started()` right after a successful spawn, and
 * `await finish()` once the child exits (or a terminating signal arrives).
 */
export class CliSessionSync {
  /**
   * @param {{
   *   agent: { url?: string, apiKey?: string, agentUuid?: string, label?: string },
   *   agentType: string, cwd: string, childEnv: NodeJS.ProcessEnv, platform?: NodeJS.Platform,
   *   ideaUuid?: string|null, host?: string, stderr?: { write: (s: string) => void },
   *   fetchImpl?: typeof fetch, logger?: ReturnType<typeof createSyncLogger>, home?: string,
   *   adapter?: Required<import("./cli-session-sync/contract.mjs").SessionSyncAdapter>,
   *   flushBudgetMs?: number, requestTimeoutMs?: number, pollIntervalMs?: number,
   *   heartbeatIntervalMs?: number, now?: () => number,
   *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout,
   *              setInterval: typeof setInterval, clearInterval: typeof clearInterval },
   * }} opts
   */
  constructor(opts) {
    this.agent = opts.agent;
    this.agentType = opts.agentType;
    this.cwd = opts.cwd;
    this.childEnv = opts.childEnv;
    this.platform = opts.platform ?? process.platform;
    this.ideaUuid = opts.ideaUuid ?? null;
    this.host = opts.host ?? hostname();
    this.stderr = opts.stderr ?? process.stderr;
    this.logger = opts.logger ?? createSyncLogger({ home: opts.home, apiKey: opts.agent?.apiKey });
    this.adapter = opts.adapter ?? getSessionSyncAdapter(opts.agentType);
    this.flushBudgetMs = opts.flushBudgetMs ?? DEFAULT_FLUSH_BUDGET_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.heartbeatIntervalOverrideMs = opts.heartbeatIntervalMs ?? null;
    this.now = opts.now ?? (() => Date.now());
    this.timers = opts.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
    this.client = this.agent?.url && this.agent?.apiKey
      ? createCliSessionClient({ url: this.agent.url, apiKey: this.agent.apiKey, fetchImpl: opts.fetchImpl, timeoutMs: this.requestTimeoutMs, logger: this.logger })
      : null;

    /** true once registered; all later calls are no-ops otherwise. */
    this.active = false;
    this.session = null;
    this.ctx = null;
    this.continuable = false;
    this.leaseLost = false;
    this.backendIdReported = false;
    this.source = null;
    this.sourceFailed = false;
    /** @type {Array<{role:string,text:string}>} */
    this.pending = [];
    this.uploadFailed = false;
    this.signal = null;
    this.heartbeatTimer = null;
    this.pollTimer = null;
    this.tickPromise = null;
    this.finishPromise = null;
  }

  #warn(line) {
    try {
      this.stderr.write(line);
    } catch {
      /* ignore */
    }
  }

  /**
   * Register the CLI session and plan the child argv. Never throws; on any failure the
   * original args are returned and sync stays inactive.
   * @param {string[]} args      Planned argv (configured + user args).
   * @param {string[]} [userArgs] The user's verbatim passthrough (subcommand detection).
   * @returns {Promise<{ args: string[], active: boolean }>}
   */
  async register(args, userArgs = []) {
    try {
      return await this.#register(args, userArgs);
    } catch (err) {
      this.logger.error(`[sync] unexpected registration error: ${err?.stack ?? err}`);
      this.active = false;
      return { args, active: false };
    }
  }

  async #register(args, userArgs) {
    if (!this.client) {
      this.logger.warn(`[sync] agent ${this.agent?.label ?? "?"} has no Chorus URL/API key; not syncing`);
      this.#warn("warning: Chorus session sync unavailable (agent has no Chorus URL/API key); launching unsynced\n");
      return { args, active: false };
    }
    let inspection;
    try {
      inspection = this.adapter.inspectArgs({ args, userArgs });
    } catch (err) {
      this.logger.warn(`[sync] ${this.adapter.id} inspectArgs threw: ${err?.message ?? err}`);
      inspection = { sync: true, inject: false, continuable: false, reason: "inspect_failed" };
    }
    if (!inspection.sync) {
      this.logger.info(`[sync] ${this.adapter.id}: not a conversation launch (${inspection.reason}); not syncing`);
      return { args, active: false };
    }

    const body = { agentType: this.agentType, host: this.host, cwd: this.cwd, continuable: inspection.continuable !== false };
    if (this.ideaUuid) body.ideaUuid = this.ideaUuid;
    const res = await this.client.register(body);
    if (!res.ok) {
      this.#warn(registrationWarning(res));
      return { args, active: false };
    }
    const d = res.data ?? {};
    if (typeof d.sessionUuid !== "string" || typeof d.sessionId !== "string" || typeof d.turnUuid !== "string" || typeof d.leaseHolder !== "string") {
      this.logger.error("[sync] registration response is missing sessionUuid/sessionId/turnUuid/leaseHolder");
      this.#warn("warning: Chorus session sync unavailable (unexpected server response); launching unsynced\n");
      return { args, active: false };
    }
    this.session = d;
    this.active = true;
    this.ctx = {
      sessionId: d.sessionId,
      sessionUuid: d.sessionUuid,
      agentUuid: this.agent.agentUuid,
      cwd: this.cwd,
      env: this.childEnv,
      platform: this.platform,
      launchedAt: this.now(),
      backendSessionId: null,
      inspection,
      logger: this.logger,
    };
    this.logger.info(`[sync] registered session ${d.sessionUuid} (agent ${this.agent.agentUuid ?? "?"}, ${this.adapter.id}, originBound=${d.originBound === true})`);

    let planned = { args, backendSessionId: null, continuable: false };
    try {
      planned = this.adapter.prepareArgs(args, this.ctx) ?? planned;
    } catch (err) {
      this.logger.warn(`[sync] ${this.adapter.id} prepareArgs threw: ${err?.message ?? err}; launching without injection`);
      planned = { args, backendSessionId: null, continuable: false };
    }
    this.ctx.backendSessionId = planned.backendSessionId ?? null;
    this.continuable = inspection.continuable !== false && planned.continuable !== false && d.continuable !== false;

    if (!this.continuable && inspection.reason === "user_session_flag") {
      this.#warn("warning: you passed your own session/resume flag; this session syncs to Chorus but cannot be continued from it\n");
    } else if (d.originBound !== true) {
      this.#warn(NO_DAEMON_WARNING);
    }
    this.ctx.launchedAt = this.now();
    return { args: Array.isArray(planned.args) ? planned.args : args, active: true };
  }

  /** Call right after a successful spawn: starts heartbeats and the transcript pump. */
  started() {
    if (!this.active) return;
    try {
      this.#openSource();
      const hbMs = this.heartbeatIntervalOverrideMs
        ?? (Number(this.session.heartbeatIntervalSec) > 0 ? Number(this.session.heartbeatIntervalSec) * 1000 : DEFAULT_HEARTBEAT_INTERVAL_MS);
      this.heartbeatTimer = this.timers.setInterval(() => { void this.#heartbeat(); }, hbMs);
      this.heartbeatTimer?.unref?.();
      this.pollTimer = this.timers.setInterval(() => { void this.#tick(false); }, this.pollIntervalMs);
      this.pollTimer?.unref?.();
      // Report the backend id promptly (informational; copy/takeover in the UI).
      void this.#heartbeat();
    } catch (err) {
      this.logger.error(`[sync] could not start sync loops: ${err?.stack ?? err}`);
    }
  }

  /** Record a terminating signal (logged, passed as the release reason). */
  noteSignal(signal) {
    this.signal = this.signal ?? signal;
    this.logger.info(`[sync] received ${signal}`);
  }

  #openSource() {
    if (this.source || this.sourceFailed || !this.ctx) return;
    if (!this.ctx.backendSessionId && !this.ctx.inspection?.userSessionId) return;
    try {
      this.source = this.adapter.transcriptSource(this.ctx) ?? null;
    } catch (err) {
      this.sourceFailed = true;
      this.logger.warn(`[sync] ${this.adapter.id} transcriptSource threw: ${err?.message ?? err}`);
    }
  }

  async #ensureIdentity() {
    if (this.ctx.backendSessionId) return;
    try {
      const id = await this.adapter.discoverSessionId(this.ctx);
      if (typeof id === "string" && id) {
        this.ctx.backendSessionId = id;
        this.backendIdReported = false;
        this.logger.info(`[sync] discovered backend session id`);
        this.#openSource();
        void this.#heartbeat();
      }
    } catch (err) {
      this.logger.warn(`[sync] ${this.adapter.id} discoverSessionId threw: ${err?.message ?? err}`);
    }
  }

  async #heartbeat() {
    if (!this.active || this.leaseLost || this.finishPromise) return;
    const body = { leaseHolder: this.session.leaseHolder };
    if (this.ctx.backendSessionId && !this.backendIdReported) body.backendSessionId = this.ctx.backendSessionId;
    const res = await this.client.heartbeat(this.session.sessionUuid, body);
    if (res.ok) {
      if (body.backendSessionId) this.backendIdReported = true;
      return;
    }
    if (res.status === 409 || res.status === 404) {
      this.leaseLost = true;
      this.logger.error(`[sync] CLI lease lost (${res.error}); heartbeats stopped`);
      if (this.heartbeatTimer) this.timers.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** One serialized pump step: discover identity, read transcript, upload pending. */
  #tick(final) {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = (async () => {
      try {
        await this.#ensureIdentity();
        if (this.source && (this.source.mode === "live" || final)) {
          try {
            const msgs = await this.source.next();
            if (Array.isArray(msgs) && msgs.length) this.pending.push(...msgs);
          } catch (err) {
            this.logger.warn(`[sync] transcript read failed: ${err?.message ?? err}`);
          }
        }
        await this.#upload();
      } catch (err) {
        this.logger.error(`[sync] pump error: ${err?.stack ?? err}`);
      } finally {
        this.tickPromise = null;
      }
    })();
    return this.tickPromise;
  }

  async #upload() {
    while (this.pending.length && !this.uploadFailed) {
      const batch = this.pending.slice(0, TRANSCRIPT_BATCH);
      const res = await this.client.transcript({ turnUuid: this.session.turnUuid, messages: batch });
      if (res.ok) {
        this.pending.splice(0, batch.length);
        continue;
      }
      // A 4xx verdict (other than 429) cannot succeed on retry: stop uploading.
      if (res.status !== null && res.status >= 400 && res.status < 500 && res.status !== 429) {
        this.uploadFailed = true;
        this.logger.error(`[sync] transcript upload rejected (${res.error}); ${this.pending.length} message(s) not synced`);
      }
      return; // transient: retry on the next tick
    }
  }

  /**
   * Flush + finalize + release the lease, all within ONE flushBudgetMs budget. Idempotent; never throws.
   * @param {{ reason?: string }} [opts]
   * @returns {Promise<{ released: boolean, continuable: boolean }>}
   */
  finish(opts = {}) {
    if (!this.finishPromise) this.finishPromise = this.#finish(opts).catch((err) => {
      this.logger.error(`[sync] unexpected finish error: ${err?.stack ?? err}`);
      return { released: false, continuable: false };
    });
    return this.finishPromise;
  }

  async #finish({ reason } = {}) {
    if (!this.active) return { released: false, continuable: false };
    if (this.heartbeatTimer) this.timers.clearInterval(this.heartbeatTimer);
    if (this.pollTimer) this.timers.clearInterval(this.pollTimer);
    this.heartbeatTimer = null;
    this.pollTimer = null;

    // ONE overall exit budget (≤ flushBudgetMs) shared by flush + finalize + release, so
    // a hanging server can delay the user's shell by at most the budget — never the
    // budget plus a full request timeout. A slice is reserved up front for finalize
    // (local disk work) and the release POST; the flush may only use what is left.
    const deadline = this.now() + this.flushBudgetMs;
    const remaining = () => Math.max(0, deadline - this.now());
    const reserveMs = Math.min(2_000, Math.floor(this.flushBudgetMs * 0.4));
    const flushDeadline = deadline - reserveMs;
    const flushRemaining = () => Math.max(0, flushDeadline - this.now());
    const flushed = (async () => {
      if (this.tickPromise) await this.tickPromise;
      await this.#tick(true);
      while (this.pending.length && !this.uploadFailed && flushRemaining() > 0) {
        await delay(Math.min(200, flushRemaining()), this.timers);
        await this.#tick(true);
      }
      return this.pending.length === 0 && !this.uploadFailed;
    })();
    const flushOk = await Promise.race([flushed, delay(flushRemaining(), this.timers).then(() => false)]);

    let verdict = { continuable: false, reason: "finalize_failed" };
    try {
      // Finalize gets up to half of what is left; the rest is the release's.
      verdict = await Promise.race([
        this.adapter.finalize(this.ctx),
        delay(Math.floor(remaining() / 2), this.timers).then(() => ({ continuable: false, reason: "finalize_timeout" })),
      ]);
    } catch (err) {
      this.logger.warn(`[sync] ${this.adapter.id} finalize threw: ${err?.message ?? err}`);
    }
    const continuable = this.continuable && verdict?.continuable === true;
    const releaseReason = reason ?? (this.signal ? `signal:${this.signal}` : "exit");
    const body = { leaseHolder: this.session.leaseHolder, continuable, reason: continuable ? releaseReason : `${releaseReason}; not continuable: ${verdict?.reason ?? this.ctx.inspection?.reason ?? "unknown"}` };
    const res = await this.client.release(this.session.sessionUuid, body, Math.max(1, Math.min(this.requestTimeoutMs, remaining())));
    if (res.ok) this.logger.info(`[sync] released session ${this.session.sessionUuid} (continuable=${continuable}, delivered=${(res.data?.deliveredTurnUuids ?? []).length})`);
    if (!flushOk) {
      this.logger.error(`[sync] transcript flush incomplete (${this.pending.length} message(s) pending)`);
      this.#warn(`warning: Chorus session sync could not upload the full transcript (details: ${this.logger.path ?? syncLogPath()})\n`);
    }
    return { released: res.ok, continuable };
  }
}
