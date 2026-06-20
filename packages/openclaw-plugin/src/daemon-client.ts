// packages/openclaw-plugin/src/daemon-client.ts
// The OpenClaw in-process host's bidirectional daemon behavior — the in-process
// analog of the chorus CLI host (cli/waker.mjs + cli/daemon.mjs), re-mapped from a
// spawned `claude` subprocess to a single `runtime.agent.runEmbeddedAgent(...)` call.
//
// Re-mapping table (verified against ../openclaw, 2026-06-20):
//   | Concern             | CLI host                       | this client                          |
//   | run an agent        | spawn `claude` subprocess      | runEmbeddedAgent(params) in-process  |
//   | observe messages    | parse stream-json lines        | onAssistantMessageStart/onBlockReply |
//   |                     |                                | /onToolResult callbacks (params.ts)  |
//   | mid-run interrupt   | SIGINT→SIGKILL the proc group  | AbortController.abort() → abortSignal |
//   | crash vs user-abort | non-zero exit code             | promise rejects / result.meta.aborted|
//   | resume same session | `claude --resume <directIdea>` | sessionKey from business key →        |
//   |                     |                                | getSessionEntry resolves sessionId   |
// The server-facing payloads are IDENTICAL across hosts (that is why they live in the
// shared daemon-rest-client). This module owns only the host-side concerns: the
// run wrapper, the abort/execution registries, the transcript content filter, the
// session mapping, and the at-most-once turn dispatch.
//
// VERIFIED runEmbeddedAgent surface (../openclaw):
//   - abortSignal?: AbortSignal                              params.ts:167
//   - onAssistantMessageStart?: () => void|Promise<void>     params.ts:190 (ZERO-arg)
//   - onBlockReply?: (BlockReplyPayload{text?,isReasoning?}) params.ts:191 / payloads.ts:1-11
//   - onToolResult?: (ReplyPayload)                          params.ts:201 (tool internals — NOT transcript)
//   - onReasoningStream?: (...)                              params.ts:195 (thinking — NOT transcript)
//   - result.meta.aborted?: boolean                          types.ts:140 (user-abort marker)
//   - getSessionEntry({sessionKey,agentId}) → SessionEntry?  store.ts:210
//   - resolveSessionFilePath(sessionId, entry?, opts?)       paths.ts:267

import type {
  OpenClawRuntimeAgent,
  OpenClawBlockReplyPayload,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  DaemonRestClient,
  DaemonExecutionRow,
  DaemonTranscriptMessage,
  DaemonPendingTurn,
} from "./daemon-rest-client.js";

export interface DaemonClientLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

const NOOP_LOGGER: DaemonClientLogger = { info() {}, warn() {}, error() {} };

/** Resource kinds the server's DaemonExecution accepts (mirrors waker.mjs). */
const EXECUTION_ENTITY_TYPES = new Set(["task", "idea", "proposal", "document", "daemon_session"]);

/**
 * The host knobs the run needs, resolved per-wake by the entry/wake layer. These are
 * the OpenClaw runtime-derived values (workspace dir, timeout, model, …) that wake.ts
 * already knows how to resolve from `api.config`. The daemon client takes them as a
 * resolver so it never reaches into `api` directly (keeps it host-API-agnostic + testable).
 */
export interface WakeRunContext {
  /** The `runtime.agent` surface to run the turn with. */
  agent: OpenClawRuntimeAgent;
  /** The OpenClaw session key for this wake's main agent (e.g. `agent:main:main`). */
  sessionKey: string;
  /** The resolved default agent id (session/workspace resolvers are agent-scoped). */
  agentId: string;
  /** The opaque `api.config` snapshot passed through to runEmbeddedAgent. */
  config: unknown;
  /** Resolved agent workspace dir. */
  workspaceDir: string;
  /** Resolved agent dir (optional — omitted when the host has none). */
  agentDir?: string;
  /** Resolved per-agent timeout. */
  timeoutMs: number;
  /** Resolved `{ provider, model }` override, or null to use the host default. */
  modelRef: { provider: string; model: string } | null;
}

/**
 * Per-wake attribution + prompt. `entityType`/`entityUuid` identify the resource the
 * execution row keys on; `directIdeaUuid`/`rootIdeaUuid` come from the lineage resolve
 * (the two-id contract: directIdea = session anchor, rootIdea = snapshot attribution).
 * `contextKey` is the router's dedupe/log key. `turnUuid` is set for a delivered turn.
 */
export interface WakeRequest {
  prompt: string;
  contextKey: string;
  entityType?: string | null;
  entityUuid?: string | null;
  directIdeaUuid?: string | null;
  rootIdeaUuid?: string | null;
  /** When this wake runs a specific pending turn (deliver_turn / backfill). */
  turnUuid?: string | null;
}

interface ExecutionEntry {
  entityType: string;
  entityUuid: string;
  rootIdeaUuid: string | null;
  status: "running" | "queued";
  startedAt: string | null;
}

interface AbortEntry {
  controller: AbortController;
  /** Set when an authorized interrupt fired before the run settled → reason=user. */
  interrupting: boolean;
}

export interface OpenClawDaemonClientOptions {
  /** The shared REST client (turnAdvance/transcript/executionState/reportInterrupt/readPendingTurns). */
  restClient: DaemonRestClient;
  /**
   * Resolve the host run context for a wake (workspace/timeout/model/agent/session
   * key). Returns null when the wake must be DROPPED (no resolvable session/agent on
   * this host) — mirrors wake.ts's graceful-drop. Errors thrown here are caught.
   */
  resolveRunContext: () => WakeRunContext | null;
  /**
   * Re-dispatch a wake for an entity (the synthetic resume / pending-turn path). Built
   * by the entry from the router so a resume / delivered turn rides the SAME wake path
   * (continuing the same session). Receives the full WakeRequest.
   */
  redispatch: (req: WakeRequest) => void;
  /**
   * Read this connection's unstarted (pending) turns and feed each to `redispatch`.
   * The client owns the seen-set dedup + the optional single-turn filter; the entry
   * just provides the prompt builder via `buildTurnPrompt`.
   */
  buildTurnPrompt: (turn: DaemonPendingTurn) => string;
  logger?: DaemonClientLogger;
}

/**
 * Extract finalized assistant VISIBLE text from an `onBlockReply` payload, or null to
 * skip. Mirrors the CLI host's stream-json filter (upload-hooks.mjs
 * `extractTranscriptText`): keep only finalized assistant text; DROP reasoning/thinking
 * (`isReasoning`) — verified the flag exists at ../openclaw/src/agents/
 * embedded-agent-payloads.ts:7 and is set true for reasoning blocks
 * (embedded-agent-subscribe.handlers.messages.ts:915). Tool internals never reach here
 * (they arrive on `onToolResult`, which the client does not post). Never throws.
 */
export function extractBlockReplyText(
  payload: OpenClawBlockReplyPayload | undefined | null,
): DaemonTranscriptMessage | null {
  if (!payload || typeof payload !== "object") return null;
  // Reasoning/thinking blocks are internal — not user-visible transcript.
  if (payload.isReasoning) return null;
  const text = typeof payload.text === "string" ? payload.text : "";
  if (!text.trim()) return null;
  return { role: "assistant", text };
}

/**
 * The OpenClaw in-process daemon client. One instance per plugin process; the entry
 * injects the shared REST client + the host run-context resolver + the re-dispatch
 * hook, and wires this client's `controlHooks` into the control handler.
 */
export class OpenClawDaemonClient {
  private readonly restClient: DaemonRestClient;
  private readonly resolveRunContext: OpenClawDaemonClientOptions["resolveRunContext"];
  private readonly redispatch: OpenClawDaemonClientOptions["redispatch"];
  private readonly buildTurnPrompt: OpenClawDaemonClientOptions["buildTurnPrompt"];
  private readonly logger: DaemonClientLogger;

  /** AbortController per in-flight run, keyed `entityType:entityUuid`. */
  private readonly aborts = new Map<string, AbortEntry>();
  /** Execution snapshot source — one entry per running/queued resource. */
  private readonly executions = new Map<string, ExecutionEntry>();
  /**
   * At-most-once turn dedup, keyed `turn:<uuid>`. Shared by the live deliver_turn
   * path and the reconnect backfill so a turn observed by either runs at most once
   * (mirrors the CLI host's `seen` set; backfill.mjs).
   */
  private readonly seenTurns = new Set<string>();

  private runCounter = 0;

  constructor(opts: OpenClawDaemonClientOptions) {
    this.restClient = opts.restClient;
    this.resolveRunContext = opts.resolveRunContext;
    this.redispatch = opts.redispatch;
    this.buildTurnPrompt = opts.buildTurnPrompt;
    this.logger = opts.logger ?? NOOP_LOGGER;
  }

  // ---------------------------------------------------------------------------
  // Control hooks — wired into the T3 control handler (ControlBehaviorHooks).
  // ---------------------------------------------------------------------------

  /**
   * The behavior hooks the control handler routes verified commands to. The handler
   * owns the double-check (own connection + held entity); these implement the actual
   * abort / re-dispatch / pending-turns-sweep.
   */
  get controlHooks(): {
    isEntityRunning: (entityType: string, entityUuid: string) => boolean;
    onInterrupt: (entityType: string, entityUuid: string) => void;
    onResume: (entityType: string, entityUuid: string) => void;
    onDeliverTurn: (turnUuid?: string) => void;
  } {
    return {
      isEntityRunning: (entityType, entityUuid) => this.aborts.has(execKey(entityType, entityUuid)),
      onInterrupt: (entityType, entityUuid) => this.interrupt(entityType, entityUuid),
      onResume: (entityType, entityUuid) => this.resume(entityType, entityUuid),
      onDeliverTurn: (turnUuid) => {
        // Fire-and-forget: the control handler is synchronous; the sweep is async.
        void this.deliverTurn(turnUuid);
      },
    };
  }

  /**
   * Abort the matching in-flight run (true mid-run stop via abortSignal) and mark it
   * `interrupting` so the run's settle path reports reason=user (not crash). No-op when
   * no run is registered (the handler's Check 2 already gates this, but we re-check so a
   * direct caller is safe). Never throws.
   */
  interrupt(entityType: string, entityUuid: string): void {
    const key = execKey(entityType, entityUuid);
    const entry = this.aborts.get(key);
    if (!entry) {
      this.logger.info(`[Chorus] interrupt: no in-flight run for ${key}; ignoring`);
      return;
    }
    entry.interrupting = true;
    try {
      entry.controller.abort();
      this.logger.info(`[Chorus] interrupt: aborted in-flight run for ${key}`);
    } catch (err) {
      this.logger.warn(`[Chorus] interrupt: abort() failed for ${key}: ${err}`);
    }
  }

  /**
   * Re-dispatch a wake for the entity to continue the SAME session (the run is gone;
   * resolveRunContext re-derives the same sessionKey → getSessionEntry resolves the
   * existing sessionId). The control handler has no prompt; we synthesize a minimal
   * resume prompt. Continues under the same business key (directIdea/entity).
   */
  resume(entityType: string, entityUuid: string): void {
    this.logger.info(`[Chorus] resume: re-dispatching wake for ${entityType}:${entityUuid}`);
    this.redispatch({
      prompt:
        `[Chorus] Your previous run for this ${entityType} was interrupted by a human and is now being resumed. ` +
        `Continue where you left off (entityType: ${entityType}, entityUuid: ${entityUuid}).`,
      contextKey: `chorus:resume:${entityUuid}`,
      entityType,
      entityUuid,
    });
  }

  /**
   * Read connection-scoped pending turns and run the unstarted human_instruction turn.
   * With a `turnUuid` run PRECISELY that one (live deliver_turn); without one sweep all
   * (reconnect backfill). Idempotent via the shared `seenTurns` set keyed `turn:<uuid>`.
   * Never throws into the caller. Mirrors backfill.mjs `backfillPendingTurns`.
   */
  async deliverTurn(onlyTurnUuid?: string): Promise<void> {
    const result = await this.restClient.readPendingTurns();
    if (!result.ok || !result.data) {
      // Nothing to read yet (skipped) or a logged failure — nothing to dispatch.
      return;
    }
    let dispatched = 0;
    for (const turn of result.data.turns) {
      if (!turn || typeof turn.turnUuid !== "string") continue;
      // Single-turn precision: when a uuid was announced, run ONLY it.
      if (onlyTurnUuid && turn.turnUuid !== onlyTurnUuid) continue;
      const seenKey = `turn:${turn.turnUuid}`;
      if (this.seenTurns.has(seenKey)) continue;
      this.seenTurns.add(seenKey);
      dispatched++;
      // Reconstruct the execution entity DIRECTLY from the turn's own ids (mirrors
      // cli/event-router.mjs dispatchPendingTurn): an idea-anchored conversation
      // reports against the real idea (`idea:<directIdeaUuid>`), an ad-hoc conversation
      // against itself (`daemon_session:<sessionId>`). entityType MUST be set — without
      // it entityOf() returns null, so the run reports no execution row (invisible in
      // the UI) and registers no AbortController (uninterruptible). entityUuid aligns
      // with the session business key so the report anchor, the OpenClaw session, and
      // the per-session UI match key are all the same value.
      const directIdeaUuid =
        typeof turn.directIdeaUuid === "string" ? turn.directIdeaUuid : null;
      this.redispatch({
        prompt: this.buildTurnPrompt(turn),
        contextKey: `chorus:deliver_turn:${turn.turnUuid}`,
        entityType: directIdeaUuid ? "idea" : "daemon_session",
        entityUuid: directIdeaUuid ?? turn.sessionId,
        directIdeaUuid,
        turnUuid: turn.turnUuid,
      });
    }
    if (dispatched > 0) {
      const scope = onlyTurnUuid ? `turn ${onlyTurnUuid}` : `${dispatched} pending turn(s)`;
      this.logger.info(`[Chorus] deliver: re-derived ${scope} from the turn table`);
    }
  }

  /** Reconnect backfill: full connection-scoped pending-turns sweep (no single-turn filter). */
  async onReconnect(): Promise<void> {
    await this.deliverTurn();
  }

  // ---------------------------------------------------------------------------
  // The wake run wrapper.
  // ---------------------------------------------------------------------------

  /**
   * Run one wake via runEmbeddedAgent with full daemon reporting. Never throws — a
   * wake failure is logged + reported (crash), never propagated (the SSE service must
   * stay alive). Fire-and-forget from the caller's perspective; returns a promise the
   * tests can await.
   *
   * Lifecycle (mirrors waker.mjs):
   *   1. resolve run context (drop on null);
   *   2. derive sessionKey from the business key → getSessionEntry → sessionId/sessionFile;
   *   3. register the AbortController + mark the execution running → turnAdvance(running)
   *      + execution-state snapshot;
   *   4. run with transcript callbacks (onBlockReply → post {role:"assistant", text});
   *   5. on settle → turnAdvance(ended) + snapshot; classify interrupt(user) vs crash;
   *   6. finally → deregister the controller + drop the execution row + snapshot.
   */
  async runWake(req: WakeRequest): Promise<void> {
    const { prompt, contextKey } = req;
    const entity = entityOf(req);
    const key = entity ? execKey(entity.entityType, entity.entityUuid) : null;
    const rootIdeaUuid = req.rootIdeaUuid ?? null;
    // Session anchor = the business key: directIdeaUuid when present, else the entity
    // uuid (quick task / standalone doc / ad-hoc daemon_session). This is the `sessionId`
    // used in ALL reports (turn-advance/transcript) — NOT the OpenClaw sessionKey, which
    // is the agent's queue key. Two distinct identifiers (see deriveSessionId / sessionKey).
    const reportSessionId = deriveSessionId(req);
    if (!reportSessionId) {
      this.logger.warn(
        `[Chorus] Wake DROPPED — no session id (no directIdea/entity) for contextKey=${contextKey}`,
      );
      return;
    }

    let ctx: WakeRunContext | null;
    try {
      ctx = this.resolveRunContext();
    } catch (err) {
      this.logger.warn(`[Chorus] Wake DROPPED — run-context resolution failed (${contextKey}): ${err}`);
      return;
    }
    if (!ctx) {
      this.logger.warn(
        `[Chorus] Wake DROPPED — no resolvable session/agent runtime on this host (${contextKey}).`,
      );
      return;
    }

    // Resolve the EXISTING session for the business key so the wake continues the same
    // conversation (resume / deliver_turn re-enter it). The OpenClaw sessionKey is
    // derived deterministically from the business key, so a later resume re-derives the
    // same key and getSessionEntry returns the same sessionId/sessionFile.
    const sessionKey = deriveSessionKey(reportSessionId, ctx.sessionKey);
    let sessionId: string;
    let sessionFile: string;
    try {
      const sessionEntry = ctx.agent.session.getSessionEntry({ sessionKey, agentId: ctx.agentId });
      // No existing OpenClaw session for this key (the FIRST wake on the business key):
      // open a NEW session whose id is the business key itself. The business key
      // (directIdeaUuid / entityUuid / ad-hoc sessionId) is always a uuid, which
      // satisfies OpenClaw's SAFE_SESSION_ID_RE (`^[a-z0-9][a-z0-9._-]{0,127}$`).
      // The run id (`nextRunId`) is NOT a valid session id — it embeds the colon-laden
      // contextKey, which `resolveSessionFilePath` rejects with "Invalid session ID" —
      // so it must never be used as the session id. Reusing the business key here also
      // keeps continuity: a later resume re-derives the SAME sessionKey, and once this
      // first run has persisted the session, getSessionEntry returns this same id.
      sessionId = sessionEntry?.sessionId ?? reportSessionId;
      sessionFile = ctx.agent.session.resolveSessionFilePath(
        sessionId,
        sessionEntry?.sessionFile ? { sessionFile: sessionEntry.sessionFile } : undefined,
        { agentId: ctx.agentId },
      );
    } catch (err) {
      this.logger.warn(`[Chorus] Wake DROPPED — session resolution failed (${contextKey}): ${err}`);
      return;
    }

    const controller = new AbortController();
    const abortEntry: AbortEntry = { controller, interrupting: false };
    if (key) this.aborts.set(key, abortEntry);

    // Mark RUNNING + report turn-advance(running) + execution snapshot.
    if (entity && key) {
      this.executions.set(key, {
        entityType: entity.entityType,
        entityUuid: entity.entityUuid,
        rootIdeaUuid,
        status: "running",
        startedAt: new Date().toISOString(),
      });
      this.emitExecutionSnapshot();
    }
    let advancedToRunning = false;
    await this.advanceTurn(reportSessionId, "running", entity);
    advancedToRunning = true;

    const runId = this.nextRunId(contextKey);
    this.logger.info(
      `[Chorus] Waking agent via embedded run (sessionKey=${sessionKey}, sessionId=${reportSessionId}, ` +
        `model=${ctx.modelRef ? `${ctx.modelRef.provider}/${ctx.modelRef.model}` : "host-default"}, contextKey=${contextKey})`,
    );

    let aborted = false;
    let crashed = false;
    try {
      const result = await ctx.agent.runEmbeddedAgent({
        sessionId,
        sessionKey,
        agentId: ctx.agentId,
        trigger: "manual",
        sessionFile,
        ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
        workspaceDir: ctx.workspaceDir,
        config: ctx.config,
        prompt,
        timeoutMs: ctx.timeoutMs,
        runId,
        disableMessageTool: true,
        abortSignal: controller.signal,
        // Streaming transcript: post ONLY finalized assistant visible text. Reasoning
        // (onReasoningStream / isReasoning blocks) and tool internals (onToolResult) are
        // intentionally NOT posted (match the CLI host's stream-json filter).
        onBlockReply: (payload) => {
          const msg = extractBlockReplyText(payload);
          if (msg) void this.postTranscript(reportSessionId, [msg]);
        },
        ...(ctx.modelRef ? { provider: ctx.modelRef.provider, model: ctx.modelRef.model } : {}),
      });
      // result.meta.aborted distinguishes a clean abort from a normal completion
      // (types.ts:140). An abort flagged here OR an interrupt requested → user-abort.
      aborted = result?.meta?.aborted === true || abortEntry.interrupting;
    } catch (err) {
      // The run rejected. If an interrupt was requested, it's a user abort; otherwise
      // it's an unexpected crash.
      if (abortEntry.interrupting || controller.signal.aborted) {
        aborted = true;
      } else {
        crashed = true;
      }
      this.logger.warn(
        `[Chorus] Wake turn ${crashed ? "crashed" : "aborted"} (sessionId=${reportSessionId}, ${contextKey}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // Deregister FIRST so a stale controller can never abort a later run for the
      // same entity (spec: "A settled run deregisters its controller").
      if (key) this.aborts.delete(key);
    }

    // Turn lifecycle: advance running→ended regardless of outcome (a turn ends whether
    // clean, aborted, or crashed). Guarded on advancedToRunning so a never-started wake
    // never attempts an illegal pending→ended transition.
    if (advancedToRunning) {
      await this.advanceTurn(reportSessionId, "ended", entity);
    }

    // Interrupt-vs-crash reporting (entity-keyed — only for a reportable resource).
    if (entity) {
      if (aborted) {
        await this.report(entity, "user");
      } else if (crashed) {
        await this.report(entity, "crash");
      }
      // A clean completion reports nothing (mirrors waker.mjs).
    }

    // Drop the execution row + emit a fresh snapshot (absence == ended server-side).
    if (key && this.executions.delete(key)) {
      this.emitExecutionSnapshot();
    }

    this.logger.info(
      `[Chorus] Wake complete (sessionId=${reportSessionId}, contextKey=${contextKey}, ` +
        `outcome=${aborted ? "interrupted" : crashed ? "crashed" : "completed"})`,
    );
  }

  /**
   * Mark a resource QUEUED and emit a snapshot. Called before a wake actually runs
   * (e.g. when it sits behind a same-session run) so the server sees it waiting. The
   * running transition in `runWake` overwrites it. Never throws.
   */
  markQueued(req: WakeRequest): void {
    const entity = entityOf(req);
    if (!entity) return;
    const key = execKey(entity.entityType, entity.entityUuid);
    const existing = this.executions.get(key);
    // Don't downgrade a running resource to queued if a duplicate dispatch arrives.
    if (existing && existing.status === "running") return;
    this.executions.set(key, {
      entityType: entity.entityType,
      entityUuid: entity.entityUuid,
      rootIdeaUuid: req.rootIdeaUuid ?? null,
      status: "queued",
      startedAt: existing?.startedAt ?? null,
    });
    this.emitExecutionSnapshot();
  }

  // ---------------------------------------------------------------------------
  // Internal reporting helpers — never throw into the wake path.
  // ---------------------------------------------------------------------------

  private buildExecutionSnapshot(): DaemonExecutionRow[] {
    return [...this.executions.values()].map((e) => ({
      entityType: e.entityType,
      entityUuid: e.entityUuid,
      rootIdeaUuid: e.rootIdeaUuid,
      status: e.status,
      startedAt: e.startedAt,
    }));
  }

  /** Fire-and-forget execution-state snapshot. Never throws. */
  private emitExecutionSnapshot(): void {
    void this.restClient.executionState({ executions: this.buildExecutionSnapshot() });
  }

  private async advanceTurn(
    sessionId: string,
    status: "running" | "ended",
    entity: { entityType: string; entityUuid: string } | null,
  ): Promise<void> {
    try {
      await this.restClient.turnAdvance({
        sessionId,
        status,
        entityType: entity?.entityType ?? null,
        entityUuid: entity?.entityUuid ?? null,
      });
    } catch (err) {
      this.logger.warn(`[Chorus] advanceTurn failed for session ${sessionId} → ${status}: ${err}`);
    }
  }

  private async postTranscript(sessionId: string, messages: DaemonTranscriptMessage[]): Promise<void> {
    try {
      await this.restClient.transcript({ sessionId, messages });
    } catch (err) {
      this.logger.warn(`[Chorus] transcript post failed for session ${sessionId}: ${err}`);
    }
  }

  private async report(
    entity: { entityType: string; entityUuid: string },
    reason: "user" | "crash",
  ): Promise<void> {
    try {
      await this.restClient.reportInterrupt({
        entityType: entity.entityType,
        entityUuid: entity.entityUuid,
        reason,
      });
    } catch (err) {
      this.logger.warn(
        `[Chorus] reportInterrupt failed for ${entity.entityType}:${entity.entityUuid} (${reason}): ${err}`,
      );
    }
  }

  private nextRunId(contextKey: string): string {
    this.runCounter += 1;
    return `chorus-wake-${this.runCounter}-${contextKey}`;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing).
// ---------------------------------------------------------------------------

/** Registry key for an entity. */
export function execKey(entityType: string, entityUuid: string): string {
  return `${entityType}:${entityUuid}`;
}

/**
 * The reportable resource for a wake — `{ entityType, entityUuid }` — or null when it
 * has no recognized target (mirrors waker.mjs `#entityOf`).
 */
export function entityOf(req: {
  entityType?: string | null;
  entityUuid?: string | null;
}): { entityType: string; entityUuid: string } | null {
  const { entityType, entityUuid } = req;
  if (
    typeof entityType === "string" &&
    typeof entityUuid === "string" &&
    entityUuid.length > 0 &&
    EXECUTION_ENTITY_TYPES.has(entityType)
  ) {
    return { entityType, entityUuid };
  }
  return null;
}

/**
 * The session BUSINESS KEY used in all reports (turn-advance/transcript): the
 * directIdeaUuid when the entity has an idea ancestor, else the entity uuid. Mirrors
 * the CLI host's `sessionId = directIdeaUuid ?? notification.entityUuid` (waker.mjs:286).
 */
export function deriveSessionId(req: {
  directIdeaUuid?: string | null;
  entityUuid?: string | null;
}): string | null {
  return req.directIdeaUuid ?? req.entityUuid ?? null;
}

/**
 * Derive the deterministic OpenClaw `sessionKey` for a wake from its business key. The
 * OpenClaw session store is keyed by `sessionKey` (the agent queue key), NOT by the
 * Chorus business id — so to make `resume`/`deliver_turn` continue the SAME OpenClaw
 * session we must derive the SAME key from the SAME business id every time. We namespace
 * the business id under the host's main-agent key so a Chorus wake gets its own stable
 * lane that re-resolves identically across runs (the in-process analog of
 * `claude --resume <directIdeaUuid>`, where the disk transcript is the stable anchor).
 */
export function deriveSessionKey(businessKey: string, mainSessionKey: string): string {
  return `${mainSessionKey}:chorus:${businessKey}`;
}
